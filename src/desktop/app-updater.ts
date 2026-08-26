import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_HUB_PROTOCOL_VERSION,
  AGENT_HUB_SCHEMA_VERSION,
  AGENT_HUB_VERSION,
} from "../shared/version.js";
import type { DesktopUpdateStatus } from "./contracts.js";
import {
  compareStableVersions,
  loadSignedDesktopUpdateManifest,
  type VerifiedDesktopUpdateManifest,
} from "./update-manifest.js";
import type {
  DesktopUpdateRecovery,
  DesktopUpdateRecoveryExecutor,
  UpdateBackupFile,
} from "./update-recovery.js";

export interface ElectronUpdateCheckResult {
  isUpdateAvailable: boolean;
  updateInfo: {
    version: string;
    files?: Array<{ url: string; size?: number }>;
  };
}

export interface ElectronUpdateEngine {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  checkForUpdates(): Promise<ElectronUpdateCheckResult | null>;
  downloadUpdate(): Promise<string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (value: any) => void): unknown;
  removeListener?(event: string, listener: (value: any) => void): unknown;
}

export interface DesktopUpdateInstallHooks {
  prepareForInstall?(): Promise<UpdateBackupFile[]>;
  onInstallLaunching?(): void;
  onInstallAborted?(error: Error): Promise<void> | void;
}

export interface DesktopAppUpdaterOptions {
  engine: ElectronUpdateEngine;
  recovery: DesktopUpdateRecovery;
  enabled: boolean;
  currentVersion?: string;
  protocolVersion?: number;
  schemaVersion?: number;
  manifestLoader?: (highestSeenVersion?: string) => Promise<VerifiedDesktopUpdateManifest>;
  installHooks?: DesktopUpdateInstallHooks;
  recoveryApplication?: {
    applicationDirectory: string;
    applicationExecutablePath: string;
    restoreRootDirectory: string;
  };
  recoveryExecutor?: DesktopUpdateRecoveryExecutor;
  recoveryDisarmTimeoutMs?: number;
  now?: () => Date;
}

type StatusListener = (status: DesktopUpdateStatus) => void;

export class DesktopAppUpdater {
  private readonly currentVersion: string;
  private readonly now: () => Date;
  private readonly listeners = new Set<StatusListener>();
  private readonly progressListener: (value: any) => void;
  private readonly engineErrorListener: (value: any) => void;
  private verifiedManifest: VerifiedDesktopUpdateManifest | undefined;
  private downloadedInstallerPath: string | undefined;
  private automaticCheckTimer: NodeJS.Timeout | undefined;
  private periodicCheckTimer: NodeJS.Timeout | undefined;
  private installAbortPromise: Promise<void> | undefined;
  private installLaunchError: Error | undefined;
  private installRecoveryPrepared = false;
  private installRecoveryArmed = false;
  private busy = false;
  private status: DesktopUpdateStatus;

  constructor(private readonly options: DesktopAppUpdaterOptions) {
    this.currentVersion = options.currentVersion ?? AGENT_HUB_VERSION;
    this.now = options.now ?? (() => new Date());
    this.status = {
      phase: options.enabled ? "idle" : "disabled",
      currentVersion: this.currentVersion,
      canRetry: options.enabled,
      error: options.enabled
        ? undefined
        : "Automatic updates are available only in the installed Agent Hub Setup edition.",
    };
    options.engine.autoDownload = false;
    options.engine.autoInstallOnAppQuit = false;
    options.engine.allowPrerelease = false;
    options.engine.allowDowngrade = false;
    this.progressListener = (value: unknown) => this.handleProgress(value);
    this.engineErrorListener = (value: unknown) => this.handleEngineError(value);
    options.engine.on("download-progress", this.progressListener);
    options.engine.on("error", this.engineErrorListener);
  }

