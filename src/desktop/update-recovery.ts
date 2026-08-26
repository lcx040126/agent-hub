import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { DesktopUpdateManifest } from "./update-manifest.js";
import { compareStableVersions } from "./update-manifest.js";

const RECOVERY_STATE_VERSION = 1;

export interface UpdateBackupFile {
  sourcePath: string;
  relativeName: string;
  restorePath?: string;
  required?: boolean;
  removeSourceAfterCopy?: boolean;
}

export interface PrepareUpdateRecoveryInput {
  currentVersion: string;
  manifest: DesktopUpdateManifest;
  manifestSha256: string;
  installerPath: string;
  backupFiles?: UpdateBackupFile[];
  applicationDirectory?: string;
  applicationExecutablePath?: string;
  restoreRootDirectory?: string;
}

export interface PreparedUpdateRecovery {
  targetVersion: string;
  installerPath: string;
  backupDirectory?: string;
  applicationBackupDirectory?: string;
  previousInstallerPath?: string;
}

export interface UpdateRestoreFile {
  backupPath: string;
  restorePath: string;
}

export interface PendingRecoveryPlan {
  fromVersion: string;
  targetVersion: string;
  backupDirectory?: string;
  rollbackInstallerPath?: string;
  attemptedInstallerPath: string;
  applicationDirectory?: string;
  applicationBackupDirectory?: string;
  applicationExecutablePath?: string;
  restoreRootDirectory?: string;
  restoreFiles: UpdateRestoreFile[];
  preparedAt: string;
}

export interface DesktopUpdateRecovery {
  getHighestSeenVersion(): Promise<string | undefined>;
  getHighestSeenManifestSha256(): Promise<string | undefined>;
  recordHighestSeenVersion(version: string, manifestSha256: string): Promise<void>;
  prepare(input: PrepareUpdateRecoveryInput): Promise<PreparedUpdateRecovery>;
  markStartupHealthy(currentVersion: string): Promise<void>;
  markPendingFailed(error: string): Promise<void>;
  abandonPending(): Promise<void>;
  getPendingRecoveryPlan(): Promise<PendingRecoveryPlan | undefined>;
  getLastResult(): Promise<UpdateRecoveryResult | undefined>;
}

export interface DesktopUpdateRecoveryExecutor {
  arm(plan: PendingRecoveryPlan, options?: ArmUpdateRecoveryOptions): Promise<void>;
  disarm(healthyVersion: string): Promise<void>;
}

export interface ArmUpdateRecoveryOptions {
  replaceExisting?: boolean;
  timeoutSeconds?: number;
}

interface SuccessfulPackage {
  version: string;
  installerPath: string;
  manifestSha256: string;
  acceptedAt: string;
}

interface PendingUpdate {
  fromVersion: string;
  targetVersion: string;
  installerPath: string;
  manifestSha256: string;
  backupDirectory?: string;
  applicationBackupDirectory?: string;
  applicationDirectory?: string;
  applicationExecutablePath?: string;
  restoreRootDirectory?: string;
  restoreFiles?: UpdateRestoreFile[];
  preparedAt: string;
}

export interface UpdateRecoveryResult {
  status: "success" | "failed";
  version: string;
  at: string;
  error?: string;
}

interface RetainedRecoveryBackup {
  version: string;
  backupDirectory?: string;
  applicationBackupDirectory?: string;
}

interface RecoveryState {
  formatVersion: 1;
  highestSeenVersion?: string;
  highestSeenManifestSha256?: string;
  lastSuccessfulPackage?: SuccessfulPackage;
  retainedRecoveryBackup?: RetainedRecoveryBackup;
  pending?: PendingUpdate;
  lastResult?: UpdateRecoveryResult;
}

export class FileDesktopUpdateRecovery implements DesktopUpdateRecovery {
  private readonly statePath: string;
  private readonly packageDirectory: string;
  private readonly backupRoot: string;

  constructor(private readonly rootDirectory: string, private readonly now = () => new Date()) {
    this.statePath = path.join(rootDirectory, "state.json");
    this.packageDirectory = path.join(rootDirectory, "packages");
    this.backupRoot = path.join(rootDirectory, "backups");
  }

  async getHighestSeenVersion(): Promise<string | undefined> {
    return (await this.readState()).highestSeenVersion;
  }

  async getHighestSeenManifestSha256(): Promise<string | undefined> {
    return (await this.readState()).highestSeenManifestSha256;
  }

