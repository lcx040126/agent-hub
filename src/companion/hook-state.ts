import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

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

export interface CodexHookSessionState {
  version: 1;
  codexSessionId: string;
  connectionId: string;
  hubSessionId: string;
  repositoryPath: string;
  branch: string;
  baseCommit: string;
  initialChangedPaths: string[];
  initialChangedFingerprints: Record<string, string>;
  observedChangedPaths: string[];
  observedChangedFingerprints: Record<string, string>;
  attributedChangedPaths?: string[];
  attributedPathsTruncated?: boolean;
  leases: HookLeaseState[];
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

  constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, "codex-hook-sessions");
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
    const parsed = parseState(JSON.stringify({ ...state, updatedAt: new Date().toISOString() }));
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
    leases: Array.isArray(value.leases) ? value.leases.map(parseLease) : [],
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

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`The ${name} is required.`);
  return value.trim();
}

function requiredHash(value: unknown, name: string): string {
  const text = requiredText(value, name);
  if (!/^[a-f0-9]{64}$/i.test(text)) throw new Error(`The ${name} is invalid.`);
  return text.toLocaleLowerCase("en-US");
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

async function restrictPermissions(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // Windows access is primarily controlled by the owning user profile.
  }
}
