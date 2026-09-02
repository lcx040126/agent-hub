import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConnectionStore } from "../desktop/connection-store.js";
import { AgentHubClient, AgentHubHttpError } from "./hub-client.js";

export const PAUSE_RETRY_FILENAME = "pause-retry.json";
const DOCUMENT_VERSION = 1 as const;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_RETRY_ATTEMPTS = 1_000;

export type PauseReason = "leave-room" | "app-shutdown" | "host-exit";
export type PauseFailureKind =
  | "unreachable"
  | "timeout"
  | "unauthorized"
  | "member_removed"
  | "room_dissolved"
  | "incompatible"
  | "invalid_response"
  | "local"
  | "unknown";

export interface PauseRetryEntry {
  version: typeof DOCUMENT_VERSION;
  connectionId: string;
  reason: PauseReason;
  cutoffAt: string;
  requestId: string;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  lastFailureKind?: PauseFailureKind;
  lastErrorCode?: string;
  lastHttpStatus?: number;
}

interface PauseRetryDocument {
  version: typeof DOCUMENT_VERSION;
  requests: PauseRetryEntry[];
}

export interface PauseRequestResult {
  queued: boolean;
  requestId: string;
  cleanupError?: string;
  failureKind?: "transient-remote" | "remote" | "local";
  response?: PauseMemberResponse;
}

export interface PauseMemberResponse {
  requestId: string;
  roomId: string;
  memberId: string;
  memberRole: "host" | "member";
  reason: string;
  cutoffAt: string;
  appliedAt: string;
  alreadyApplied: boolean;
  closedSessionIds: string[];
  releasedLeaseIds: string[];
  cancelledReleaseRequestIds: string[];
  expiredConfirmationIds: string[];
  closedSessionCount: number;
  releasedLeaseCount: number;
  cancelledReleaseRequestCount: number;
  expiredConfirmationCount: number;
}

export interface PauseRetryQueueOptions {
  filePath: string;
  store: Pick<ConnectionStore, "get" | "readMemberToken">;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  onError?: (error: Error, entry?: PauseRetryEntry) => void;
}

export interface PauseRetryFlushOptions {
  /** Keep entries that still depend on an earlier durable recovery record. */
  shouldRetain?: (entry: Readonly<PauseRetryEntry>) => boolean | Promise<boolean>;
  /** Restrict a foreground retry to one saved room. */
  onlyConnectionId?: string;
  /** Ignore backoff and non-retryable diagnostics for an explicit user retry. */
  force?: boolean;
}