  getStatus(): DesktopUpdateStatus {
    return { ...this.status };
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.getStatus());
    return () => this.listeners.delete(listener);
  }

  startAutomaticChecks(initialDelayMs = 15_000, intervalMs = 6 * 60 * 60 * 1_000): void {
    if (!this.options.enabled || this.automaticCheckTimer || this.periodicCheckTimer) return;
    this.automaticCheckTimer = setTimeout(() => {
      this.automaticCheckTimer = undefined;
      this.runAutomaticCheck();
      this.periodicCheckTimer = setInterval(() => {
        this.runAutomaticCheck();
      }, intervalMs);
      this.periodicCheckTimer.unref?.();
    }, initialDelayMs);
    this.automaticCheckTimer.unref?.();
  }

  dispose(): void {
    if (this.automaticCheckTimer) clearTimeout(this.automaticCheckTimer);
    if (this.periodicCheckTimer) clearInterval(this.periodicCheckTimer);
    this.automaticCheckTimer = undefined;
    this.periodicCheckTimer = undefined;
    this.options.engine.removeListener?.("download-progress", this.progressListener);
    this.options.engine.removeListener?.("error", this.engineErrorListener);
    this.listeners.clear();
  }

  async markCurrentStartupHealthy(): Promise<void> {
    // Commit recovery state first. If it fails, the watchdog remains armed and can
    // still restore the previous version instead of accepting a half-confirmed start.
    await this.options.recovery.markStartupHealthy(this.currentVersion);
    await this.options.recoveryExecutor?.disarm(this.currentVersion);
    const result = await this.options.recovery.getLastResult();
    if (result?.status === "failed") {
      this.setStatus({
        phase: "failed",
        currentVersion: this.currentVersion,
        availableVersion: result.version,
        checkedAt: result.at,
        error: result.error
          ?? `Agent Hub ${result.version} did not start correctly. Version ${this.currentVersion} was restored.`,
        canRetry: true,
      });
    }
  }

  async check(): Promise<DesktopUpdateStatus> {
    this.assertEnabled();
    this.assertNotBusy("check for updates");
    this.busy = true;
    this.setStatus({
      phase: "checking",
      currentVersion: this.currentVersion,
      canRetry: false,
    });
    try {
      const highestSeenVersion = await this.options.recovery.getHighestSeenVersion();
      const highestSeenManifestSha256 = await this.options.recovery.getHighestSeenManifestSha256();
      const verified = await (this.options.manifestLoader
        ? this.options.manifestLoader(highestSeenVersion)
        : loadSignedDesktopUpdateManifest({
            currentVersion: this.currentVersion,
            currentProtocolVersion: this.options.protocolVersion ?? AGENT_HUB_PROTOCOL_VERSION,
            currentSchemaVersion: this.options.schemaVersion ?? AGENT_HUB_SCHEMA_VERSION,
            highestSeenVersion,
          }));
      if (
        highestSeenVersion === verified.manifest.version
        && highestSeenManifestSha256
        && highestSeenManifestSha256 !== verified.manifestSha256
      ) {
        throw new Error("A different signed manifest was already accepted for this release version.");
      }
      await this.options.recovery.recordHighestSeenVersion(
        verified.manifest.version,
        verified.manifestSha256,
      );
      this.verifiedManifest = verified;
      this.downloadedInstallerPath = undefined;

      if (compareStableVersions(verified.manifest.version, this.currentVersion) === 0) {
        this.setStatus({
          phase: "up-to-date",
          currentVersion: this.currentVersion,
          checkedAt: this.now().toISOString(),
          canRetry: true,
        });
        return this.getStatus();
      }

      const result = await this.options.engine.checkForUpdates();
      if (!result?.isUpdateAvailable) {
        throw new Error("GitHub advertises an update, but the installer feed does not contain it.");
      }
      if (result.updateInfo.version !== verified.manifest.version) {
        throw new Error("The signed manifest and installer feed refer to different versions.");
      }
      const feedAsset = result.updateInfo.files?.find(
        (file) => feedAssetName(file.url) === verified.manifest.asset.fileName,
      );
      if (!feedAsset) {
        throw new Error("The installer feed does not contain the asset named by the signed manifest.");
      }
      if (
        feedAsset.size !== undefined
        && feedAsset.size !== verified.manifest.asset.sizeBytes
      ) {
        throw new Error("The signed manifest and installer feed report different installer sizes.");
      }
      this.setStatus({
        phase: "available",
        currentVersion: this.currentVersion,
        availableVersion: verified.manifest.version,
        publishedAt: verified.manifest.publishedAt,
        notes: verified.manifest.notes,
        sizeBytes: verified.manifest.asset.sizeBytes,
        checkedAt: this.now().toISOString(),
        canRetry: true,
      });
      return this.getStatus();
    } catch (error) {
      throw this.fail(error);
    } finally {
      this.busy = false;
    }
  }

  async download(): Promise<DesktopUpdateStatus> {
    this.assertEnabled();
    this.assertNotBusy("download an update");
    const verified = this.verifiedManifest;
    if (!verified || this.status.phase !== "available") {
      throw new Error("Check for a verified update before downloading it.");
    }
    this.busy = true;
    this.setStatus({
      ...this.status,
      phase: "downloading",
      progressPercent: 0,
      transferredBytes: 0,
      bytesPerSecond: 0,
      canRetry: false,
      error: undefined,
    });
    try {
      const downloadedPaths = await this.options.engine.downloadUpdate();
      const installerPath = selectInstallerPath(downloadedPaths, verified.manifest.asset.fileName);
      await verifyInstallerFile(installerPath, {
        sizeBytes: verified.manifest.asset.sizeBytes,
        sha256: verified.manifest.asset.sha256,
      });
      this.downloadedInstallerPath = installerPath;
      this.setStatus({
        ...this.status,
        phase: "ready",
        progressPercent: 100,
        transferredBytes: verified.manifest.asset.sizeBytes,
        canRetry: true,
        error: undefined,
      });
      return this.getStatus();
    } catch (error) {
      this.downloadedInstallerPath = undefined;
      throw this.fail(error);
    } finally {
      this.busy = false;
    }
  }

  async install(): Promise<DesktopUpdateStatus> {
    this.assertEnabled();
    this.assertNotBusy("install an update");
    const verified = this.verifiedManifest;
    const installerPath = this.downloadedInstallerPath;
    if (!verified || !installerPath || this.status.phase !== "ready") {
      throw new Error("Download and verify an update before installing it.");
    }
    this.busy = true;
    this.installAbortPromise = undefined;
    this.installLaunchError = undefined;
    this.installRecoveryPrepared = false;
    this.installRecoveryArmed = false;
    let recoveryPrepared = false;
    try {
      if (await this.options.recovery.getPendingRecoveryPlan()) {
        throw new Error("A previous Agent Hub update is still awaiting recovery confirmation.");
      }
      const backupFiles = await this.options.installHooks?.prepareForInstall?.() ?? [];
      await this.options.recovery.prepare({
        currentVersion: this.currentVersion,
        manifest: verified.manifest,
        manifestSha256: verified.manifestSha256,
        installerPath,
        backupFiles,
        applicationDirectory: this.options.recoveryApplication?.applicationDirectory,
        applicationExecutablePath: this.options.recoveryApplication?.applicationExecutablePath,
        restoreRootDirectory: this.options.recoveryApplication?.restoreRootDirectory,
      });
      recoveryPrepared = true;
      this.installRecoveryPrepared = true;
      const recoveryPlan = await this.options.recovery.getPendingRecoveryPlan();
      if (recoveryPlan) {
        if (!this.options.recoveryExecutor) {
          throw new Error("The desktop update recovery executor is not configured.");
        }
        await this.options.recoveryExecutor.arm(recoveryPlan);
        this.installRecoveryArmed = true;
      }
      this.setStatus({ ...this.status, phase: "installing", canRetry: false, error: undefined });
      this.options.installHooks?.onInstallLaunching?.();
      this.options.engine.quitAndInstall(true, true);
      if (this.installLaunchError) {
        await this.installAbortPromise;
        throw this.installLaunchError;
      }
      return this.getStatus();
    } catch (error) {
      const normalized = asError(error);
      await this.abortInstall(normalized, recoveryPrepared);
      throw this.fail(this.installLaunchError ?? normalized);
    } finally {
      this.busy = false;
    }
  }

  private handleProgress(value: unknown): void {
    if (this.status.phase !== "downloading" || !value || typeof value !== "object") return;
    const progress = value as Record<string, unknown>;
    this.setStatus({
      ...this.status,
      progressPercent: boundedNumber(progress.percent, 0, 100),
      transferredBytes: boundedNumber(progress.transferred, 0, Number.MAX_SAFE_INTEGER),
      bytesPerSecond: boundedNumber(progress.bytesPerSecond, 0, Number.MAX_SAFE_INTEGER),
    });
  }

  private handleEngineError(value: unknown): void {
    const error = asError(value);
    if (this.status.phase !== "installing") {
      this.fail(error);
      return;
    }
    this.installLaunchError = error;
    this.fail(error);
    void this.abortInstall(error, this.installRecoveryPrepared);
  }

  private abortInstall(error: Error, recoveryPrepared: boolean): Promise<void> {
    if (this.installAbortPromise) return this.installAbortPromise;
    this.installAbortPromise = (async () => {
      if (recoveryPrepared) {
        await this.options.recovery.markPendingFailed(error.message).catch(() => undefined);
        let safeToAbandon = !this.installRecoveryArmed;
        const targetVersion = this.verifiedManifest?.manifest.version ?? this.currentVersion;
        if (this.installRecoveryArmed) {
          try {
            if (!this.options.recoveryExecutor) {
              throw new Error("The desktop update recovery executor is not configured.");
            }
            await withTimeout(
              this.options.recoveryExecutor.disarm(targetVersion),
              this.options.recoveryDisarmTimeoutMs ?? 5_000,
              "The desktop update recovery guard did not disarm in time.",
            );
            safeToAbandon = true;
            this.installRecoveryArmed = false;
          } catch (disarmError) {
            const retainedError = new Error(
              `${error.message} Recovery protection could not be safely disarmed, so the pending update and recovery data were retained. ${asError(disarmError).message}`,
            );
            this.installLaunchError = retainedError;
            await this.options.recovery.markPendingFailed(retainedError.message).catch(() => undefined);
            this.fail(retainedError);
          }
        }
        if (safeToAbandon) {
          await this.options.recovery.abandonPending().catch(() => undefined);
        }
      }
      await this.options.installHooks?.onInstallAborted?.(this.installLaunchError ?? error);
      this.installRecoveryPrepared = false;
    })();
    return this.installAbortPromise;
  }

  private runAutomaticCheck(): void {
    if (this.busy || this.status.phase === "ready" || this.status.phase === "installing") return;
    void this.check().catch(() => undefined);
  }

  private fail(error: unknown): Error {
    const normalized = asError(error);
    this.setStatus({
      ...this.status,
      phase: "failed",
      error: normalized.message,
      canRetry: true,
    });
    return normalized;
  }

  private assertEnabled(): void {
    if (!this.options.enabled) throw new Error(this.status.error ?? "Desktop updates are disabled.");
  }

  private assertNotBusy(action: string): void {
    if (this.busy) throw new Error(`Agent Hub cannot ${action} while another update operation is running.`);
  }

  private setStatus(status: DesktopUpdateStatus): void {
    this.status = { ...status };
    for (const listener of this.listeners) listener(this.getStatus());
  }
}

export async function verifyInstallerFile(
  installerPath: string,
  expected: { sizeBytes: number; sha256: string },
): Promise<void> {
  const details = await stat(installerPath);
  if (!details.isFile() || details.size !== expected.sizeBytes) {
    throw new Error("The downloaded Agent Hub installer size does not match the signed manifest.");
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(installerPath)) digest.update(chunk as Buffer);
  if (digest.digest("hex") !== expected.sha256) {
    throw new Error("The downloaded Agent Hub installer SHA-256 does not match the signed manifest.");
  }
}

function selectInstallerPath(paths: string[], expectedFileName: string): string {
  const installer = paths.find(
    (candidate) => path.basename(candidate).toLocaleLowerCase("en-US")
      === expectedFileName.toLocaleLowerCase("en-US"),
  );
  if (!installer) throw new Error("The updater did not download the installer named by the signed manifest.");
  return installer;
}

function feedAssetName(value: string): string {
  try {
    return path.basename(new URL(value, "https://github.com/").pathname);
  } catch {
    return "";
  }
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(maximum, Math.max(minimum, value));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("The desktop update recovery timeout is invalid.");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
