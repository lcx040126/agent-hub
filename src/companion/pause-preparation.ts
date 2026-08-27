import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PauseReason } from "./pause-retry.js";

export const PAUSE_PREPARATION_FILENAME = "pause-preparation.json";
const DOCUMENT_VERSION = 1 as const;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_RETRY_ATTEMPTS = 1_000;

export interface PausePreparationEntry {
  version: typeof DOCUMENT_VERSION;
  connectionId: string;
  reason: PauseReason;
  requestId: string;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
}

interface PausePreparationDocument {
  version: typeof DOCUMENT_VERSION;
  requests: PausePreparationEntry[];
}

export interface PausePreparationQueueOptions {
  filePath: string;
  now?: () => Date;
}

/**
 * Persists cleanup intents that cannot safely choose cutoffAt yet. No new
 * session may start until these entries have drained and moved to pause-retry.
 */
export class PausePreparationQueue {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private readonly options: PausePreparationQueueOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async enqueue(input: Pick<PausePreparationEntry, "connectionId" | "reason" | "requestId">): Promise<void> {
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      if (document.requests.some((entry) => entry.requestId === input.requestId)) return;
      document.requests.push({
        version: DOCUMENT_VERSION,
        connectionId: requiredText(input.connectionId, "connection ID"),
        reason: parseReason(input.reason),
        requestId: requiredText(input.requestId, "request ID"),
        attempts: 0,
        nextAttemptAt: this.now().toISOString(),
      });
      await this.writeDocument(document);
    });
  }

  async list(): Promise<PausePreparationEntry[]> {
    await this.writeQueue;
    return (await this.readDocument()).requests.map((entry) => ({ ...entry }));
  }

  async remove(requestId: string): Promise<void> {
    const normalizedId = requiredText(requestId, "request ID");
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      const requests = document.requests.filter((entry) => entry.requestId !== normalizedId);
      if (requests.length === document.requests.length) return;
      await this.writeDocument({ version: DOCUMENT_VERSION, requests });
    });
  }

  async defer(requestId: string, error: Error): Promise<void> {
    const normalizedId = requiredText(requestId, "request ID");
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      let changed = false;
      const requests = document.requests.map((entry) => {
        if (entry.requestId !== normalizedId) return entry;
        changed = true;
        const attempts = Math.min(entry.attempts + 1, MAX_RETRY_ATTEMPTS);
        return {
          ...entry,
          attempts,
          nextAttemptAt: new Date(this.now().getTime() + retryDelay(attempts)).toISOString(),
          lastError: error.message,
        };
      });
      if (changed) await this.writeDocument({ version: DOCUMENT_VERSION, requests });
    });
  }

  private async readDocument(): Promise<PausePreparationDocument> {
    let raw: string;
    try {
      raw = await readFile(path.resolve(this.options.filePath), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return { version: DOCUMENT_VERSION, requests: [] };
      throw error;
    }
    return parseDocument(raw);
  }

  private async writeDocument(document: PausePreparationDocument): Promise<void> {
    const target = path.resolve(this.options.filePath);
    const directory = path.dirname(target);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await restrictPermissions(directory, 0o700);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await restrictPermissions(temporary, 0o600);
      await rename(temporary, target);
      await restrictPermissions(target, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

export async function hasPendingPausePreparationForConnection(
  userDataPath: string,
  connectionId: string,
): Promise<boolean> {
  const normalizedId = requiredText(connectionId, "connection ID");
  let raw: string;
  try {
    raw = await readFile(path.join(path.resolve(userDataPath), PAUSE_PREPARATION_FILENAME), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  return parseDocument(raw).requests.some((entry) => entry.connectionId === normalizedId);
}

function parseDocument(raw: string): PausePreparationDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Agent Hub pause preparation storage is not valid JSON.");
  }
  if (!isRecord(value) || value.version !== DOCUMENT_VERSION || !Array.isArray(value.requests)) {
    throw new Error("Agent Hub pause preparation storage uses an unsupported format.");
  }
  return { version: DOCUMENT_VERSION, requests: value.requests.map(parseEntry) };
}

function parseEntry(value: unknown): PausePreparationEntry {
  if (!isRecord(value) || value.version !== DOCUMENT_VERSION) {
    throw new Error("Agent Hub found an invalid pause preparation entry.");
  }
  const attempts = Number(value.attempts);
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > MAX_RETRY_ATTEMPTS) {
    throw new Error("Agent Hub found an invalid pause preparation attempt count.");
  }
  return {
    version: DOCUMENT_VERSION,
    connectionId: requiredText(value.connectionId, "connection ID"),
    reason: parseReason(value.reason),
    requestId: requiredText(value.requestId, "request ID"),
    attempts,
    nextAttemptAt: requiredIso(value.nextAttemptAt, "nextAttemptAt"),
    lastError: typeof value.lastError === "string" ? value.lastError : undefined,
  };
}

function parseReason(value: unknown): PauseReason {
  if (value !== "leave-room" && value !== "app-shutdown" && value !== "host-exit") {
    throw new Error("Agent Hub found an invalid pause preparation reason.");
  }
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`The pause preparation ${label} is required.`);
  }
  return value.trim();
}

function requiredIso(value: unknown, label: string): string {
  const result = requiredText(value, label);
  if (!Number.isFinite(Date.parse(result))) {
    throw new Error(`The pause preparation ${label} is invalid.`);
  }
  return result;
}

function retryDelay(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.min(attempts - 1, 6));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function restrictPermissions(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // Windows ACLs are the effective protection in packaged installations.
  }
}