/** A durable queue containing only connection IDs and cutoff metadata, never tokens. */
export class PauseRetryQueue {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(private readonly options: PauseRetryQueueOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async enqueue(
    input: Omit<PauseRetryEntry, "version" | "attempts" | "nextAttemptAt">,
  ): Promise<PauseRetryEntry> {
    return this.withWriteLock(async () => {
      const document = await this.readDocument();
      const existing = document.requests.find((entry) => entry.requestId === input.requestId);
      if (existing) return { ...existing };
      const entry: PauseRetryEntry = {
        version: DOCUMENT_VERSION,
        ...input,
        attempts: 0,
        nextAttemptAt: this.now().toISOString(),
      };
      document.requests.push(entry);
      await this.writeDocument(document);
      return { ...entry };
    });
  }

  async remove(requestId: string): Promise<void> {
    const normalizedId = text(requestId, "request ID");
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      const requests = document.requests.filter((entry) => entry.requestId !== normalizedId);
      if (requests.length === document.requests.length) return;
      await this.writeDocument({ version: DOCUMENT_VERSION, requests });
    });
  }

  async removeForConnection(connectionId: string): Promise<number> {
    const normalizedId = text(connectionId, "connection ID");
    return this.withWriteLock(async () => {
      const document = await this.readDocument();
      const requests = document.requests.filter((entry) => entry.connectionId !== normalizedId);
      const removed = document.requests.length - requests.length;
      if (removed > 0) {
        await this.writeDocument({ version: DOCUMENT_VERSION, requests });
      }
      return removed;
    });
  }

  async defer(requestId: string, error: Error): Promise<void> {
    const normalizedId = text(requestId, "request ID");
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      const now = this.now();
      let changed = false;
      const requests = document.requests.map((entry) => {
        if (entry.requestId !== normalizedId) return entry;
        changed = true;
        const attempts = Math.min(entry.attempts + 1, MAX_RETRY_ATTEMPTS);
        const diagnostic = pauseFailureDiagnostic(error);
        return {
          ...entry,
          attempts,
          nextAttemptAt: new Date(now.getTime() + retryDelay(attempts)).toISOString(),
          lastError: error.message,
          lastFailureKind: diagnostic.kind,
          lastErrorCode: diagnostic.code,
          lastHttpStatus: diagnostic.httpStatus,
        };
      });
      if (changed) await this.writeDocument({ version: DOCUMENT_VERSION, requests });
    });
  }

  async list(): Promise<PauseRetryEntry[]> {
    await this.writeQueue;
    return (await this.readDocument()).requests.map((entry) => ({ ...entry }));
  }

  async flush(options: PauseRetryFlushOptions = {}): Promise<void> {
    await this.withWriteLock(async () => {
      const document = await this.readDocument();
      const now = this.now();
      let changed = false;
      const remaining: PauseRetryEntry[] = [];
      for (const entry of document.requests) {
        if (options.onlyConnectionId && entry.connectionId !== options.onlyConnectionId) {
          remaining.push(entry);
          continue;
        }
        if (!options.force && entry.lastFailureKind && !isRetryablePauseFailure(entry.lastFailureKind)) {
          remaining.push(entry);
          continue;
        }
        if (!options.force && Date.parse(entry.nextAttemptAt) > now.getTime()) {
          remaining.push(entry);
          continue;
        }
        if (await options.shouldRetain?.({ ...entry })) {
          remaining.push(entry);
          continue;
        }
        try {
          await sendPauseRequest(this.options.store, this.fetchImpl, {
            connectionId: entry.connectionId,
            reason: entry.reason,
            cutoffAt: entry.cutoffAt,
            requestId: entry.requestId,
          });
          changed = true;
        } catch (error) {
          const normalized = asError(error);
          // Cleanup responsibility remains durable across authentication,
          // compatibility, malformed-response, and transport failures. The
          // only terminal conflict proves this request id was already applied
          // with earlier parameters, so replaying it cannot add safety.
          if (!shouldRetainPauseError(error)) {
            changed = true;
            this.options.onError?.(normalized, entry);
            continue;
          }
          const attempts = Math.min(entry.attempts + 1, MAX_RETRY_ATTEMPTS);
          const diagnostic = pauseFailureDiagnostic(error);
          remaining.push({
            ...entry,
            attempts,
            nextAttemptAt: new Date(now.getTime() + retryDelay(attempts)).toISOString(),
            lastError: normalized.message,
            lastFailureKind: diagnostic.kind,
            lastErrorCode: diagnostic.code,
            lastHttpStatus: diagnostic.httpStatus,
          });
          changed = true;
          this.options.onError?.(normalized, entry);
        }
      }
      if (changed) await this.writeDocument({ version: DOCUMENT_VERSION, requests: remaining });
    });
  }

  private async readDocument(): Promise<PauseRetryDocument> {
    let raw: string;
    try {
      raw = await readFile(path.resolve(this.options.filePath), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return { version: DOCUMENT_VERSION, requests: [] };
      throw error;
    }
    return parseDocument(raw);
  }

  private async writeDocument(document: PauseRetryDocument): Promise<void> {
    const target = path.resolve(this.options.filePath);
    const directory = path.dirname(target);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await restrictPermissions(directory, 0o700);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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

/**
 * Headless integrations use this file-only check to avoid creating new remote
 * work while an older shutdown cleanup is waiting to reach the room server.
 */
export async function hasPendingPauseForConnection(
  userDataPath: string,
  connectionId: string,
): Promise<boolean> {
  const normalizedId = text(connectionId, "connection ID");
  let raw: string;
  try {
    raw = await readFile(path.join(path.resolve(userDataPath), PAUSE_RETRY_FILENAME), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  return parseDocument(raw).requests.some((entry) => entry.connectionId === normalizedId);
}

export async function requestMemberPause(
  store: Pick<ConnectionStore, "get" | "readMemberToken">,
  connectionId: string,
  reason: PauseReason,
  options: {
    fetchImpl?: typeof fetch;
    now?: () => Date;
    queue?: PauseRetryQueue;
    requestId?: string;
    /**
     * Standalone callers remove completed retries by default. Coordinators
     * spanning multiple durable records can retain the fixed cutoff until
     * their earlier recovery record has been removed.
     */
    queueCompletion?: "remove" | "retain";
  } = {},
): Promise<PauseRequestResult> {
  const now = options.now ?? (() => new Date());
  const proposedEntry: Omit<PauseRetryEntry, "version" | "attempts" | "nextAttemptAt"> = {
    connectionId,
    reason,
    cutoffAt: now().toISOString(),
    requestId: options.requestId ?? randomUUID(),
  };
  // Persist the complete request before the first network attempt. If the
  // process stops after the server commits but before local cleanup finishes,
  // replay keeps the exact same requestId and cutoffAt.
  const entry = options.queue
    ? await options.queue.enqueue(proposedEntry)
    : proposedEntry;
  try {
    const response = await sendPauseRequest(store, options.fetchImpl ?? fetch, {
      connectionId: entry.connectionId,
      reason: entry.reason,
      cutoffAt: entry.cutoffAt,
      requestId: entry.requestId,
    });
    if (options.queue && options.queueCompletion !== "retain") {
      try {
        await options.queue.remove(entry.requestId);
      } catch (error) {
        return {
          queued: true,
          requestId: entry.requestId,
          cleanupError: `Remote cleanup completed, but its fixed retry record could not be removed: ${asError(error).message}`,
          failureKind: "local",
          response,
        };
      }
    }
    return { queued: false, requestId: entry.requestId, response };
  } catch (error) {
    if (!options.queue) throw error;
    if (!shouldRetainPauseError(error)) {
      if (options.queueCompletion === "retain") {
        return { queued: false, requestId: entry.requestId };
      }
      try {
        await options.queue.remove(entry.requestId);
        return { queued: false, requestId: entry.requestId };
      } catch (removeError) {
        return {
          queued: true,
          requestId: entry.requestId,
          cleanupError: `The pause request was already applied, but its fixed retry record could not be removed: ${asError(removeError).message}`,
          failureKind: "local",
        };
      }
    }
    const failure = asError(error);
    await options.queue.defer(entry.requestId, failure);
    return {
      queued: true,
      requestId: entry.requestId,
      cleanupError: failure.message,
      failureKind: isTransientPauseFailure(error) ? "transient-remote" : "remote",
    };
  }
}

async function sendPauseRequest(
  store: Pick<ConnectionStore, "get" | "readMemberToken">,
  fetchImpl: typeof fetch,
  entry: Pick<PauseRetryEntry, "connectionId" | "reason" | "cutoffAt" | "requestId">,
): Promise<PauseMemberResponse> {
  const connection = await store.get(entry.connectionId);
  if (!connection) {
    throw new Error(`Agent Hub cannot finish pause cleanup because connection ${entry.connectionId} is missing.`);
  }
  const token = await store.readMemberToken(connection.id);
  const client = new AgentHubClient({
    serverUrl: connection.serverUrl,
    memberToken: token,
    fetchImpl,
    timeoutMs: 10_000,
  });
  const payload = await client.post<unknown>("/api/member/pause", {
    reason: entry.reason,
    cutoffAt: entry.cutoffAt,
    requestId: entry.requestId,
  });
  const response = parsePauseMemberResponse(payload);
  if (response.requestId !== entry.requestId) {
    throw invalidPauseResponse("requestId does not match the submitted request.");
  }
  return response;
}

function parsePauseMemberResponse(value: unknown): PauseMemberResponse {
  if (!isRecord(value)) throw invalidPauseResponse("the body must be an object.");
  const memberRole = value.memberRole;
  if (memberRole !== "host" && memberRole !== "member") {
    throw invalidPauseResponse("memberRole must be host or member.");
  }
  if (typeof value.alreadyApplied !== "boolean") {
    throw invalidPauseResponse("alreadyApplied must be boolean.");
  }
  const closedSessionIds = responseStringArray(value.closedSessionIds, "closedSessionIds");
  const releasedLeaseIds = responseStringArray(value.releasedLeaseIds, "releasedLeaseIds");
  const cancelledReleaseRequestIds = responseStringArray(
    value.cancelledReleaseRequestIds,
    "cancelledReleaseRequestIds",
  );
  const expiredConfirmationIds = responseStringArray(
    value.expiredConfirmationIds,
    "expiredConfirmationIds",
  );
  return {
    requestId: responseText(value.requestId, "requestId"),
    roomId: responseText(value.roomId, "roomId"),
    memberId: responseText(value.memberId, "memberId"),
    memberRole,
    reason: responseText(value.reason, "reason"),
    cutoffAt: responseIso(value.cutoffAt, "cutoffAt"),
    appliedAt: responseIso(value.appliedAt, "appliedAt"),
    alreadyApplied: value.alreadyApplied,
    closedSessionIds,
    releasedLeaseIds,
    cancelledReleaseRequestIds,
    expiredConfirmationIds,
    closedSessionCount: responseCount(value.closedSessionCount, "closedSessionCount", closedSessionIds.length),
    releasedLeaseCount: responseCount(value.releasedLeaseCount, "releasedLeaseCount", releasedLeaseIds.length),
    cancelledReleaseRequestCount: responseCount(
      value.cancelledReleaseRequestCount,
      "cancelledReleaseRequestCount",
      cancelledReleaseRequestIds.length,
    ),
    expiredConfirmationCount: responseCount(
      value.expiredConfirmationCount,
      "expiredConfirmationCount",
      expiredConfirmationIds.length,
    ),
  };
}

function responseStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw invalidPauseResponse(`${name} must contain only non-empty strings.`);
  }
  return value.map((item) => item.trim());
}

function responseText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidPauseResponse(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function responseIso(value: unknown, name: string): string {
  const result = responseText(value, name);
  if (!Number.isFinite(Date.parse(result))) {
    throw invalidPauseResponse(`${name} must be a valid timestamp.`);
  }
  return result;
}

function responseCount(value: unknown, name: string, expected: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value !== expected) {
    throw invalidPauseResponse(`${name} must equal the matching ID count.`);
  }
  return value;
}

function invalidPauseResponse(detail: string): Error {
  return new Error(`Agent Hub returned an invalid member pause response: ${detail}`);
}

function parseDocument(raw: string): PauseRetryDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Agent Hub pause retry storage is not valid JSON.");
  }
  if (!isRecord(value) || value.version !== DOCUMENT_VERSION || !Array.isArray(value.requests)) {
    throw new Error("Agent Hub pause retry storage uses an unsupported format.");
  }
  return {
    version: DOCUMENT_VERSION,
    requests: value.requests.map(parseEntry),
  };
}

