import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CodexHookSessionState } from "./hook-state.js";
import type { AttributedPathEvidence } from "./turn-completion.js";

export interface TurnCompletionJob {
  version: 1;
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
const STALE_LOCK_MS = 30_000;

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
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await restrictPermissions(this.directory, 0o700);
    const destination = this.filePath(job.operationId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialize(job), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, destination);
      await restrictPermissions(destination, 0o600);
      return job;
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
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

  async runExclusive<T>(operationId: string, task: () => Promise<T>): Promise<T | undefined> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.directory, `${requiredId(operationId, "completion operation ID")}.lock`);
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      try {
        if (Date.now() - (await stat(lockPath)).mtimeMs <= STALE_LOCK_MS) return undefined;
        await unlink(lockPath);
        handle = await open(lockPath, "wx", 0o600);
      } catch (retryError) {
        if (isAlreadyExists(retryError) || isMissingFile(retryError)) return undefined;
        throw retryError;
      }
    }
    try {
      return await task();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  async recordRetry(
    job: TurnCompletionJob,
    error: Error | null,
    now = new Date(),
    delayMs = 15_000,
  ): Promise<TurnCompletionJob> {
    const updated: TurnCompletionJob = {
      ...job,
      attempts: job.attempts + 1,
      nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
      lastError: error ? error.message.slice(0, 4_000) : null,
      updatedAt: now.toISOString(),
    };
    await this.replace(updated);
    return updated;
  }

  async remove(operationId: string): Promise<void> {
    await unlink(this.filePath(operationId)).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }

  async removeForSession(codexSessionId: string, beforeEpoch?: number): Promise<number> {
    const jobs = (await this.listForSession(codexSessionId)).filter((job) =>
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

  private async replace(job: TurnCompletionJob): Promise<void> {
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

  private filePath(operationId: string): string {
    return path.join(this.directory, `${requiredId(operationId, "completion operation ID")}.json`);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function restrictPermissions(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // Windows 由当前用户配置目录的 ACL 提供主要隔离。
  }
}
