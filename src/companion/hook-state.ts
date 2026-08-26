import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
  leases: HookLeaseState[];
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
    leases: Array.isArray(value.leases) ? value.leases.map(parseLease) : [],
    quarantine: value.quarantine === undefined ? undefined : parseQuarantine(value.quarantine),
    openedAt: isoText(value.openedAt, "openedAt"),
    updatedAt: isoText(value.updatedAt, "updatedAt"),
  };
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