function parseEntry(value: unknown): PauseRetryEntry {
  if (!isRecord(value) || value.version !== DOCUMENT_VERSION) throw new Error("Agent Hub found an invalid pause retry entry.");
  const connectionId = text(value.connectionId, "connection ID");
  const requestId = text(value.requestId, "request ID");
  const reason = value.reason;
  if (reason !== "leave-room" && reason !== "app-shutdown" && reason !== "host-exit") {
    throw new Error("Agent Hub found an invalid pause retry reason.");
  }
  const cutoffAt = iso(value.cutoffAt, "cutoffAt");
  const nextAttemptAt = iso(value.nextAttemptAt, "nextAttemptAt");
  const attempts = Number(value.attempts);
  if (!Number.isInteger(attempts) || attempts < 0 || attempts > MAX_RETRY_ATTEMPTS) throw new Error("Agent Hub found an invalid pause retry attempt count.");
  const lastFailureKind = parseFailureKind(value.lastFailureKind);
  const lastHttpStatus = Number(value.lastHttpStatus);
  return {
    version: DOCUMENT_VERSION,
    connectionId,
    reason,
    cutoffAt,
    requestId,
    attempts,
    nextAttemptAt,
    lastError: typeof value.lastError === "string" ? value.lastError : undefined,
    lastFailureKind,
    lastErrorCode: typeof value.lastErrorCode === "string" ? value.lastErrorCode : undefined,
    lastHttpStatus: Number.isInteger(lastHttpStatus) && lastHttpStatus >= 100 && lastHttpStatus <= 599
      ? lastHttpStatus
      : undefined,
  };
}

