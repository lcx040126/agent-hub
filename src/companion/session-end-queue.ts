import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
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
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
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
      nextAttemptAt: timestamp,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
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

  async list(): Promise<SessionEndQueueJob[]> {
    let names: string[];
    try {
      names = (await readdir(this.directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const jobs = await Promise.all(names.map(async (name) =>
      parseSessionEndQueueJob(await readFile(path.join(this.directory, name), "utf8"))));
    return jobs.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async load(finalizationId: string): Promise<SessionEndQueueJob> {
    return parseSessionEndQueueJob(await readFile(this.filePath(finalizationId), "utf8"));
  }

  async recordFailure(
    job: SessionEndQueueJob,
    error: Error,
    now = new Date(),
  ): Promise<SessionEndQueueJob> {
    const attempts = job.attempts + 1;
    const delayMs = Math.min(5 * 60_000, 2_000 * (2 ** Math.min(attempts - 1, 7)));
    const updated: SessionEndQueueJob = {
      ...job,
      attempts,
      nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
      lastError: error.message.slice(0, 4000),
      updatedAt: now.toISOString(),
    };
    await this.replace(updated);
    return updated;
  }

  async remove(finalizationId: string): Promise<void> {
    await unlink(this.filePath(finalizationId)).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }

  async removeForConnection(connectionId: string): Promise<number> {
    const selected = requiredId(connectionId, "connection ID");
    const jobs = await this.list();
    const matching = jobs.filter((job) => job.connectionId === selected);
    await Promise.all(matching.map((job) => this.remove(job.finalizationId)));
    return matching.length;
  }

  private async replace(job: SessionEndQueueJob): Promise<void> {
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
    nextAttemptAt: isoString(value.nextAttemptAt, "next attempt"),
    lastError: nullableText(value.lastError),
    createdAt: isoString(value.createdAt, "createdAt"),
    updatedAt: isoString(value.updatedAt, "updatedAt"),
  };
}

function serialize(job: SessionEndQueueJob): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

async function restrictPermissions(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // Windows access is controlled by the owning user profile.
  }
}
