import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAppUpdater, type ElectronUpdateEngine } from "./app-updater.js";
import type { DesktopUpdateManifest, VerifiedDesktopUpdateManifest } from "./update-manifest.js";
import type {
  DesktopUpdateRecovery,
  DesktopUpdateRecoveryExecutor,
  PendingRecoveryPlan,
  PrepareUpdateRecoveryInput,
  PreparedUpdateRecovery,
  UpdateRecoveryResult,
} from "./update-recovery.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("desktop app updater", () => {
  it("checks, downloads, verifies, prepares recovery, and launches NSIS only after user actions", async () => {
    const directory = await temporaryDirectory();
    const installerPath = path.join(directory, "AgentHub-Setup-0.3.0-x64.exe");
    const bytes = Buffer.from("verified installer");
    await writeFile(installerPath, bytes);
    const verified = update(bytes);
    const engine = new FakeEngine(installerPath, "0.3.0");
    const recovery = new FakeRecovery();
    const recoveryExecutor = fakeRecoveryExecutor();
    const prepareForInstall = vi.fn(async () => []);
    const updater = new DesktopAppUpdater({
      engine,
      recovery,
      enabled: true,
      currentVersion: "0.2.0",
      manifestLoader: async () => verified,
      installHooks: { prepareForInstall },
      recoveryExecutor,
    });

    await expect(updater.check()).resolves.toMatchObject({ phase: "available", availableVersion: "0.3.0" });
    expect(engine.downloadUpdate).not.toHaveBeenCalled();
    await expect(updater.download()).resolves.toMatchObject({ phase: "ready", progressPercent: 100 });
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    await expect(updater.install()).resolves.toMatchObject({ phase: "installing" });
    expect(prepareForInstall).toHaveBeenCalledOnce();
    expect(recovery.prepared?.manifest.version).toBe("0.3.0");
    expect(recoveryExecutor.arm).toHaveBeenCalledOnce();
    expect(engine.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("does not prepare or install a package whose SHA-256 differs from the signed manifest", async () => {
    const directory = await temporaryDirectory();
    const installerPath = path.join(directory, "AgentHub-Setup-0.3.0-x64.exe");
    const bytes = Buffer.from("tampered installer");
    await writeFile(installerPath, bytes);
    const verified = update(bytes);
    verified.manifest.asset.sha256 = "0".repeat(64);
    const engine = new FakeEngine(installerPath, "0.3.0");
    const recovery = new FakeRecovery();
    const updater = new DesktopAppUpdater({
      engine,
      recovery,
      enabled: true,
      currentVersion: "0.2.0",
      manifestLoader: async () => verified,
    });

    await updater.check();
    await expect(updater.download()).rejects.toThrow(/SHA-256/i);
    expect(recovery.prepared).toBeUndefined();
    expect(engine.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.getStatus()).toMatchObject({ phase: "failed" });
  });

  it("rejects a race where latest.yml points at a different version", async () => {
    const directory = await temporaryDirectory();
    const installerPath = path.join(directory, "AgentHub-Setup-0.3.0-x64.exe");
    const bytes = Buffer.from("verified installer");
    await writeFile(installerPath, bytes);
    const engine = new FakeEngine(installerPath, "0.4.0");
    const updater = new DesktopAppUpdater({
      engine,
      recovery: new FakeRecovery(),
      enabled: true,
      currentVersion: "0.2.0",
      manifestLoader: async () => update(bytes),
    });

    await expect(updater.check()).rejects.toThrow(/different versions/i);
    expect(engine.downloadUpdate).not.toHaveBeenCalled();
  });

  it("keeps updater operations disabled outside the installed Setup edition", async () => {
    const engine = new FakeEngine("unused", "0.3.0");
    const updater = new DesktopAppUpdater({
      engine,
      recovery: new FakeRecovery(),
      enabled: false,
      currentVersion: "0.2.0",
    });
    expect(updater.getStatus()).toMatchObject({ phase: "disabled", canRetry: false });
    await expect(updater.check()).rejects.toThrow(/Setup edition/i);
    expect(engine.checkForUpdates).not.toHaveBeenCalled();
  });

  it("surfaces an external watchdog rollback on the restored version", async () => {
    const recovery = new FakeRecovery();
    recovery.lastResult = {
      status: "failed",
      version: "0.3.0",
      at: "2026-08-26T12:30:00.000Z",
      error: "Version 0.2.0 and its pre-update database were restored.",
    };
    const updater = new DesktopAppUpdater({
      engine: new FakeEngine("unused", "0.3.0"),
      recovery,
      enabled: true,
      currentVersion: "0.2.0",
    });

    await updater.markCurrentStartupHealthy();

    expect(updater.getStatus()).toMatchObject({
      phase: "failed",
      currentVersion: "0.2.0",
      availableVersion: "0.3.0",
      error: "Version 0.2.0 and its pre-update database were restored.",
    });
  });

  it("keeps the watchdog armed when durable startup confirmation fails", async () => {
    const recovery = new FakeRecovery();
    vi.spyOn(recovery, "markStartupHealthy").mockRejectedValue(new Error("state write failed"));
    const recoveryExecutor = fakeRecoveryExecutor();
    const updater = new DesktopAppUpdater({
      engine: new FakeEngine("unused", "0.3.0"),
      recovery,
      recoveryExecutor,
      enabled: true,
      currentVersion: "0.3.0",
    });

    await expect(updater.markCurrentStartupHealthy()).rejects.toThrow("state write failed");
    expect(recoveryExecutor.disarm).not.toHaveBeenCalled();
  });

  it("aborts recovery and restarts stopped services when NSIS immediately emits an error", async () => {
    const directory = await temporaryDirectory();
    const installerPath = path.join(directory, "AgentHub-Setup-0.3.0-x64.exe");
    const bytes = Buffer.from("verified installer");
    await writeFile(installerPath, bytes);
    const engine = new FakeEngine(installerPath, "0.3.0");
    engine.quitAndInstall.mockImplementation(() => {
      engine.emit("error", new Error("NSIS launch failed"));
    });
    const recovery = new FakeRecovery();
    const markPendingFailed = vi.spyOn(recovery, "markPendingFailed");
    const abandonPending = vi.spyOn(recovery, "abandonPending");
    const recoveryExecutor = fakeRecoveryExecutor();
    const onInstallAborted = vi.fn(async () => undefined);
    const updater = new DesktopAppUpdater({
      engine,
      recovery,
      recoveryExecutor,
      enabled: true,
      currentVersion: "0.2.0",
      manifestLoader: async () => update(bytes),
      installHooks: {
        prepareForInstall: async () => [],
        onInstallAborted,
      },
    });

    await updater.check();
    await updater.download();
    await expect(updater.install()).rejects.toThrow("NSIS launch failed");

    expect(updater.getStatus()).toMatchObject({ phase: "failed", error: "NSIS launch failed" });
    expect(recoveryExecutor.disarm).toHaveBeenCalledWith("0.3.0");
    expect(markPendingFailed).toHaveBeenCalledWith("NSIS launch failed");
    expect(abandonPending).toHaveBeenCalledOnce();
    expect(markPendingFailed.mock.invocationCallOrder[0]).toBeLessThan(
      recoveryExecutor.disarm.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(recoveryExecutor.disarm.mock.invocationCallOrder[0]).toBeLessThan(
      abandonPending.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(onInstallAborted).toHaveBeenCalledOnce();
  });

  it("retains pending recovery data when the armed guard cannot be disarmed", async () => {
    const directory = await temporaryDirectory();
    const installerPath = path.join(directory, "AgentHub-Setup-0.3.0-x64.exe");
    const bytes = Buffer.from("verified installer");
    await writeFile(installerPath, bytes);
    const engine = new FakeEngine(installerPath, "0.3.0");
    engine.quitAndInstall.mockImplementation(() => {
      engine.emit("error", new Error("NSIS launch failed"));
    });
    const recovery = new FakeRecovery();
    const markPendingFailed = vi.spyOn(recovery, "markPendingFailed");
    const abandonPending = vi.spyOn(recovery, "abandonPending");
    const recoveryExecutor = fakeRecoveryExecutor();
    recoveryExecutor.disarm.mockRejectedValue(new Error("health marker write failed"));
    const onInstallAborted = vi.fn(async () => undefined);
    const updater = new DesktopAppUpdater({
      engine,
      recovery,
      recoveryExecutor,
      enabled: true,
      currentVersion: "0.2.0",
      manifestLoader: async () => update(bytes),
      installHooks: {
        prepareForInstall: async () => [],
        onInstallAborted,
      },
    });

    await updater.check();
    await updater.download();
    await expect(updater.install()).rejects.toThrow(/recovery data were retained.*health marker write failed/i);

    expect(recoveryExecutor.arm).toHaveBeenCalledOnce();
    expect(recoveryExecutor.disarm).toHaveBeenCalledWith("0.3.0");
    expect(abandonPending).not.toHaveBeenCalled();
    expect(markPendingFailed).toHaveBeenLastCalledWith(expect.stringMatching(/recovery data were retained/i));
    expect(onInstallAborted).toHaveBeenCalledOnce();
    expect(updater.getStatus()).toMatchObject({
      phase: "failed",
      error: expect.stringMatching(/recovery data were retained/i),
    });
  });

  it("times out guard disarm and preserves recovery data instead of hanging installation abort", async () => {
    const directory = await temporaryDirectory();
    const installerPath = path.join(directory, "AgentHub-Setup-0.3.0-x64.exe");
    const bytes = Buffer.from("verified installer");
    await writeFile(installerPath, bytes);
    const engine = new FakeEngine(installerPath, "0.3.0");
    engine.quitAndInstall.mockImplementation(() => {
      engine.emit("error", new Error("NSIS launch failed"));
    });
    const recovery = new FakeRecovery();
    const abandonPending = vi.spyOn(recovery, "abandonPending");
    const recoveryExecutor = fakeRecoveryExecutor();
    recoveryExecutor.disarm.mockImplementation(() => new Promise<void>(() => undefined));
    const onInstallAborted = vi.fn(async () => undefined);
    const updater = new DesktopAppUpdater({
      engine,
      recovery,
      recoveryExecutor,
      recoveryDisarmTimeoutMs: 25,
      enabled: true,
      currentVersion: "0.2.0",
      manifestLoader: async () => update(bytes),
      installHooks: {
        prepareForInstall: async () => [],
        onInstallAborted,
      },
    });

    await updater.check();
    await updater.download();
    await expect(updater.install()).rejects.toThrow(/did not disarm in time/i);

    expect(abandonPending).not.toHaveBeenCalled();
    expect(onInstallAborted).toHaveBeenCalledOnce();
    expect(updater.getStatus()).toMatchObject({
      phase: "failed",
      error: expect.stringMatching(/pending update and recovery data were retained/i),
    });
  });
});

class FakeEngine extends EventEmitter implements ElectronUpdateEngine {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  checkForUpdates = vi.fn(async () => ({
    isUpdateAvailable: true,
    updateInfo: {
      version: this.feedVersion,
      files: [{ url: `AgentHub-Setup-${this.feedVersion}-x64.exe` }],
    },
  }));
  downloadUpdate = vi.fn(async () => [this.installerPath]);
  quitAndInstall = vi.fn();

  constructor(private readonly installerPath: string, private readonly feedVersion: string) {
    super();
  }
}

class FakeRecovery implements DesktopUpdateRecovery {
  highestSeenVersion: string | undefined;
  highestSeenManifestSha256: string | undefined;
  prepared: PrepareUpdateRecoveryInput | undefined;
  lastResult: UpdateRecoveryResult | undefined;

  async getHighestSeenVersion(): Promise<string | undefined> {
    return this.highestSeenVersion;
  }

  async getHighestSeenManifestSha256(): Promise<string | undefined> {
    return this.highestSeenManifestSha256;
  }

  async recordHighestSeenVersion(version: string, manifestSha256: string): Promise<void> {
    this.highestSeenVersion = version;
    this.highestSeenManifestSha256 = manifestSha256;
  }

  async prepare(input: PrepareUpdateRecoveryInput): Promise<PreparedUpdateRecovery> {
    this.prepared = input;
    return { targetVersion: input.manifest.version, installerPath: input.installerPath };
  }

  async markStartupHealthy(): Promise<void> {}
  async markPendingFailed(): Promise<void> {}
  async abandonPending(): Promise<void> {}
  async getPendingRecoveryPlan(): Promise<PendingRecoveryPlan | undefined> {
    if (!this.prepared) return undefined;
    return {
      fromVersion: "0.2.0",
      targetVersion: this.prepared.manifest.version,
      attemptedInstallerPath: this.prepared.installerPath,
      restoreFiles: [],
      preparedAt: "2026-08-26T12:00:00.000Z",
    };
  }
  async getLastResult(): Promise<UpdateRecoveryResult | undefined> { return this.lastResult; }
}

function update(bytes: Buffer): VerifiedDesktopUpdateManifest {
  return {
    manifest: manifest(bytes),
    manifestSha256: "f".repeat(64),
  };
}

function manifest(bytes: Buffer): DesktopUpdateManifest {
  return {
    formatVersion: 1,
    product: "agent-hub",
    channel: "stable",
    repository: "lcx040126/agent-hub",
    version: "0.3.0",
    publishedAt: "2026-08-26T12:00:00.000Z",
    protocolVersion: 1,
    minimumSourceProtocolVersion: 1,
    schemaVersion: 2,
    minimumSourceSchemaVersion: 2,
    notes: "Update test",
    asset: {
      fileName: "AgentHub-Setup-0.3.0-x64.exe",
      url: "https://github.com/lcx040126/agent-hub/releases/download/v0.3.0/AgentHub-Setup-0.3.0-x64.exe",
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-app-updater-"));
  directories.push(directory);
  return directory;
}

function fakeRecoveryExecutor(): DesktopUpdateRecoveryExecutor & {
  arm: ReturnType<typeof vi.fn>;
  disarm: ReturnType<typeof vi.fn>;
} {
  return {
    arm: vi.fn(async () => undefined),
    disarm: vi.fn(async () => undefined),
  };
}