export function pauseFailureDiagnostic(error: unknown): {
  kind: PauseFailureKind;
  code?: string;
  httpStatus?: number;
} {
  if (error instanceof AgentHubHttpError) {
    const code = error.code.toLowerCase();
    let kind: PauseFailureKind;
    if (error.status === 401 || code === "unauthorized" || code.includes("credential")) {
      kind = "unauthorized";
    } else if (code === "member_removed" || code === "member_not_found") {
      kind = "member_removed";
    } else if (code === "room_dissolved" || code === "room_not_found") {
      kind = "room_dissolved";
    } else if (code === "invalid_response") {
      kind = "invalid_response";
    } else if (/(?:protocol|schema|version|compat|unsupported)/i.test(code)) {
      kind = "incompatible";
    } else if (error.status === 408) {
      kind = "timeout";
    } else if (error.status === 429 || error.status >= 500) {
      kind = "unreachable";
    } else {
      kind = "unknown";
    }
    return { kind, code: error.code, httpStatus: error.status };
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/(?:member (?:was )?removed|成员.*移除)/i.test(message)) {
    return { kind: "member_removed" };
  }
  if (/(?:room (?:was )?dissolved|房间.*解散)/i.test(message)) {
    return { kind: "room_dissolved" };
  }
  if (/(?:unauthorized|credential.*(?:invalid|expired)|token.*(?:invalid|expired))/i.test(message)) {
    return { kind: "unauthorized" };
  }
  if (/invalid member pause response|response that was not valid json/i.test(message)) {
    return { kind: "invalid_response" };
  }
  if (/(?:did not respond|timed out|timeout|etimedout|abort)/i.test(message)) {
    return { kind: "timeout" };
  }
  if (/(?:fetch failed|failed to fetch|network|socket|econn|connection reset|connection refused|enotfound)/i.test(message)) {
    return { kind: "unreachable" };
  }
  if (/(?:pause retry storage|connection .* is missing|member token|enoent|eacces|eperm)/i.test(message)) {
    return { kind: "local" };
  }
  return { kind: "unknown" };
}

