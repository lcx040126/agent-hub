import { createHash } from "node:crypto";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type UpdateState = "idle" | "checking" | "available" | "downloading" | "staged" | "failed";

export interface UpdateManifest {
  version: string;
  protocolVersion: number;
  schemaVersion: number;
  packageUrl: string;
  sha256: string;
  sizeBytes?: number;
  notes?: string;
}

export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  availableVersion?: string;
  protocolVersion: number;
  schemaVersion: number;
  checkedAt?: string;
  stagedPath?: string;
  error?: string;
}

export interface UpdateCoordinatorOptions {
  currentVersion?: string;
  protocolVersion?: number;
  schemaVersion?: number;
  manifestUrl?: string;
  stagingDirectory: string;
  databasePath?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;

export class UpdateCoordinator {
  private readonly currentVersion: string;
  private readonly protocolVersion: number;
  private readonly schemaVersion: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private manifest: UpdateManifest | undefined;
  private status: UpdateStatus;

  constructor(private readonly options: UpdateCoordinatorOptions) {
    this.currentVersion = options.currentVersion ?? "0.1.0";
    this.protocolVersion = options.protocolVersion ?? 1;
    this.schemaVersion = options.schemaVersion ?? 2;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.status = {
      state: "idle",
      currentVersion: this.currentVersion,
      protocolVersion: this.protocolVersion,
      schemaVersion: this.schemaVersion,
    };
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  async check(): Promise<UpdateStatus> {
    if (!this.options.manifestUrl) return this.fail("No update manifest URL is configured.");
    this.status = { ...this.status, state: "checking", error: undefined };
    try {
      const response = await this.fetchImpl(this.normalizeUrl(this.options.manifestUrl), {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Update manifest returned HTTP ${response.status}.`);
      const manifest = parseManifest(await response.json());
      this.manifest = manifest;
      const newer = compareVersions(manifest.version, this.currentVersion) > 0;
      this.status = {
        ...this.status,
        state: newer ? "available" : "idle",
        availableVersion: newer ? manifest.version : undefined,
        checkedAt: this.now().toISOString(),
        error: undefined,
      };
      return this.getStatus();
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  async stage(): Promise<UpdateStatus> {
    const manifest = this.manifest;
    if (!manifest || this.status.state !== "available") throw new Error("Check for an available update before staging it.");
    this.status = { ...this.status, state: "downloading", error: undefined };
    try {
      const response = await this.fetchImpl(this.normalizeUrl(manifest.packageUrl), {
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`Update package returned HTTP ${response.status}.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_PACKAGE_BYTES || (manifest.sizeBytes !== undefined && bytes.byteLength !== manifest.sizeBytes)) {
        throw new Error("The update package size does not match the manifest.");
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== manifest.sha256) throw new Error("The update package SHA-256 does not match the manifest.");
      await mkdir(this.options.stagingDirectory, { recursive: true });
      const target = path.join(this.options.stagingDirectory, `agent-hub-${manifest.version}.mjs`);
      const temporary = `${target}.tmp`;
      await writeFile(temporary, bytes);
      await rename(temporary, target);
      this.status = { ...this.status, state: "staged", stagedPath: target, error: undefined };
      return this.getStatus();
    } catch (error) {
      return this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  async backupDatabase(): Promise<string | undefined> {
    const databasePath = this.options.databasePath;
    if (!databasePath || databasePath === ":memory:") return undefined;
    await stat(databasePath);
    const backupDirectory = path.join(this.options.stagingDirectory, "backups");
    await mkdir(backupDirectory, { recursive: true });
    const target = path.join(backupDirectory, `agent-hub-${this.now().toISOString().replace(/[:.]/g, "-")}.sqlite`);
    await copyFile(databasePath, target);
    return target;
  }

  async clearStaged(): Promise<void> {
    if (this.status.stagedPath) await rm(this.status.stagedPath, { force: true });
    this.status = { ...this.status, state: "idle", stagedPath: undefined };
  }

  private fail(error: string): UpdateStatus {
    this.status = { ...this.status, state: "failed", error, checkedAt: this.now().toISOString() };
    return this.getStatus();
  }

  private normalizeUrl(value: string): string {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Update URLs must use HTTP or HTTPS.");
    if (url.username || url.password || url.hash) throw new Error("Update URLs cannot contain credentials or fragments.");
    return url.toString();
  }
}

function parseManifest(value: unknown): UpdateManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The update manifest is invalid.");
  const input = value as Record<string, unknown>;
  const version = text(input.version, "version", 80);
  const packageUrl = text(input.packageUrl, "packageUrl", 2048);
  const sha256 = text(input.sha256, "sha256", 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("The update manifest SHA-256 is invalid.");
  const protocolVersion = integer(input.protocolVersion, "protocolVersion");
  const schemaVersion = integer(input.schemaVersion, "schemaVersion");
  const sizeBytes = input.sizeBytes === undefined ? undefined : integer(input.sizeBytes, "sizeBytes");
  if (sizeBytes !== undefined && (sizeBytes < 1 || sizeBytes > MAX_PACKAGE_BYTES)) throw new Error("The update manifest size is invalid.");
  return { version, protocolVersion, schemaVersion, packageUrl, sha256, sizeBytes, notes: typeof input.notes === "string" ? input.notes.slice(0, 4000) : undefined };
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`The update manifest ${name} is invalid.`);
  return value.trim();
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`The update manifest ${name} is invalid.`);
  return value;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((item) => Number.parseInt(item, 10) || 0);
  const b = right.split(".").map((item) => Number.parseInt(item, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}
