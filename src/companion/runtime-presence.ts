import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const RUNTIME_PRESENCE_VERSION = 1 as const;
export const RUNTIME_PRESENCE_FILENAME = "runtime-presence.json";
export const DEFAULT_RUNTIME_PRESENCE_STALE_AFTER_MS = 30_000;
export const DEFAULT_RUNTIME_PRESENCE_HEARTBEAT_INTERVAL_MS = 5_000;

export type RuntimePresenceState = "active" | "maintenance" | "stopped";

export interface RuntimePresenceRecord {
  version: typeof RUNTIME_PRESENCE_VERSION;
  instanceId: string;
  pid: number;
  status: RuntimePresenceState;
  startedAt: string;
  heartbeatAt: string;
}

export type RuntimePresenceValidationStatus =
  | "active"
  | "maintenance"
  | "missing"
  | "stopped"
  | "stale"
  | "dead-pid"
  | "instance-mismatch"
  | "malformed"
  | "unavailable";

export interface RuntimePresenceValidation {
  active: boolean;
  status: RuntimePresenceValidationStatus;
  record?: RuntimePresenceRecord;
  ageMs?: number;
  message?: string;
}

export interface RuntimePresenceReadOptions {
  /** A fixed timestamp is useful to callers and deterministic tests. */
  now?: Date | number;
  staleAfterMs?: number;
  expectedInstanceId?: string;
  isProcessAlive?: (pid: number) => boolean;
}

export interface StartRuntimePresenceOptions {
  instanceId?: string;
  pid?: number;
  now?: () => Date;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  onError?: (error: Error) => void;
}

export interface RuntimePresenceHandle {
  readonly filePath: string;
  readonly instanceId: string;
  readonly pid: number;
  readonly record: RuntimePresenceRecord;
  heartbeat(): Promise<RuntimePresenceRecord>;
  markMaintenance(): Promise<RuntimePresenceRecord>;
  markInactive(): Promise<RuntimePresenceRecord>;
  stop(): Promise<void>;
}

/**
 * Reads and validates the local runtime sentinel. Invalid or inaccessible
 * sentinels are deliberately reported as inactive so integrations fail closed.
 */
