import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const OPERATIONS_DIRECTORY = "integration-operations";
const MARKER_VERSION = 1 as const;
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_DRAIN_TIMEOUT_MS = 2 * 60_000;
const END_RETRY_ATTEMPTS = 3;
const END_RETRY_DELAY_MS = 10;

interface OperationMarker {
  version: typeof MARKER_VERSION;
  pid: number;
  connectionId: string;
  startedAt: string;
}

export interface IntegrationOperationHandle {
  end(): Promise<void>;
}

export interface IntegrationOperationDrainOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface IntegrationOperationTrackerOptions {
  removeMarker?: (markerPath: string) => Promise<void>;
}

export interface ConnectionOperationTracker {
  run<T>(connectionId: string, operation: () => Promise<T>): Promise<T>;
  drain(connectionId: string, options?: IntegrationOperationDrainOptions): Promise<void>;
  removeConnectionState(connectionId: string): Promise<void>;
}

/**
 * Cross-process operation markers close the race between a local gate check
 * and a remote mutation. Pausing first disables new work, then drain waits for
 * every operation that registered before the gate changed.
 */
export class IntegrationOperationTracker implements ConnectionOperationTracker {
  private readonly rootDirectory: string;
  private readonly removeMarker: (markerPath: string) => Promise<void>;

  constructor(userDataPath: string, options: IntegrationOperationTrackerOptions = {}) {
    this.rootDirectory = path.join(path.resolve(userDataPath), OPERATIONS_DIRECTORY);
    this.removeMarker = options.removeMarker ?? (async (markerPath) => {
      await rm(markerPath, { force: true });
    });
  }

  async begin(connectionId: string): Promise<IntegrationOperationHandle> {
    const normalizedId = requiredConnectionId(connectionId);
    const directory = this.connectionDirectory(normalizedId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await restrictPermissions(directory, 0o700);
    const markerPath = path.join(directory, `${process.pid}-${randomUUID()}.json`);
    const marker: OperationMarker = {
      version: MARKER_VERSION,
      pid: process.pid,
      connectionId: normalizedId,
      startedAt: new Date().toISOString(),
    };
    await writeFile(markerPath, `${JSON.stringify(marker)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await restrictPermissions(markerPath, 0o600);
    let ended = false;
    const removeMarker = this.removeMarker;
    return {
      async end() {
        if (ended) return;
        await removeMarker(markerPath);
        ended = true;
      },
    };
  }

  async run<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
    const handle = await this.begin(connectionId);
    try {
      return await operation();
    } finally {
      let lastError: unknown;
      for (let attempt = 1; attempt <= END_RETRY_ATTEMPTS; attempt += 1) {
        try {
          await handle.end();
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (attempt < END_RETRY_ATTEMPTS) await delay(END_RETRY_DELAY_MS);
        }
      }
      if (lastError !== undefined) throw lastError;
    }
  }

  async drain(
    connectionId: string,
    options: IntegrationOperationDrainOptions = {},
  ): Promise<void> {
    const normalizedId = requiredConnectionId(connectionId);
    const pollIntervalMs = positiveFinite(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "operation drain poll interval",
    );
    const timeoutMs = positiveFinite(
      options.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
      "operation drain timeout",
    );
    const isAlive = options.isProcessAlive ?? isProcessAlive;
    const directory = this.connectionDirectory(normalizedId);
    const deadline = Date.now() + timeoutMs;

    while (await this.hasActiveMarkers(directory, normalizedId, isAlive)) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Timed out after ${timeoutMs} ms while waiting for Agent Hub operations on connection ${normalizedId}.`,
        );
      }
      await delay(Math.min(pollIntervalMs, remainingMs));
    }
  }

  async removeConnectionState(connectionId: string): Promise<void> {
    const normalizedId = requiredConnectionId(connectionId);
    await rm(this.connectionDirectory(normalizedId), { recursive: true, force: true });
  }

  private async hasActiveMarkers(
    directory: string,
    connectionId: string,
    isAlive: (pid: number) => boolean,
  ): Promise<boolean> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
    let active = false;
    await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      const markerPath = path.join(directory, name);
      let marker: OperationMarker;
      try {
        marker = parseMarker(await readFile(markerPath, "utf8"));
      } catch {
        await rm(markerPath, { force: true });
        return;
      }
      if (marker.connectionId !== connectionId || !isAlive(marker.pid)) {
        await rm(markerPath, { force: true });
        return;
      }
      // A long-running operation remains authoritative while its process is
      // alive. Deleting it by age would let pause choose a cutoff too early.
      active = true;
    }));
    return active;
  }

  private connectionDirectory(connectionId: string): string {
    const key = createHash("sha256").update(connectionId).digest("hex");
    return path.join(this.rootDirectory, key);
  }
}

function parseMarker(raw: string): OperationMarker {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The integration operation marker is not valid JSON.");
  }
  if (!isRecord(value) || value.version !== MARKER_VERSION) {
    throw new Error("The integration operation marker uses an unsupported format.");
  }
  if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) {
    throw new Error("The integration operation marker PID is invalid.");
  }
  const connectionId = requiredConnectionId(value.connectionId);
  if (typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) {
    throw new Error("The integration operation marker timestamp is invalid.");
  }
  return {
    version: MARKER_VERSION,
    pid: Number(value.pid),
    connectionId,
    startedAt: new Date(value.startedAt).toISOString(),
  };
}

function requiredConnectionId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("An Agent Hub connection ID is required.");
  const normalized = value.trim();
  if (normalized.length > 256) throw new Error("The Agent Hub connection ID is too long.");
  return normalized;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`The ${label} must be positive.`);
  return value;
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function restrictPermissions(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // Windows ACLs are the effective protection in packaged installations.
  }
}
