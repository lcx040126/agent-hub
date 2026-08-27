import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AttributedPathEvidence } from "./turn-completion.js";

const SESSION_LOCKS_DIRECTORY = "codex-hook-session-locks";
const SESSION_LOCK_VERSION = 1 as const;
const SESSION_LOCK_POLL_INTERVAL_MS = 20;
const SESSION_LOCK_TIMEOUT_MS = 30_000;
const INVALID_SESSION_LOCK_GRACE_MS = 1_000;

interface SessionLockMarker {
  version: typeof SESSION_LOCK_VERSION;
  pid: number;
  token: string;
  startedAt: string;
}

export interface CodexHookStateLockOptions {
  timeoutMs?: number;
}

export class CodexHookStateLockTimeoutError extends Error {
  constructor(codexSessionId: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs} ms while waiting for Agent Hub state lock for Codex session ${codexSessionId}.`);
    this.name = "CodexHookStateLockTimeoutError";
  }
}

export interface HookLeaseState {
  id: string;
  paths: string[];
  expiresAt: string;
}

export interface HookQuarantineState {
  reason: string;
  paths: string[];
  detectedAt: string;
}

export interface HookProposedEditState {
  path: string;
  precision: "symbol" | "resource" | "path";
  symbols: string[];
  operation: "add" | "update" | "delete" | "move" | "unknown";
}

export interface HookPendingWriteState {
  proposalHash: string;
  toolName: string;
  proposedEdits: HookProposedEditState[];
  attributedSideEffects: boolean;
  baselineChangedPaths: string[];
  baselineChangedFingerprints: Record<string, string>;
  recordedAt: string;
}

export interface HookExternalChangeDiagnostic {
  paths: string[];
  detectedAt: string;
}

export interface HookPendingCompletionState {
  operationId: string;
  turnId: string;
  activityEpoch: number;
  phase: "awaiting_commit" | "stopped" | "resuming";
  recordedAt: string;
}

export interface CodexHookSessionState {
  version: 1;
  codexSessionId: string;
  connectionId: string;
  hubSessionId: string;
  finalizationId?: string;
  repositoryPath: string;
  branch: string;
  baseCommit: string;
  initialChangedPaths: string[];
  initialChangedFingerprints: Record<string, string>;
  observedChangedPaths: string[];
  observedChangedFingerprints: Record<string, string>;
  attributedChangedPaths?: string[];
  attributedPathsTruncated?: boolean;
  attributedPathEvidence?: AttributedPathEvidence[];
  activityEpoch?: number;
  currentTurnId?: string;
  pendingCompletion?: HookPendingCompletionState;
  leases: HookLeaseState[];
  /** false 表示本地状态曾丢失，服务端可能仍有本机尚未恢复的自动租约。 */
  leaseAttributionComplete?: boolean;
  pendingWrite?: HookPendingWriteState;
  externalChangeDiagnostics?: HookExternalChangeDiagnostic[];
  loadedFeatureVersions?: Record<string, string>;
  lastHeartbeatAt?: string;
  quarantine?: HookQuarantineState;
  openedAt: string;
  updatedAt: string;
}

export class CodexHookStateStore {
  readonly directory: string;
  private readonly locksDirectory: string;

  constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, "codex-hook-sessions");
    this.locksDirectory = path.join(userDataPath, SESSION_LOCKS_DIRECTORY);
  }

  async load(codexSessionId: string): Promise<CodexHookSessionState | undefined> {
    try {
      return parseState(await readFile(this.filePath(codexSessionId), "utf8"));
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async save(state: CodexHookSessionState): Promise<void> {
    await this.writeState(state, true);
  }

  /**
   * 同一个 Codex session 的 Stop、PreToolUse 与心跳都必须在这里串行化。
   * 进程内 Promise 锁无法覆盖独立 Hook 进程，因此使用原子创建的文件作为所有权凭据。
   */
  async runExclusive<T>(
    codexSessionId: string,
    operation: () => Promise<T>,
    options: CodexHookStateLockOptions = {},
  ): Promise<T> {
    const timeoutMs = positiveFinite(options.timeoutMs ?? SESSION_LOCK_TIMEOUT_MS, "Codex session lock timeout");
    const release = await this.acquireSessionLock(codexSessionId, timeoutMs);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  /**
   * 心跳只能延长服务器已经确认续租的 lease，不能把一次后台维护伪装成用户活动。
   * 锁内重读可避免用陈旧快照覆盖 Stop/PreToolUse 刚写入的 epoch、pendingCompletion 等字段。
   */
  async updateLeaseExpiries(
    codexSessionId: string,
    renewedLeases: Array<Pick<HookLeaseState, "id" | "expiresAt">>,
  ): Promise<CodexHookSessionState | undefined> {
    const normalizedRenewals = new Map(renewedLeases.map((lease) => [
      requiredText(lease.id, "lease ID"),
      isoText(lease.expiresAt, "lease expiry"),
    ]));
    return this.runExclusive(codexSessionId, async () => {
      const state = await this.load(codexSessionId);
      if (!state) return undefined;
      let changed = false;
      const leases = state.leases.map((lease) => {
        const expiresAt = normalizedRenewals.get(lease.id);
        if (!expiresAt || expiresAt === lease.expiresAt) return lease;
        changed = true;
        return { ...lease, expiresAt };
      });
      if (!changed) return state;
      const updated = { ...state, leases };
      await this.writeState(updated, false);
      return updated;
    });
  }

  private async writeState(state: CodexHookSessionState, touchUpdatedAt: boolean): Promise<void> {
    const parsed = parseState(JSON.stringify({
      ...state,
      updatedAt: touchUpdatedAt ? new Date().toISOString() : state.updatedAt,
    }));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await restrictPermissions(this.directory, 0o700);
    const destination = this.filePath(parsed.codexSessionId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, destination);
      await restrictPermissions(destination, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async remove(codexSessionId: string): Promise<void> {
    await unlink(this.filePath(codexSessionId)).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }

  async removeForConnection(connectionId: string): Promise<number> {
    return this.removeForConnections([connectionId]);
  }

  /** Remove only sessions owned by the selected saved room connections. */
  async removeForConnections(connectionIds: Iterable<string>): Promise<number> {
    const selected = new Set(
      [...connectionIds].map((connectionId) => requiredText(connectionId, "connection ID")),
    );
    if (selected.size === 0) return 0;

    let entries: Dirent[];
    try {
      entries = await readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return 0;
      throw error;
    }

    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.join(this.directory, entry.name);
      let state: CodexHookSessionState;
      try {
        state = parseState(await readFile(filePath, "utf8"));
      } catch (error) {
        // A malformed file cannot be attributed safely to a room. Leave it for
        // diagnostics instead of deleting unrelated local state.
        if (isMissingFile(error)) continue;
        continue;
      }
      if (!selected.has(state.connectionId)) continue;
      try {
        await unlink(filePath);
        removed += 1;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    return removed;
  }

  private filePath(codexSessionId: string): string {
    const key = createHash("sha256").update(requiredText(codexSessionId, "Codex session ID")).digest("hex");
    return path.join(this.directory, `${key}.json`);
  }

  private lockPath(codexSessionId: string): string {
    const key = createHash("sha256").update(requiredText(codexSessionId, "Codex session ID")).digest("hex");
    return path.join(this.locksDirectory, `${key}.lock`);
  }

  private async acquireSessionLock(
    codexSessionId: string,
    timeoutMs: number,
  ): Promise<() => Promise<void>> {
    await mkdir(this.locksDirectory, { recursive: true, mode: 0o700 });
    await restrictPermissions(this.locksDirectory, 0o700);
    const lockPath = this.lockPath(codexSessionId);
    const marker: SessionLockMarker = {
      version: SESSION_LOCK_VERSION,
      pid: process.pid,
      token: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    const deadline = Date.now() + timeoutMs;

    while (true) {
      try {
        await writeFile(lockPath, `${JSON.stringify(marker)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        });
        await restrictPermissions(lockPath, 0o600);
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        if (await canReclaimSessionLock(lockPath)) {
          await unlink(lockPath).catch((unlinkError: unknown) => {
            if (!isMissingFile(unlinkError)) throw unlinkError;
          });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new CodexHookStateLockTimeoutError(codexSessionId, timeoutMs);
        }
        await delay(SESSION_LOCK_POLL_INTERVAL_MS);
      }
    }

    return async () => {
      try {
        const current = parseSessionLock(await readFile(lockPath, "utf8"));
        // 只删除自己创建的锁，避免异常恢复期间误删后继进程刚取得的所有权。
        if (current.token === marker.token) await unlink(lockPath);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    };
  }
}