export function isRetryablePauseFailure(kind: PauseFailureKind): boolean {
  return kind === "unreachable" || kind === "timeout" || kind === "unknown";
}

function parseFailureKind(value: unknown): PauseFailureKind | undefined {
  return value === "unreachable"
    || value === "timeout"
    || value === "unauthorized"
    || value === "member_removed"
    || value === "room_dissolved"
    || value === "incompatible"
    || value === "invalid_response"
    || value === "local"
    || value === "unknown"
    ? value
    : undefined;
}

function shouldRetainPauseError(error: unknown): boolean {
  return !(error instanceof AgentHubHttpError && error.code === "pause_request_conflict");
}

function isTransientPauseFailure(error: unknown): boolean {
  if (error instanceof AgentHubHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (!(error instanceof Error)) return false;
  return /(?:fetch failed|failed to fetch|network|socket|econn|etimedout|timed out|did not respond|connection reset|connection refused|aborted)/i.test(
    error.message,
  );
}

function retryDelay(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.min(attempts - 1, 6));
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`The pause retry ${name} is required.`);
  return value.trim();
}

function iso(value: unknown, name: string): string {
  const result = text(value, name);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`The pause retry ${name} is invalid.`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function restrictPermissions(target: string, mode: number): Promise<void> {
  try { await chmod(target, mode); } catch { /* Windows ACLs are the effective protection. */ }
}