export async function readRuntimePresence(
  filePath: string,
  options: RuntimePresenceReadOptions = {},
): Promise<RuntimePresenceValidation> {
  const resolvedPath = resolvePresencePath(filePath);
  let raw: string;
  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { active: false, status: "missing" };
    return {
      active: false,
      status: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  let record: RuntimePresenceRecord;
  try {
    record = parseRuntimePresenceRecord(raw);
  } catch (error) {
    return {
      active: false,
      status: "malformed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return validateRuntimePresence(record, options);
}

/** Validate a parsed sentinel without filesystem access. */
export function validateRuntimePresence(
  record: unknown,
  options: RuntimePresenceReadOptions = {},
): RuntimePresenceValidation {
  let parsed: RuntimePresenceRecord;
  try {
    // Re-parse typed values too: values crossing IPC or JSON boundaries must
    // not bypass strict identifier and PID checks through a type assertion.
    parsed = parseRuntimePresenceRecord(JSON.stringify(record));
  } catch (error) {
    return {
      active: false,
      status: "malformed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (options.expectedInstanceId !== undefined && parsed.instanceId !== options.expectedInstanceId) {
    return {
      active: false,
      status: "instance-mismatch",
      record: parsed,
    };
  }
  if (parsed.status === "maintenance") {
    return { active: false, status: "maintenance", record: parsed, ageMs: presenceAge(parsed, options) };
  }
  if (parsed.status !== "active") {
    return { active: false, status: "stopped", record: parsed, ageMs: presenceAge(parsed, options) };
  }

  const alive = (options.isProcessAlive ?? isProcessAlive)(parsed.pid);
  if (!alive) {
    return { active: false, status: "dead-pid", record: parsed, ageMs: presenceAge(parsed, options) };
  }

  const ageMs = presenceAge(parsed, options);
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_RUNTIME_PRESENCE_STALE_AFTER_MS;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    return {
      active: false,
      status: "malformed",
      record: parsed,
      ageMs,
      message: "The runtime presence stale timeout must be a positive finite number.",
    };
  }
  if (ageMs > staleAfterMs) {
    return { active: false, status: "stale", record: parsed, ageMs };
  }
  return { active: true, status: "active", record: parsed, ageMs };
}

/** Pure boolean form for gate checks. */
export function isRuntimePresenceActive(
  record: unknown,
  options: RuntimePresenceReadOptions = {},
): boolean {
  return validateRuntimePresence(record, options).active;
}

/** Parse and strictly validate a sentinel document. */
export function parseRuntimePresenceRecord(raw: string): RuntimePresenceRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The Agent Hub runtime presence file is not valid JSON.");
  }
  if (!isRecord(value)) throw new Error("The Agent Hub runtime presence file must contain an object.");
  if (value.version !== RUNTIME_PRESENCE_VERSION) {
    throw new Error("The Agent Hub runtime presence file uses an unsupported version.");
  }
  const instanceId = requiredText(value.instanceId, "runtime instance ID", 256);
  const pid = requiredPid(value.pid);
  const status = value.status;
  if (status !== "active" && status !== "maintenance" && status !== "stopped") {
    throw new Error("The Agent Hub runtime presence status is invalid.");
  }
  const startedAt = requiredIsoDate(value.startedAt, "runtime startedAt");
  const heartbeatAt = requiredIsoDate(value.heartbeatAt, "runtime heartbeatAt");
  return {
    version: RUNTIME_PRESENCE_VERSION,
    instanceId,
    pid,
    status,
    startedAt,
    heartbeatAt,
  };
}

/**
 * Starts a sentinel owner. The returned handle serializes heartbeat/stop writes
 * and never overwrites a newer instance that owns the same file.
 */
export async function startRuntimePresence(
  filePath: string,
  options: StartRuntimePresenceOptions = {},
): Promise<RuntimePresenceHandle> {
  const resolvedPath = resolvePresencePath(filePath);
  const instanceId = options.instanceId ?? randomUUID();
  const pid = options.pid ?? process.pid;
  requiredText(instanceId, "runtime instance ID", 256);
  requiredPid(pid);
  const heartbeatIntervalMs = options.heartbeatIntervalMs
    ?? DEFAULT_RUNTIME_PRESENCE_HEARTBEAT_INTERVAL_MS;
  if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs < 0) {
    throw new Error("The runtime presence heartbeat interval must be zero or a finite positive number.");
  }
  const clock = options.now ?? (() => new Date());
  const startedAt = isoNow(clock);
  const existing = await readRuntimePresence(resolvedPath, {
    now: new Date(startedAt),
    staleAfterMs: options.staleAfterMs,
    isProcessAlive: options.isProcessAlive,
  });
  if (existing.active && existing.record?.instanceId !== instanceId) {
    throw new Error(
      `Agent Hub runtime integration is already owned by active instance ${existing.record?.instanceId}.`,
    );
  }
  if (existing.status === "unavailable") {
    throw new Error(
      `Agent Hub could not verify the existing runtime integration owner: ${existing.message ?? "presence file unavailable"}.`,
    );
  }
  let current: RuntimePresenceRecord = {
    version: RUNTIME_PRESENCE_VERSION,
    instanceId,
    pid,
    status: "active",
    startedAt,
    heartbeatAt: startedAt,
  };
  await writeRuntimePresenceRecord(resolvedPath, current);

  let stopped = false;
  let operation: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  const enqueue = async <T>(action: () => Promise<T>): Promise<T> => {
    let result!: T;
    let failure: unknown;
    const run = operation.then(async () => {
      try {
        result = await action();
      } catch (error) {
        failure = error;
      }
    });
    operation = run;
    await run;
    if (failure !== undefined) throw failure;
    return result;
  };

  const refreshOwnership = async (): Promise<boolean> => {
    try {
      const raw = await readFile(resolvedPath, "utf8");
      const existing = parseRuntimePresenceRecord(raw);
      return existing.instanceId === instanceId;
    } catch (error) {
      if (isMissingFile(error)) return true;
      return false;
    }
  };

  const heartbeat = (): Promise<RuntimePresenceRecord> => enqueue(async () => {
    if (stopped || current.status === "stopped") return current;
    if (!(await refreshOwnership())) {
      stopped = true;
      current = { ...current, status: "stopped" };
      if (timer) clearInterval(timer);
      return current;
    }
    current = { ...current, heartbeatAt: isoNow(clock) };
    await writeRuntimePresenceRecord(resolvedPath, current);
    return current;
  });

  const markMaintenance = (): Promise<RuntimePresenceRecord> => enqueue(async () => {
    if (stopped || current.status === "stopped" || current.status === "maintenance") return current;
    if (!(await refreshOwnership())) {
      stopped = true;
      current = { ...current, status: "stopped" };
      if (timer) clearInterval(timer);
      return current;
    }
    current = { ...current, status: "maintenance", heartbeatAt: isoNow(clock) };
    await writeRuntimePresenceRecord(resolvedPath, current);
    return current;
  });

  const markInactive = (): Promise<RuntimePresenceRecord> => enqueue(async () => {
    if (current.status === "stopped") return current;
    stopped = true;
    if (timer) clearInterval(timer);
    if (await refreshOwnership()) {
      current = { ...current, status: "stopped", heartbeatAt: isoNow(clock) };
      await writeRuntimePresenceRecord(resolvedPath, current);
    } else {
      current = { ...current, status: "stopped" };
    }
    return current;
  });

  const stop = async (): Promise<void> => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    await markInactive();
  };

  if (heartbeatIntervalMs > 0) {
    timer = setInterval(() => {
      void heartbeat().catch((error: unknown) => options.onError?.(asError(error)));
    }, heartbeatIntervalMs);
    timer.unref();
  }

  return {
    filePath: resolvedPath,
    instanceId,
    pid,
    get record() {
      return current;
    },
    heartbeat,
    markMaintenance,
    markInactive,
    stop,
  };
}