export function parseState(raw: string): CodexHookSessionState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The Agent Hub Codex hook state is not valid JSON.");
  }
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("The Agent Hub Codex hook state has an unsupported format.");
  }
  return {
    version: 1,
    codexSessionId: requiredText(value.codexSessionId, "Codex session ID"),
    connectionId: requiredText(value.connectionId, "connection ID"),
    hubSessionId: requiredText(value.hubSessionId, "Agent Hub session ID"),
    finalizationId: value.finalizationId === undefined
      ? undefined
      : requiredIdentifier(value.finalizationId, "finalization ID"),
    repositoryPath: path.resolve(requiredText(value.repositoryPath, "repository path")),
    branch: requiredText(value.branch, "branch"),
    baseCommit: requiredText(value.baseCommit, "base commit"),
    initialChangedPaths: stringArray(value.initialChangedPaths),
    initialChangedFingerprints: stringMap(value.initialChangedFingerprints),
    observedChangedPaths: stringArray(value.observedChangedPaths),
    observedChangedFingerprints: stringMap(value.observedChangedFingerprints),
    attributedChangedPaths: value.attributedChangedPaths === undefined
      ? undefined
      : stringArray(value.attributedChangedPaths),
    attributedPathsTruncated: value.attributedPathsTruncated === true,
    attributedPathEvidence: value.attributedPathEvidence === undefined
      ? undefined
      : parseAttributedPathEvidence(value.attributedPathEvidence),
    activityEpoch: value.activityEpoch === undefined
      ? 0
      : nonNegativeInteger(value.activityEpoch, "activity epoch"),
    currentTurnId: value.currentTurnId === undefined
      ? undefined
      : requiredText(value.currentTurnId, "current turn ID"),
    pendingCompletion: value.pendingCompletion === undefined
      ? undefined
      : parsePendingCompletion(value.pendingCompletion),
    leases: Array.isArray(value.leases) ? value.leases.map(parseLease) : [],
    leaseAttributionComplete: value.leaseAttributionComplete === undefined
      ? true
      : booleanValue(value.leaseAttributionComplete, "lease attribution completeness"),
    pendingWrite: value.pendingWrite === undefined ? undefined : parsePendingWrite(value.pendingWrite),
    externalChangeDiagnostics: value.externalChangeDiagnostics === undefined
      ? undefined
      : parseExternalDiagnostics(value.externalChangeDiagnostics),
    loadedFeatureVersions: value.loadedFeatureVersions === undefined
      ? undefined
      : stringMap(value.loadedFeatureVersions),
    lastHeartbeatAt: value.lastHeartbeatAt === undefined
      ? undefined
      : isoText(value.lastHeartbeatAt, "lastHeartbeatAt"),
    quarantine: value.quarantine === undefined ? undefined : parseQuarantine(value.quarantine),
    openedAt: isoText(value.openedAt, "openedAt"),
    updatedAt: isoText(value.updatedAt, "updatedAt"),
  };
}

