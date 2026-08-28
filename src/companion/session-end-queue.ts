import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CodexHookSessionState, HookLeaseState } from "./hook-state.js";

export interface SessionEndQueueJob {
  version: 1;
  finalizationId: string;
  codexSessionId: string;
  connectionId: string;
  hubSessionId: string;
  repositoryPath: string;
  branch: string;
  baseCommit: string;
  attributedPaths: string[];
  attributedPathsTruncated: boolean;
  leases: HookLeaseState[];
  externalChangeCount: number;
  reason: string | null;
  attempts: number;
  localEvidenceAttempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecordSessionEndFailureOptions {
  localEvidenceFailure?: boolean;
}

export type SessionEndQueueDiagnostic = (error: Error, filePath: string) => void;

const QUEUE_LOCK_POLL_INTERVAL_MS = 20;
// SessionEnd 可能先后入队、等待 750ms 会话锁、再合并队列；单次队列等待必须足够短，才能守住宿主 3 秒上限。
const QUEUE_LOCK_TIMEOUT_MS = 500;
const INVALID_QUEUE_LOCK_GRACE_MS = 1_000;

interface QueueLockMarker {
  version: 1;
  pid: number;
  token: string;
  startedAt: string;
}

export class SessionEndQueueStore {
  readonly directory: string;

  constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, "session-end-queue");
  }

  async enqueue(
    state: CodexHookSessionState,
    reason?: string,
    now = new Date(),
  ): Promise<SessionEndQueueJob> {
    const timestamp = now.toISOString();
    const job: SessionEndQueueJob = {
      version: 1,
      finalizationId: state.finalizationId ?? randomUUID(),
      codexSessionId: state.codexSessionId,
      connectionId: state.connectionId,
      hubSessionId: state.hubSessionId,
      repositoryPath: state.repositoryPath,
      branch: state.branch,
      baseCommit: state.baseCommit,
      attributedPaths: unique(state.attributedChangedPaths ?? []),
      attributedPathsTruncated: state.attributedPathsTruncated === true,
      leases: state.leases.map((lease) => ({
        id: lease.id,
        paths: unique(lease.paths),
        expiresAt: lease.expiresAt,
      })),
      externalChangeCount: state.externalChangeDiagnostics?.reduce(
        (total, diagnostic) => total + diagnostic.paths.length,
        0,
      ) ?? 0,
      reason: reason?.trim() || null,
      attempts: 0,
      localEvidenceAttempts: 0,
      nextAttemptAt: timestamp,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    // 首次 tombstone 必须独立于 RMW 锁原子落盘；即使旧 worker 正持锁，SessionEnd 也不能空手返回。
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await restrictPermissions(this.directory, 0o700);
    const destination = this.filePath(job.finalizationId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialize(job), { encoding: "utf8", mode: 0o600 });
      await link(temporary, destination);
      await restrictPermissions(destination, 0o600);
      return job;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      return this.load(job.finalizationId);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async list(onDiagnostic?: SessionEndQueueDiagnostic): Promise<SessionEndQueueJob[]> {
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
        return parseSessionEndQueueJob(await readFile(filePath, "utf8"));
      } catch (error) {
        if (isMissingFile(error)) return undefined;
        const diagnostic = new Error(
          `Skipped invalid Agent Hub session-end queue entry ${name}: ${errorMessage(error)}`,
          { cause: error },
        );
        try {
          onDiagnostic?.(diagnostic, filePath);
        } catch {
          // 诊断回调自身失败时，不能让一个损坏条目重新阻塞其他会话收尾。
        }
        return undefined;
      }
    }));
    return jobs
      .filter((job): job is SessionEndQueueJob => job !== undefined)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async listForSession(
    codexSessionId: string,
    onDiagnostic?: SessionEndQueueDiagnostic,
  ): Promise<SessionEndQueueJob[]> {
    const selected = requiredId(codexSessionId, "Codex session ID");
    return (await this.list(onDiagnostic)).filter((job) => job.codexSessionId === selected);
  }

  async load(finalizationId: string): Promise<SessionEndQueueJob> {
    return parseSessionEndQueueJob(await readFile(this.filePath(finalizationId), "utf8"));
  }

  /**
   * SessionEnd 先落盘 tombstone，再尝试取得会话锁。若写入 Hook 正在锁内收口，
   * worker 会在处理前把它的最终状态单调合并进任务，避免旧快照丢失路径或租约。
   */
  async mergeState(
    finalizationId: string,
    state: CodexHookSessionState,
    reason?: string,
    now = new Date(),
  ): Promise<SessionEndQueueJob> {
    return this.runExclusive(finalizationId, async () => {
      const current = await this.load(finalizationId);
      if (!matchesSessionEndJob(current, state)) {
        throw new Error("The Agent Hub SessionEnd state belongs to a different lifecycle generation.");
      }
      const updated: SessionEndQueueJob = {
        ...current,
        attributedPaths: unique([
          ...current.attributedPaths,
          ...(state.attributedChangedPaths ?? []),
        ]),
        attributedPathsTruncated: current.attributedPathsTruncated
          || state.attributedPathsTruncated === true,
        leases: mergeLeases(current.leases, state.leases),
        externalChangeCount: Math.max(
          current.externalChangeCount,
          state.externalChangeDiagnostics?.reduce(
            (total, diagnostic) => total + diagnostic.paths.length,
            0,
          ) ?? 0,
        ),
        reason: current.reason ?? (reason?.trim() || null),
        updatedAt: now.toISOString(),
      };
      await this.replaceUnlocked(updated);
      return updated;
    });
  }

  async recordFailure(
    job: SessionEndQueueJob,
    error: Error,
    now = new Date(),
    options: RecordSessionEndFailureOptions = {},
  ): Promise<SessionEndQueueJob | undefined> {
    return this.runExclusive(job.finalizationId, async () => {
      let current: SessionEndQueueJob;
      try {
        current = await this.load(job.finalizationId);
      } catch (loadError) {
        if (isMissingFile(loadError)) return undefined;
        throw loadError;
      }
      if (!sameLifecycleJob(current, job)) {
        throw new Error("The Agent Hub SessionEnd retry belongs to a different lifecycle generation.");
      }
      const attempts = current.attempts + 1;
      const delayMs = Math.min(5 * 60_000, 2_000 * (2 ** Math.min(attempts - 1, 7)));
      const updated: SessionEndQueueJob = {
        ...current,
        attempts,
        localEvidenceAttempts: current.localEvidenceAttempts
          + (options.localEvidenceFailure === true ? 1 : 0),
        nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
        lastError: error.message.slice(0, 4000),
        updatedAt: now.toISOString(),
      };
      await this.replaceUnlocked(updated);
      return updated;
    });
  }

  async remove(finalizationId: string): Promise<void> {
    await this.runExclusive(finalizationId, async () => {
      await unlink(this.filePath(finalizationId)).catch((error: unknown) => {
        if (!isMissingFile(error)) throw error;
      });
    });
  }

  async removeForConnection(connectionId: string): Promise<number> {
    const selected = requiredId(connectionId, "connection ID");
    const jobs = await this.list();
    const matching = jobs.filter((job) => job.connectionId === selected);
    await Promise.all(matching.map((job) => this.remove(job.finalizationId)));
    return matching.length;
  }

  private async replaceUnlocked(job: SessionEndQueueJob): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.filePath(job.finalizationId);
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

  private filePath(finalizationId: string): string {
    return path.join(this.directory, `${requiredId(finalizationId, "finalization ID")}.json`);
  }

  private lockPath(finalizationId: string): string {
    return path.join(this.directory, `${requiredId(finalizationId, "finalization ID")}.lock`);
  }

  private async runExclusive<T>(finalizationId: string, task: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await restrictPermissions(this.directory, 0o700);
    const lockPath = this.lockPath(finalizationId);
    const marker: QueueLockMarker = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    const deadline = Date.now() + QUEUE_LOCK_TIMEOUT_MS;
    while (true) {
      try {
        await writeFile(lockPath, serializeLock(marker), {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        await restrictPermissions(lockPath, 0o600);
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        if (await canReclaimQueueLock(lockPath)) {
          await unlink(lockPath).catch((unlinkError: unknown) => {
            if (!isMissingFile(unlinkError)) throw unlinkError;
          });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out while waiting for Agent Hub SessionEnd queue lock ${finalizationId}.`);
        }
        await delay(QUEUE_LOCK_POLL_INTERVAL_MS);
      }
    }
    try {
      return await task();
    } finally {
      try {
        const current = parseQueueLock(await readFile(lockPath, "utf8"));
        if (current.token === marker.token) await unlink(lockPath);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
  }
}

export function matchesSessionEndJob(
  job: Pick<SessionEndQueueJob, "finalizationId" | "codexSessionId" | "connectionId" | "hubSessionId">,
  state: Pick<CodexHookSessionState, "finalizationId" | "codexSessionId" | "connectionId" | "hubSessionId">,
): boolean {
  return job.codexSessionId === state.codexSessionId
    && job.connectionId === state.connectionId
    && job.hubSessionId === state.hubSessionId
    // States written before lifecycle tokens were introduced are accepted once, then removed.
    && (state.finalizationId === undefined || job.finalizationId === state.finalizationId);
}

export function parseSessionEndQueueJob(raw: string): SessionEndQueueJob {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The Agent Hub session-end queue entry is not valid JSON.");
  }
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("The Agent Hub session-end queue entry has an unsupported format.");
  }
  const leases = Array.isArray(value.leases) ? value.leases.map((lease) => {
    if (!isRecord(lease)) throw new Error("The Agent Hub session-end queue has an invalid lease.");
    return {
      id: requiredId(lease.id, "lease ID"),
      paths: stringArray(lease.paths),
      expiresAt: isoString(lease.expiresAt, "lease expiry"),
    };
  }) : [];
  return {
    version: 1,
    finalizationId: requiredId(value.finalizationId, "finalization ID"),
    codexSessionId: requiredId(value.codexSessionId, "Codex session ID"),
    connectionId: requiredId(value.connectionId, "connection ID"),
    hubSessionId: requiredId(value.hubSessionId, "Agent Hub session ID"),
    repositoryPath: path.resolve(requiredText(value.repositoryPath, "repository path")),
    branch: requiredText(value.branch, "branch"),
    baseCommit: requiredText(value.baseCommit, "base commit"),
    attributedPaths: stringArray(value.attributedPaths),
    attributedPathsTruncated: value.attributedPathsTruncated === true,
    leases,
    externalChangeCount: nonNegativeInteger(value.externalChangeCount, "external change count"),
    reason: nullableText(value.reason),
    attempts: nonNegativeInteger(value.attempts, "attempt count"),
    // v0.2.4 只记录总尝试次数；旧文件无法可靠反推本地证据失败次数，因此从 0 安全迁移。
    localEvidenceAttempts: value.localEvidenceAttempts === undefined
      ? 0
      : nonNegativeInteger(value.localEvidenceAttempts, "local evidence attempt count"),
    nextAttemptAt: isoString(value.nextAttemptAt, "next attempt"),
    lastError: nullableText(value.lastError),
    createdAt: isoString(value.createdAt, "createdAt"),
    updatedAt: isoString(value.updatedAt, "updatedAt"),
  };
}

function serialize(job: SessionEndQueueJob): string {
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

function isoString(value: unknown, name: string): string {
  const text = requiredText(value, name);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`The ${name} is invalid.`);
  return text;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`The ${name} is invalid.`);
  return Number(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("The Agent Hub session-end queue contains an invalid path list.");
  }
  return unique(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mergeLeases(current: HookLeaseState[], incoming: HookLeaseState[]): HookLeaseState[] {
  const merged = new Map(current.map((lease) => [lease.id, {
    id: lease.id,
    paths: unique(lease.paths),
    expiresAt: lease.expiresAt,
  }]));
  for (const lease of incoming) {
    const existing = merged.get(lease.id);
    if (!existing) {
      merged.set(lease.id, {
        id: lease.id,
        paths: unique(lease.paths),
        expiresAt: lease.expiresAt,
      });
      continue;
    }
    merged.set(lease.id, {
      id: lease.id,
      paths: unique([...existing.paths, ...lease.paths]),
      expiresAt: Date.parse(lease.expiresAt) > Date.parse(existing.expiresAt)
        ? lease.expiresAt
        : existing.expiresAt,
    });
  }
  return [...merged.values()];
}

function sameLifecycleJob(left: SessionEndQueueJob, right: SessionEndQueueJob): boolean {
  return left.finalizationId === right.finalizationId
    && left.codexSessionId === right.codexSessionId
    && left.connectionId === right.connectionId
    && left.hubSessionId === right.hubSessionId;
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
    throw new Error("The Agent Hub SessionEnd queue lock is not valid JSON.");
  }
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) {
    throw new Error("The Agent Hub SessionEnd queue lock has an unsupported format.");
  }
  return {
    version: 1,
    pid: Number(value.pid),
    token: requiredId(value.token, "SessionEnd queue lock token"),
    startedAt: isoString(value.startedAt, "SessionEnd queue lock startedAt"),
  };
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

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
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
    // Windows access is controlled by the owning user profile.
  }
}