export async function writeRuntimePresenceRecord(
  filePath: string,
  record: RuntimePresenceRecord,
): Promise<void> {
  const parsed = parseRuntimePresenceRecord(JSON.stringify(record));
  const resolvedPath = resolvePresencePath(filePath);
  const directory = path.dirname(resolvedPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await restrictPermissions(directory, 0o700);
  const temporaryPath = `${resolvedPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await restrictPermissions(temporaryPath, 0o600);
    await rename(temporaryPath, resolvedPath);
    await restrictPermissions(resolvedPath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function validateTimestamp(value: Date | number | undefined): number {
  const timestamp = value instanceof Date ? value.getTime() : value ?? Date.now();
  if (!Number.isFinite(timestamp)) throw new Error("The runtime presence clock value is invalid.");
  return timestamp;
}

function presenceAge(record: RuntimePresenceRecord, options: RuntimePresenceReadOptions): number {
  return Math.max(0, validateTimestamp(options.now) - Date.parse(record.heartbeatAt));
}

function isoNow(clock: () => Date): string {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("The runtime presence clock returned an invalid date.");
  }
  return value.toISOString();
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled by this user.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function requiredPid(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("The runtime presence PID is invalid.");
  }
  return value as number;
}

function requiredText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`The ${name} is required.`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`The ${name} is too long.`);
  return trimmed;
}

function requiredIsoDate(value: unknown, name: string): string {
  const text = requiredText(value, name, 64);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`The ${name} value is not a valid date.`);
  return text;
}

function resolvePresencePath(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("A runtime presence file path is required.");
  return path.resolve(value);
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
  try {
    await chmod(target, mode);
  } catch {
    // Windows ACLs protect the file in packaged installs; chmod is best effort.
  }
}