function parseAttributedPathEvidence(value: unknown): AttributedPathEvidence[] {
  if (!Array.isArray(value)) throw new Error("The Agent Hub hook state contains invalid attributed path evidence.");
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error("The Agent Hub hook state contains invalid attributed path evidence.");
    return {
      path: requiredText(entry.path, "attributed evidence path"),
      baseEntry: nullableGitEntry(entry.baseEntry),
      attributedEntry: nullableGitEntry(entry.attributedEntry),
    };
  });
}

function parsePendingCompletion(value: unknown): HookPendingCompletionState {
  if (!isRecord(value)) throw new Error("The Agent Hub hook state contains an invalid pending completion.");
  const phase = requiredText(value.phase, "pending completion phase");
  if (phase !== "awaiting_commit" && phase !== "stopped" && phase !== "resuming") {
    throw new Error("The Agent Hub hook state contains an invalid pending completion phase.");
  }
  return {
    operationId: requiredIdentifier(value.operationId, "completion operation ID"),
    turnId: requiredText(value.turnId, "completion turn ID"),
    activityEpoch: nonNegativeInteger(value.activityEpoch, "completion activity epoch"),
    phase,
    recordedAt: isoText(value.recordedAt, "pending completion recordedAt"),
  };
}

function parsePendingWrite(value: unknown): HookPendingWriteState {
  if (!isRecord(value)) throw new Error("The Agent Hub hook state contains an invalid pending write.");
  if (!Array.isArray(value.proposedEdits)) throw new Error("The Agent Hub hook state contains invalid proposed edits.");
  return {
    proposalHash: requiredHash(value.proposalHash, "proposal hash"),
    toolName: requiredText(value.toolName, "tool name"),
    proposedEdits: value.proposedEdits.map(parseProposedEdit),
    attributedSideEffects: value.attributedSideEffects === true,
    baselineChangedPaths: stringArray(value.baselineChangedPaths),
    baselineChangedFingerprints: stringMap(value.baselineChangedFingerprints),
    recordedAt: isoText(value.recordedAt, "pending write recordedAt"),
  };
}

