import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CodexHookSessionState } from "./hook-state.js";
import type { AttributedPathEvidence } from "./turn-completion.js";

export interface TurnCompletionJob {
  version: 1;
  revision: number;
  /**
   * The Hook-state timestamp that produced the evidence snapshot.  `updatedAt`
   * is also used for queue mutations/retries, so it cannot by itself tell a
   * late enqueue carrying an old state snapshot from a newer one.
   */
  snapshotUpdatedAt?: string;
  operationId: string;
  turnId: string;
  activityEpoch: number;
  codexSessionId: string;
  connectionId: string;
  hubSessionId: string;
  repositoryPath: string;
  branch: string;
  baseCommit: string;
  leaseIds: string[];
  leaseAttributionComplete: boolean;
  attributedPaths: string[];
  baselineEvidence: AttributedPathEvidence[];
  attributedPathsTruncated: boolean;
  attributionComplete: boolean;
  expiresAt: string;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueTurnCompletionInput {
  operationId: string;
  turnId: string;
  activityEpoch: number;
  state: CodexHookSessionState;
}

export type TurnCompletionQueueDiagnostic = (error: Error, filePath: string) => void;

const DEFAULT_JOB_TTL_MS = 10 * 60_000;
const MAX_AUTOMATIC_LEASE_TTL_MS = 60 * 60_000;
const QUEUE_LOCK_POLL_INTERVAL_MS = 20;
const QUEUE_LOCK_TIMEOUT_MS = 500;
const INVALID_QUEUE_LOCK_GRACE_MS = 1_000;

interface QueueLockMarker {
  version: 1;
  pid: number;
  token: string;
  startedAt: string;
}

interface HeldQueueLock {
  active: boolean;
}

// Hook 与 worker 都会在 operation 锁内调用队列写方法；异步上下文让这种嵌套保持可重入。
const heldQueueLocks = new AsyncLocalStorage<Map<string, HeldQueueLock>>();

export class TurnCompletionQueueStore {
  readonly directory: string;

  constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, "turn-completion-queue");
  }

  async enqueue(input: EnqueueTurnCompletionInput, now = new Date()): Promise<TurnCompletionJob> {
    const timestamp = now.toISOString();
    const leaseExpiry = input.state.leases
      .map((lease) => Date.parse(lease.expiresAt))
      .filter(Number.isFinite)
      .reduce((latest, candidate) => Math.max(latest, candidate), 0);
    const attributedPaths = unique(input.state.attributedChangedPaths ?? []);
    const baselineEvidence = uniqueEvidence(input.state.attributedPathEvidence ?? []);
    const leaseAttributionComplete = input.state.leaseAttributionComplete !== false;
    const expiresAt = leaseAttributionComplete
      ? (leaseExpiry > 0 ? leaseExpiry : now.getTime() + DEFAULT_JOB_TTL_MS)
      : Math.max(leaseExpiry, now.getTime() + MAX_AUTOMATIC_LEASE_TTL_MS);
    const job: TurnCompletionJob = {
      version: 1,
      revision: 1,
      snapshotUpdatedAt: input.state.updatedAt,
      operationId: requiredId(input.operationId, "completion operation ID"),
      turnId: requiredText(input.turnId, "turn ID"),
      activityEpoch: nonNegativeInteger(input.activityEpoch, "activity epoch"),
      codexSessionId: requiredText(input.state.codexSessionId, "Codex session ID"),
      connectionId: requiredId(input.state.connectionId, "connection ID"),
      hubSessionId: requiredId(input.state.hubSessionId, "Agent Hub session ID"),
      repositoryPath: path.resolve(input.state.repositoryPath),
      branch: requiredText(input.state.branch, "branch"),
      baseCommit: requiredText(input.state.baseCommit, "base commit"),
      leaseIds: unique(input.state.leases.map((lease) => lease.id)),
      leaseAttributionComplete,
      attributedPaths,
      baselineEvidence,
      attributedPathsTruncated: input.state.attributedPathsTruncated === true,
      attributionComplete: input.state.pendingWrite === undefined
        && input.state.attributedPathsTruncated !== true
        && hasCompleteAttributionEvidence(attributedPaths, baselineEvidence),
      expiresAt: new Date(expiresAt).toISOString(),
      attempts: 0,
      nextAttemptAt: timestamp,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.runMutationExclusive(job.operationId, async () => {
      const current = await this.load(job.operationId);
      const persisted = current ? mergeEnqueuedJob(current, job) : job;
      await this.replaceUnlocked(persisted);
      return persisted;
    });
  }

  async load(operationId: string): Promise<TurnCompletionJob | undefined> {
    try {
      return parseTurnCompletionJob(await readFile(this.filePath(operationId), "utf8"));
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async list(onDiagnostic?: TurnCompletionQueueDiagnostic): Promise<TurnCompletionJob[]> {
    let names: string[];
    try {
      names = (await readdir(this.directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const jobs = await Promise.all(names.map(async (name) => {
      const filePath = path.join(this.directory, name);
      try {
        return parseTurnCompletionJob(await readFile(filePath, "utf8"));
      } catch (error) {
        if (isMissingFile(error)) return undefined;
        const diagnostic = new Error(
          `Skipped invalid Agent Hub turn-completion queue entry ${name}: ${errorMessage(error)}`,
          { cause: error },
        );
        try {
          onDiagnostic?.(diagnostic, filePath);
        } catch {
          // 诊断处理本身不能让一个损坏条目重新阻断其他完成任务。
        }
        return undefined;
      }
    }));
    return jobs
      .filter((job): job is TurnCompletionJob => job !== undefined)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async listForSession(
    codexSessionId: string,
    onDiagnostic?: TurnCompletionQueueDiagnostic,
  ): Promise<TurnCompletionJob[]> {
    const selected = requiredText(codexSessionId, "Codex session ID");
    return (await this.list(onDiagnostic)).filter((job) => job.codexSessionId === selected);
  }

  async listForLifecycle(
    state: Pick<CodexHookSessionState, "codexSessionId" | "connectionId" | "hubSessionId">,
    onDiagnostic?: TurnCompletionQueueDiagnostic,
  ): Promise<TurnCompletionJob[]> {
    return (await this.listForSession(state.codexSessionId, onDiagnostic))
      .filter((job) => matchesTurnCompletionJob(job, state));
  }

  async runExclusive<T>(operationId: string, task: () => Promise<T>): Promise<T | undefined> {
    const lockPath = this.lockPath(operationId);
    const inherited = heldQueueLocks.getStore()?.get(lockPath);
    if (inherited?.active) return task();

    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await restrictPermissions(this.directory, 0o700);
    const marker: QueueLockMarker = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    let acquired = false;
    try {
      await writeFile(lockPath, serializeLock(marker), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      acquired = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (!await canReclaimQueueLock(lockPath)) return undefined;
      await unlink(lockPath).catch((unlinkError: unknown) => {
        if (!isMissingFile(unlinkError)) throw unlinkError;
      });
      try {
        await writeFile(lockPath, serializeLock(marker), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        acquired = true;
      } catch (retryError) {
        if (isAlreadyExists(retryError)) return undefined;
        throw retryError;
      }
    }
    if (!acquired) return undefined;
    await restrictPermissions(lockPath, 0o600);

    const held: HeldQueueLock = { active: true };
    const context = new Map(heldQueueLocks.getStore());
    context.set(lockPath, held);
    try {
      return await heldQueueLocks.run(context, task);
    } finally {
      held.active = false;
      await releaseQueueLock(lockPath, marker);
    }
  }

  async recordRetry(
    job: TurnCompletionJob,
    error: Error | null,
    now = new Date(),
    delayMs = 15_000,
  ): Promise<TurnCompletionJob | undefined> {
    return this.runMutationExclusive(job.operationId, async () => {
      const current = await this.load(job.operationId);
      if (!current) return undefined;
      assertSameTurnCompletionOperation(current, job);
      const updated: TurnCompletionJob = {
        ...current,
        revision: current.revision + 1,
        // 处理快照可能依据服务端租约延长 TTL；只允许延长，不能覆盖并发 enqueue 的更新。
        expiresAt: laterIso(current.expiresAt, job.expiresAt),
        attempts: current.attempts + 1,
        nextAttemptAt: laterIso(
          current.nextAttemptAt,
          new Date(now.getTime() + delayMs).toISOString(),
        ),
        lastError: error ? error.message.slice(0, 4_000) : null,
        updatedAt: laterIso(current.updatedAt, now.toISOString()),
      };
      await this.replaceUnlocked(updated);
      return updated;
    });
  }

  async remove(operationId: string): Promise<void> {
    await this.runMutationExclusive(operationId, async () => {
      await this.removeUnlocked(operationId);
    });
  }

  async removeIfUnchanged(job: TurnCompletionJob): Promise<boolean> {
    return this.runMutationExclusive(job.operationId, async () => {
      const current = await this.load(job.operationId);
      if (!current) return true;
      assertSameTurnCompletionOperation(current, job);
      if (current.revision !== job.revision) return false;
      await this.removeUnlocked(job.operationId);
      return true;
    });
  }

  async removeForSession(codexSessionId: string, beforeEpoch?: number): Promise<number> {
    const jobs = (await this.listForSession(codexSessionId)).filter((job) =>
      beforeEpoch === undefined || job.activityEpoch < beforeEpoch);
    await Promise.all(jobs.map((job) => this.remove(job.operationId)));
    return jobs.length;
  }

  async removeForLifecycle(
    state: Pick<CodexHookSessionState, "codexSessionId" | "connectionId" | "hubSessionId">,
    beforeEpoch?: number,
  ): Promise<number> {
    const jobs = (await this.listForLifecycle(state)).filter((job) =>
      beforeEpoch === undefined || job.activityEpoch < beforeEpoch);
    await Promise.all(jobs.map((job) => this.remove(job.operationId)));
    return jobs.length;
  }

  async removeForConnection(connectionId: string): Promise<number> {
    return this.removeForConnections([connectionId]);
  }

  async removeForConnections(connectionIds: Iterable<string>): Promise<number> {
    const selected = new Set([...connectionIds].map((connectionId) =>
      requiredId(connectionId, "connection ID")));
    if (selected.size === 0) return 0;
    const jobs = (await this.list()).filter((job) => selected.has(job.connectionId));
    await Promise.all(jobs.map((job) => this.remove(job.operationId)));
    return jobs.length;
  }

  private async runMutationExclusive<T>(operationId: string, task: () => Promise<T>): Promise<T> {
    const selected = requiredId(operationId, "completion operation ID");
    const deadline = Date.now() + QUEUE_LOCK_TIMEOUT_MS;
    while (true) {
      const result = await this.runExclusive(selected, async () => ({ value: await task() }));
      if (result !== undefined) return result.value;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out while waiting for Agent Hub turn-completion queue lock ${selected}.`);
      }
      await delay(QUEUE_LOCK_POLL_INTERVAL_MS);
    }
  }

  private async replaceUnlocked(job: TurnCompletionJob): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.filePath(job.operationId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialize(job), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, destination);
      await restrictPermissions(destination, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async removeUnlocked(operationId: string): Promise<void> {
    await unlink(this.filePath(operationId)).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }

  private filePath(operationId: string): string {
    return path.join(this.directory, `${requiredId(operationId, "completion operation ID")}.json`);
  }

  private lockPath(operationId: string): string {
    return path.join(this.directory, `${requiredId(operationId, "completion operation ID")}.lock`);
  }
}

export function matchesTurnCompletionJob(
  job: Pick<TurnCompletionJob, "codexSessionId" | "connectionId" | "hubSessionId">,
  state: Pick<CodexHookSessionState, "codexSessionId" | "connectionId" | "hubSessionId">,
): boolean {
  return job.codexSessionId === state.codexSessionId
    && job.connectionId === state.connectionId
    && job.hubSessionId === state.hubSessionId;
}

function mergeEnqueuedJob(
  current: TurnCompletionJob,
  incoming: TurnCompletionJob,
): TurnCompletionJob {
  assertSameTurnCompletionOperation(current, incoming);
  const freshness = compareSnapshotFreshness(current, incoming);
  const incomingIsNewer = freshness > 0;
  const incomingIsAtLeastAsNew = freshness >= 0;
  const attributedPaths = unique([
    ...current.attributedPaths,
    ...incoming.attributedPaths,
  ]);
  const baselineEvidence = mergeEvidence(
    current.baselineEvidence,
    incoming.baselineEvidence,
    incomingIsNewer,
  );
  const mergedEvidenceComplete = hasCompleteAttributionEvidence(attributedPaths, baselineEvidence);
  const currentEvidenceComplete = current.attributionComplete
    && hasCompleteAttributionEvidence(current.attributedPaths, current.baselineEvidence);

  // The conservative fence may be replaced by a newer, complete Hook
  // snapshot.  A stale snapshot must never clear a known truncation marker;
  // an incomplete newer snapshot also cannot clear it.  Conversely, an old
  // conservative fence must not reintroduce truncation after a complete state
  // snapshot has already been persisted.
  const incomingHasCompleteEvidence = incoming.attributionComplete
    && mergedEvidenceComplete;
  const attributedPathsTruncated = incomingIsAtLeastAsNew
    && incomingHasCompleteEvidence
    && !incoming.attributedPathsTruncated
    ? false
    : !incomingIsNewer && currentEvidenceComplete && !current.attributedPathsTruncated
      ? current.attributedPathsTruncated
      : current.attributedPathsTruncated || incoming.attributedPathsTruncated;

  // Completion is a safety monotone: only a newer, explicitly complete
  // snapshot with complete evidence may advance false -> true.
  const attributionComplete = current.attributionComplete
    || (incomingIsAtLeastAsNew
      && incoming.attributionComplete
      && !attributedPathsTruncated
      && mergedEvidenceComplete);

  // Once local lease attribution is known complete, a late recovery snapshot
  // must not downgrade that fact.  Conversely, an incomplete current state is
  // promoted only by a newer snapshot that explicitly proves completeness.
  const leaseAttributionComplete = current.leaseAttributionComplete
    || (incomingIsNewer && incoming.leaseAttributionComplete);
  const source = incomingIsNewer ? incoming : current;
  return {
    ...current,
    repositoryPath: source.repositoryPath,
    branch: source.branch,
    baseCommit: source.baseCommit,
    snapshotUpdatedAt: laterIso(
      current.snapshotUpdatedAt ?? current.updatedAt,
      incoming.snapshotUpdatedAt ?? incoming.updatedAt,
    ),
    revision: current.revision + 1,
    expiresAt: laterIso(current.expiresAt, incoming.expiresAt),
    leaseIds: unique([...current.leaseIds, ...incoming.leaseIds]),
    leaseAttributionComplete,
    attributedPaths,
    baselineEvidence,
    attributedPathsTruncated,
    attributionComplete,
    attempts: current.attempts,
    nextAttemptAt: current.nextAttemptAt,
    lastError: current.lastError,
    createdAt: current.createdAt,
    updatedAt: laterIso(current.updatedAt, incoming.updatedAt),
  };
}

function compareSnapshotFreshness(
  current: TurnCompletionJob,
  incoming: TurnCompletionJob,
): number {
  const currentSnapshot = parseTimestamp(current.snapshotUpdatedAt);
  const incomingSnapshot = parseTimestamp(incoming.snapshotUpdatedAt);
  if (currentSnapshot !== undefined && incomingSnapshot !== undefined && incomingSnapshot !== currentSnapshot) {
    return incomingSnapshot - currentSnapshot;
  }
  return parseTimestamp(incoming.updatedAt)! - parseTimestamp(current.updatedAt)!;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mergeEvidence(
  current: AttributedPathEvidence[],
  incoming: AttributedPathEvidence[],
  incomingIsNewer: boolean,
): AttributedPathEvidence[] {
  const merged = new Map<string, AttributedPathEvidence>();
  for (const evidence of current) merged.set(pathKey(evidence.path), { ...evidence });
  for (const evidence of incoming) {
    const key = pathKey(evidence.path);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...evidence });
      continue;
    }
    merged.set(key, mergeEvidenceEntry(existing, evidence, incomingIsNewer));
  }
  return [...merged.values()];
}

function mergeEvidenceEntry(
  current: AttributedPathEvidence,
  incoming: AttributedPathEvidence,
  incomingIsNewer: boolean,
): AttributedPathEvidence {
  return {
    path: incomingIsNewer ? incoming.path : current.path,
    baseEntry: mergeEvidenceValue(current.baseEntry, incoming.baseEntry, incomingIsNewer),
    attributedEntry: mergeEvidenceValue(current.attributedEntry, incoming.attributedEntry, incomingIsNewer),
  };
}

function mergeEvidenceValue(
  current: string | null,
  incoming: string | null,
  incomingIsNewer: boolean,
): string | null {
  if (current !== null && incoming === null) return current;
  if (current === null && incoming !== null) return incoming;
  return incomingIsNewer ? incoming : current;
}

function assertSameTurnCompletionOperation(
  current: TurnCompletionJob,
  incoming: TurnCompletionJob,
): void {
  if (
    current.operationId !== incoming.operationId
    || current.turnId !== incoming.turnId
    || current.activityEpoch !== incoming.activityEpoch
    || !matchesTurnCompletionJob(current, incoming)
  ) {
    throw new Error("The Agent Hub turn-completion update belongs to a different operation.");
  }
}

export function parseTurnCompletionJob(raw: string): TurnCompletionJob {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The Agent Hub turn-completion queue entry is not valid JSON.");
  }
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("The Agent Hub turn-completion queue entry has an unsupported format.");
  }
  if (!Array.isArray(value.baselineEvidence)) {
    throw new Error("The Agent Hub turn-completion queue entry has invalid baseline evidence.");
  }
  return {
    version: 1,
    // v0.2.4 队列没有 revision；0 作为迁移基线，下一次写入会推进到 1。
    revision: value.revision === undefined
      ? 0
      : nonNegativeInteger(value.revision, "revision"),
    ...(value.snapshotUpdatedAt === undefined
      ? {}
      : { snapshotUpdatedAt: isoString(value.snapshotUpdatedAt, "snapshotUpdatedAt") }),
    operationId: requiredId(value.operationId, "completion operation ID"),
    turnId: requiredText(value.turnId, "turn ID"),
    activityEpoch: nonNegativeInteger(value.activityEpoch, "activity epoch"),
    codexSessionId: requiredText(value.codexSessionId, "Codex session ID"),
    connectionId: requiredId(value.connectionId, "connection ID"),
    hubSessionId: requiredId(value.hubSessionId, "Agent Hub session ID"),
    repositoryPath: path.resolve(requiredText(value.repositoryPath, "repository path")),
    branch: requiredText(value.branch, "branch"),
    baseCommit: requiredText(value.baseCommit, "base commit"),
    leaseIds: stringArray(value.leaseIds),
    leaseAttributionComplete: value.leaseAttributionComplete === undefined
      ? stringArray(value.leaseIds).length > 0
      : booleanValue(value.leaseAttributionComplete, "lease attribution completeness"),
    attributedPaths: stringArray(value.attributedPaths),
    baselineEvidence: value.baselineEvidence.map(parseEvidence),
    attributedPathsTruncated: value.attributedPathsTruncated === true,
    attributionComplete: value.attributionComplete === true,
    expiresAt: isoString(value.expiresAt, "expiry"),
    attempts: nonNegativeInteger(value.attempts, "attempt count"),
    nextAttemptAt: isoString(value.nextAttemptAt, "next attempt"),
    lastError: nullableText(value.lastError),
    createdAt: isoString(value.createdAt, "createdAt"),
    updatedAt: isoString(value.updatedAt, "updatedAt"),
  };
}

function parseEvidence(value: unknown): AttributedPathEvidence {
  if (!isRecord(value)) throw new Error("The Agent Hub turn-completion queue contains invalid path evidence.");
  return {
    path: requiredText(value.path, "evidence path"),
    baseEntry: nullableGitEntry(value.baseEntry),
    attributedEntry: nullableGitEntry(value.attributedEntry),
  };
}

function uniqueEvidence(values: AttributedPathEvidence[]): AttributedPathEvidence[] {
  const result = new Map<string, AttributedPathEvidence>();
  for (const value of values) result.set(pathKey(value.path), { ...value });
  return [...result.values()];
}

function hasCompleteAttributionEvidence(
  attributedPaths: string[],
  evidence: AttributedPathEvidence[],
): boolean {
  const attributedKeys = new Set(attributedPaths.map(pathKey));
  if (attributedKeys.size !== attributedPaths.length || evidence.length !== attributedKeys.size) return false;
  const evidenceByPath = new Map(evidence.map((entry) => [pathKey(entry.path), entry]));
  return [...attributedKeys].every((key) => {
    const entry = evidenceByPath.get(key);
    return entry?.baseEntry !== null && entry?.attributedEntry !== null;
  });
}

function serialize(job: TurnCompletionJob): string {
  return `${JSON.stringify(job, null, 2)}\n`;
}

function serializeLock(marker: QueueLockMarker): string {
  return `${JSON.stringify(marker)}\n`;
}

function requiredId(value: unknown, name: string): string {
  const text = requiredText(value, name);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(text)) throw new Error(`The ${name} is invalid.`);
  return text;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`The ${name} is required.`);
  return value.trim();
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableGitEntry(value: unknown): string | null {
  if (value === null) return null;
  const text = requiredText(value, "Git content entry");
  if (text === "missing" || /^blob:[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(text)) return text;
  throw new Error("The Agent Hub turn-completion queue contains an invalid Git content entry.");
}

function isoString(value: unknown, name: string): string {
  const text = requiredText(value, name);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`The ${name} is invalid.`);
  return text;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`The ${name} is invalid.`);
  return Number(value);
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`The ${name} is invalid.`);
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("The Agent Hub turn-completion queue contains an invalid string list.");
  }
  return unique(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function pathKey(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").toLocaleLowerCase("en-US");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

async function canReclaimQueueLock(lockPath: string): Promise<boolean> {
  try {
    const marker = parseQueueLock(await readFile(lockPath, "utf8"));
    return !isProcessAlive(marker.pid);
  } catch (error) {
    if (isMissingFile(error)) return false;
    try {
      return Date.now() - (await stat(lockPath)).mtimeMs >= INVALID_QUEUE_LOCK_GRACE_MS;
    } catch (statError) {
      if (isMissingFile(statError)) return false;
      throw statError;
    }
  }
}

function parseQueueLock(raw: string): QueueLockMarker {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The Agent Hub turn-completion queue lock is not valid JSON.");
  }
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) {
    throw new Error("The Agent Hub turn-completion queue lock has an unsupported format.");
  }
  return {
    version: 1,
    pid: Number(value.pid),
    token: requiredId(value.token, "turn-completion queue lock token"),
    startedAt: isoString(value.startedAt, "turn-completion queue lock startedAt"),
  };
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

async function releaseQueueLock(lockPath: string, marker: QueueLockMarker): Promise<void> {
  try {
    const current = parseQueueLock(await readFile(lockPath, "utf8"));
    // finally 只能释放自己的 token，旧持有者不得删除已经接管的后继锁。
    if (current.token === marker.token) await unlink(lockPath);
  } catch (error) {
    // 无法证明所有权时保留锁；损坏锁会在宽限期后由后继调用回收。
    if (!isMissingFile(error)) return;
  }
}

function laterIso(left: string, right: string): string {
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function restrictPermissions(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // Windows 由当前用户配置目录的 ACL 提供主要隔离。
  }
}