  async recordHighestSeenVersion(version: string, manifestSha256: string): Promise<void> {
    const state = await this.readState();
    if (state.highestSeenVersion) {
      const comparison = compareStableVersions(version, state.highestSeenVersion);
      if (comparison < 0) return;
      if (comparison === 0) {
        if (
          state.highestSeenManifestSha256
          && state.highestSeenManifestSha256 !== manifestSha256
        ) {
          throw new Error("A different signed manifest was already accepted for this release version.");
        }
        if (state.highestSeenManifestSha256) return;
      }
    }
    state.highestSeenVersion = version;
    state.highestSeenManifestSha256 = requiredSha256(manifestSha256);
    await this.writeState(state);
  }

  async prepare(input: PrepareUpdateRecoveryInput): Promise<PreparedUpdateRecovery> {
    const state = await this.readState();
    if (state.pending) {
      throw new Error(
        `An Agent Hub update to ${state.pending.targetVersion} is already pending recovery confirmation.`,
      );
    }
    if (compareStableVersions(input.manifest.version, input.currentVersion) <= 0) {
      throw new Error("Only a newer verified version can be prepared for installation.");
    }

    const installer = await stat(input.installerPath);
    if (!installer.isFile()) throw new Error("The verified update installer no longer exists.");
    const targetPackageDirectory = path.join(this.packageDirectory, input.manifest.version);
    await mkdir(targetPackageDirectory, { recursive: true });
    const cachedInstallerPath = path.join(targetPackageDirectory, input.manifest.asset.fileName);
    const temporaryInstallerPath = `${cachedInstallerPath}.${randomUUID()}.tmp`;
    await copyFile(input.installerPath, temporaryInstallerPath);
    await rename(temporaryInstallerPath, cachedInstallerPath);

    const recoveryDirectory = path.join(
      this.backupRoot,
      `${this.now().toISOString().replace(/[:.]/g, "-")}-${input.manifest.version}-${randomUUID()}`,
    );
    let backupDirectory: string | undefined;
    let applicationBackupDirectory: string | undefined;
    let restoreFiles: UpdateRestoreFile[] = [];
    try {
      await verifyCachedInstaller(cachedInstallerPath, input.manifest.asset);
      if ((input.backupFiles?.length ?? 0) > 0 || input.applicationDirectory) {
        await mkdir(recoveryDirectory, { recursive: true });
        backupDirectory = recoveryDirectory;
      }
      restoreFiles = await this.backupFiles(input.backupFiles ?? [], recoveryDirectory);
      if (restoreFiles.length > 0) {
        if (!input.restoreRootDirectory) {
          throw new Error("A managed data directory is required for update recovery files.");
        }
        for (const file of restoreFiles) {
          assertPathInside(file.restorePath, input.restoreRootDirectory, "update recovery target");
        }
      }
      if (input.applicationDirectory || input.applicationExecutablePath) {
        if (!input.applicationDirectory || !input.applicationExecutablePath) {
          throw new Error("Both the application directory and executable are required for update recovery.");
        }
        applicationBackupDirectory = path.join(recoveryDirectory, "application");
        await backupApplication(
          input.applicationDirectory,
          input.applicationExecutablePath,
          applicationBackupDirectory,
        );
      }
      if ((input.backupFiles?.length ?? 0) === 0 && !applicationBackupDirectory && backupDirectory) {
        await rm(backupDirectory, { recursive: true, force: true });
        backupDirectory = undefined;
      }
      const preparedAt = this.now().toISOString();
      state.pending = {
        fromVersion: input.currentVersion,
        targetVersion: input.manifest.version,
        installerPath: cachedInstallerPath,
        manifestSha256: input.manifestSha256,
        backupDirectory,
        applicationBackupDirectory,
        applicationDirectory: input.applicationDirectory,
        applicationExecutablePath: input.applicationExecutablePath,
        restoreRootDirectory: input.restoreRootDirectory,
        restoreFiles,
        preparedAt,
      };
      if (
        !state.highestSeenVersion
        || compareStableVersions(input.manifest.version, state.highestSeenVersion) > 0
      ) {
        state.highestSeenVersion = input.manifest.version;
        state.highestSeenManifestSha256 = requiredSha256(input.manifestSha256);
      }
      await this.writeState(state);
      return {
        targetVersion: input.manifest.version,
        installerPath: cachedInstallerPath,
        backupDirectory,
        applicationBackupDirectory,
        previousInstallerPath: state.lastSuccessfulPackage?.installerPath,
      };
    } catch (error) {
      await rm(targetPackageDirectory, { recursive: true, force: true });
      await rm(recoveryDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async markStartupHealthy(currentVersion: string): Promise<void> {
    const state = await this.readState();
    const pending = state.pending;
    if (!pending || pending.targetVersion !== currentVersion) return;

    const previous = state.lastSuccessfulPackage;
    const previousRecoveryBackup = state.retainedRecoveryBackup;
    state.lastSuccessfulPackage = {
      version: pending.targetVersion,
      installerPath: pending.installerPath,
      manifestSha256: pending.manifestSha256,
      acceptedAt: this.now().toISOString(),
    };
    state.retainedRecoveryBackup = pending.backupDirectory
      ? {
          version: pending.fromVersion,
          backupDirectory: pending.backupDirectory,
          applicationBackupDirectory: pending.applicationBackupDirectory,
        }
      : undefined;
    state.pending = undefined;
    state.lastResult = {
      status: "success",
      version: currentVersion,
      at: this.now().toISOString(),
    };
    await this.writeState(state);

    if (previous && previous.installerPath !== pending.installerPath) {
      const previousPackageDirectory = managedParent(previous.installerPath, this.packageDirectory);
      await rm(previousPackageDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (
      previousRecoveryBackup?.backupDirectory
      && previousRecoveryBackup.backupDirectory !== pending.backupDirectory
    ) {
      const backupDirectory = managedPath(previousRecoveryBackup.backupDirectory, this.backupRoot);
      await rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async markPendingFailed(error: string): Promise<void> {
    const state = await this.readState();
    if (!state.pending) return;
    state.lastResult = {
      status: "failed",
      version: state.pending.targetVersion,
      at: this.now().toISOString(),
      error: error.slice(0, 2_000),
    };
    await this.writeState(state);
  }

  async abandonPending(): Promise<void> {
    const state = await this.readState();
    const pending = state.pending;
    if (!pending) return;
    state.pending = undefined;
    await this.writeState(state);
    const packageDirectory = managedParent(pending.installerPath, this.packageDirectory);
    await rm(packageDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (pending.backupDirectory) {
      const backupDirectory = managedPath(pending.backupDirectory, this.backupRoot);
      await rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async getPendingRecoveryPlan(): Promise<PendingRecoveryPlan | undefined> {
    const state = await this.readState();
    if (!state.pending) return undefined;
    return {
      fromVersion: state.pending.fromVersion,
      targetVersion: state.pending.targetVersion,
      backupDirectory: state.pending.backupDirectory
        ? managedPath(state.pending.backupDirectory, this.backupRoot)
        : undefined,
      rollbackInstallerPath: state.lastSuccessfulPackage?.installerPath
        ? managedFile(state.lastSuccessfulPackage.installerPath, this.packageDirectory)
        : undefined,
      attemptedInstallerPath: managedFile(state.pending.installerPath, this.packageDirectory),
      applicationDirectory: state.pending.applicationDirectory
        ? safeApplicationDirectory(state.pending.applicationDirectory)
        : undefined,
      applicationBackupDirectory: state.pending.applicationBackupDirectory
        ? managedPath(state.pending.applicationBackupDirectory, this.backupRoot)
        : undefined,
      applicationExecutablePath: state.pending.applicationExecutablePath
        ? safeApplicationExecutable(
            state.pending.applicationExecutablePath,
            state.pending.applicationDirectory,
          )
        : undefined,
      restoreRootDirectory: state.pending.restoreRootDirectory
        ? safeRestoreRoot(state.pending.restoreRootDirectory)
        : undefined,
      restoreFiles: (state.pending.restoreFiles ?? []).map((file) => ({
        backupPath: managedFile(file.backupPath, this.backupRoot),
        restorePath: safeManagedRestorePath(
          file.restorePath,
          state.pending?.restoreRootDirectory,
        ),
      })),
      preparedAt: state.pending.preparedAt,
    };
  }

  async getLastResult(): Promise<UpdateRecoveryResult | undefined> {
    const result = (await this.readState()).lastResult;
    return result ? { ...result } : undefined;
  }

  private async backupFiles(
    files: UpdateBackupFile[],
    backupDirectory: string,
  ): Promise<UpdateRestoreFile[]> {
    const restoreFiles: UpdateRestoreFile[] = [];
    for (const file of files) {
      try {
        const relativeName = safeRelativeName(file.relativeName);
        let source: Awaited<ReturnType<typeof stat>>;
        try {
          source = await stat(file.sourcePath);
        } catch (error) {
          if (file.required) throw error;
          continue;
        }
        if (!source.isFile()) {
          if (file.required) throw new Error(`Required update backup source is not a file: ${file.relativeName}`);
          continue;
        }
        const target = path.join(backupDirectory, relativeName);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(file.sourcePath, target);
        if (file.restorePath) {
          restoreFiles.push({
            backupPath: target,
            restorePath: safeRestorePath(file.restorePath),
          });
        }
      } finally {
        if (file.removeSourceAfterCopy) await rm(file.sourcePath, { force: true }).catch(() => undefined);
      }
    }
    return restoreFiles;
  }

  private async readState(): Promise<RecoveryState> {
    let text: string;
    try {
      text = await readFile(this.statePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return { formatVersion: RECOVERY_STATE_VERSION };
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("The Agent Hub update recovery state is corrupted.");
    }
    return parseRecoveryState(value);
  }

  private async writeState(state: RecoveryState): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    const temporaryPath = `${this.statePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.statePath);
  }
}

function parseRecoveryState(value: unknown): RecoveryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Agent Hub update recovery state is invalid.");
  }
  const input = value as Partial<RecoveryState>;
  if (input.formatVersion !== RECOVERY_STATE_VERSION) {
    throw new Error("The Agent Hub update recovery state version is not supported.");
  }
  return input as RecoveryState;
}

function safeRelativeName(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("An update backup path is invalid.");
  }
  return normalized;
}

async function backupApplication(
  applicationDirectory: string,
  executablePath: string,
  backupDirectory: string,
): Promise<void> {
  const sourceDirectory = safeApplicationDirectory(applicationDirectory);
  const sourceExecutable = safeApplicationExecutable(executablePath, sourceDirectory);
  const [directoryDetails, executableDetails] = await Promise.all([
    stat(sourceDirectory),
    stat(sourceExecutable),
  ]);
  if (!directoryDetails.isDirectory() || !executableDetails.isFile()) {
    throw new Error("The installed Agent Hub application cannot be backed up for recovery.");
  }
  await cp(sourceDirectory, backupDirectory, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
  });
  const relativeExecutable = path.relative(sourceDirectory, sourceExecutable);
  const copiedExecutable = path.join(backupDirectory, relativeExecutable);
  if (!(await stat(copiedExecutable)).isFile()) {
    throw new Error("The Agent Hub recovery backup does not contain the application executable.");
  }
}

function safeApplicationDirectory(value: string): string {
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new Error("The Agent Hub application recovery directory is unsafe.");
  }
  return resolved;
}

function safeApplicationExecutable(value: string, applicationDirectory?: string): string {
  if (!applicationDirectory) throw new Error("The Agent Hub application recovery directory is missing.");
  const directory = safeApplicationDirectory(applicationDirectory);
  const executable = path.resolve(value);
  assertPathInside(executable, directory, "Agent Hub executable");
  if (path.extname(executable).toLowerCase() !== ".exe") {
    throw new Error("The Agent Hub recovery executable is invalid.");
  }
  return executable;
}

function safeRestoreRoot(value: string): string {
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new Error("The update recovery data directory is unsafe.");
  }
  return resolved;
}

function safeRestorePath(value: string): string {
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new Error("An update recovery target path is unsafe.");
  }
  return resolved;
}

function safeManagedRestorePath(value: string, rootDirectory?: string): string {
  if (!rootDirectory) throw new Error("The update recovery data directory is missing.");
  const restored = safeRestorePath(value);
  assertPathInside(restored, safeRestoreRoot(rootDirectory), "update recovery target");
  return restored;
}

function assertPathInside(candidate: string, rootDirectory: string, name: string): void {
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`The ${name} must stay inside its managed directory.`);
  }
}

function managedParent(filePath: string, rootDirectory: string): string {
  return managedPath(path.dirname(filePath), rootDirectory);
}

function managedFile(filePath: string, rootDirectory: string): string {
  return managedPath(filePath, rootDirectory);
}

function managedPath(candidate: string, rootDirectory: string): string {
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The update recovery state references a path outside its managed directory.");
  }
  return resolved;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function verifyCachedInstaller(
  installerPath: string,
  expected: { sizeBytes: number; sha256: string },
): Promise<void> {
  const details = await stat(installerPath);
  if (!details.isFile() || details.size !== expected.sizeBytes) {
    throw new Error("The cached recovery installer size changed before update preparation.");
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(installerPath)) digest.update(chunk as Buffer);
  if (digest.digest("hex") !== expected.sha256) {
    throw new Error("The cached recovery installer hash changed before update preparation.");
  }
}

function requiredSha256(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error("The update manifest SHA-256 is invalid.");
  return normalized;
}