function parseProposedEdit(value: unknown): HookProposedEditState {
  if (!isRecord(value)) throw new Error("The Agent Hub hook state contains an invalid proposed edit.");
  const precision = requiredText(value.precision, "edit precision");
  const operation = requiredText(value.operation, "edit operation");
  if (!["symbol", "resource", "path"].includes(precision)) throw new Error("The Agent Hub hook state contains an invalid edit precision.");
  if (!["add", "update", "delete", "move", "unknown", "generate"].includes(operation)) throw new Error("The Agent Hub hook state contains an invalid edit operation.");
  return {
    path: requiredText(value.path, "edit path"),
    precision: precision as HookProposedEditState["precision"],
    symbols: stringArray(value.symbols),
    operation: operation === "generate" ? "unknown" : operation as HookProposedEditState["operation"],
  };
}

function parseExternalDiagnostics(value: unknown): HookExternalChangeDiagnostic[] {
  if (!Array.isArray(value)) throw new Error("The Agent Hub hook state contains invalid external change diagnostics.");
  return value.slice(-20).map((entry) => {
    if (!isRecord(entry)) throw new Error("The Agent Hub hook state contains an invalid external change diagnostic.");
    return {
      paths: stringArray(entry.paths),
      detectedAt: isoText(entry.detectedAt, "external change detectedAt"),
    };
  });
}

function parseQuarantine(value: unknown): HookQuarantineState {
  if (!isRecord(value)) throw new Error("The Agent Hub hook state contains an invalid quarantine.");
  return {
    reason: requiredText(value.reason, "quarantine reason"),
    paths: stringArray(value.paths),
    detectedAt: isoText(value.detectedAt, "quarantine detectedAt"),
  };
}

function parseLease(value: unknown): HookLeaseState {
  if (!isRecord(value)) throw new Error("The Agent Hub hook state contains an invalid lease.");
  return {
    id: requiredText(value.id, "lease ID"),
    paths: stringArray(value.paths),
    expiresAt: isoText(value.expiresAt, "lease expiry"),
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("The Agent Hub hook state contains an invalid path list.");
  }
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function stringMap(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("The Agent Hub hook state contains an invalid fingerprint map.");
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim() || typeof entry !== "string" || !entry.trim()) {
      throw new Error("The Agent Hub hook state contains an invalid fingerprint map.");
    }
    result[key.trim()] = entry.trim();
  }
  return result;
}

function nullableGitEntry(value: unknown): string | null {
  if (value === null) return null;
  const text = requiredText(value, "Git content entry");
  if (text === "missing" || /^blob:[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(text)) return text;
  throw new Error("The Agent Hub hook state contains an invalid Git content entry.");
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`The ${name} is invalid.`);
  return Number(value);
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`The ${name} is invalid.`);
  return value;
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`The ${name} must be positive.`);
  return value;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`The ${name} is required.`);
  return value.trim();
}

function requiredHash(value: unknown, name: string): string {
  const text = requiredText(value, name);
  if (!/^[a-f0-9]{64}$/i.test(text)) throw new Error(`The ${name} is invalid.`);
  return text.toLocaleLowerCase("en-US");
}

function requiredIdentifier(value: unknown, name: string): string {
  const text = requiredText(value, name);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(text)) throw new Error(`The ${name} is invalid.`);
  return text;
}

function isoText(value: unknown, name: string): string {
  const text = requiredText(value, name);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`The ${name} is not a valid timestamp.`);
  return text;
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

async function canReclaimSessionLock(lockPath: string): Promise<boolean> {
  try {
    const marker = parseSessionLock(await readFile(lockPath, "utf8"));
    return !isProcessAlive(marker.pid);
  } catch (error) {
    if (isMissingFile(error)) return false;
    // 写入所有权凭据存在极短窗口；只回收已稳定一段时间的损坏锁，避免抢走正在建立的锁。
    try {
      const metadata = await stat(lockPath);
      return Date.now() - metadata.mtimeMs >= INVALID_SESSION_LOCK_GRACE_MS;
    } catch (statError) {
      if (isMissingFile(statError)) return false;
      throw statError;
    }
  }
}

function parseSessionLock(raw: string): SessionLockMarker {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The Agent Hub Codex session lock is not valid JSON.");
  }
  if (!isRecord(value) || value.version !== SESSION_LOCK_VERSION) {
    throw new Error("The Agent Hub Codex session lock has an unsupported format.");
  }
  if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) {
    throw new Error("The Agent Hub Codex session lock PID is invalid.");
  }
  return {
    version: SESSION_LOCK_VERSION,
    pid: Number(value.pid),
    token: requiredIdentifier(value.token, "Codex session lock token"),
    startedAt: isoText(value.startedAt, "Codex session lock startedAt"),
  };
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

async function restrictPermissions(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // Windows access is primarily controlled by the owning user profile.
  }
}
