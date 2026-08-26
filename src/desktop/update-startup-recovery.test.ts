import { describe, expect, it, vi } from "vitest";
import type {
  DesktopUpdateRecovery,
  DesktopUpdateRecoveryExecutor,
  PendingRecoveryPlan,
  PrepareUpdateRecoveryInput,
  PreparedUpdateRecovery,
  UpdateRecoveryResult,
} from "./update-recovery.js";
import { reconcilePendingUpdateAtStartup } from "./update-startup-recovery.js";

describe("desktop update startup recovery", () => {
  it("continues without arming a watchdog when no update is pending", async () => {
    const recovery = new FakeRecovery();
    const executor = fakeExecutor();

    await expect(reconcilePendingUpdateAtStartup({
      recovery,
      recoveryExecutor: executor,
      currentVersion: "0.2.0",
    })).resolves.toBe("continue");

    expect(executor.arm).not.toHaveBeenCalled();
  });

  it("replaces a lost watchdog before the target version starts room services", async () => {
    const recovery = new FakeRecovery(pendingPlan());
    const executor = fakeExecutor();

    await expect(reconcilePendingUpdateAtStartup({
      recovery,
      recoveryExecutor: executor,
      currentVersion: "0.3.0",
    })).resolves.toBe("continue");

    expect(executor.arm).toHaveBeenCalledWith(recovery.pending, { replaceExisting: true });
  });

  it("requests immediate rollback when the pre-update version restarts with pending state", async () => {
    const recovery = new FakeRecovery(pendingPlan());
    const executor = fakeExecutor();

    await expect(reconcilePendingUpdateAtStartup({
      recovery,
      recoveryExecutor: executor,
      currentVersion: "0.2.0",
    })).resolves.toBe("quit-for-rollback");

    expect(executor.arm).toHaveBeenCalledWith(recovery.pending, {
      replaceExisting: true,
      timeoutSeconds: 0,
    });
  });

  it("fails closed when an unrelated version encounters the pending update", async () => {
    const recovery = new FakeRecovery(pendingPlan());
    const executor = fakeExecutor();

    await expect(reconcilePendingUpdateAtStartup({
      recovery,
      recoveryExecutor: executor,
      currentVersion: "0.4.0",
    })).rejects.toThrow(/cannot safely recover/i);

    expect(executor.arm).not.toHaveBeenCalled();
    expect(recovery.pending).toBeDefined();
  });
});

class FakeRecovery implements DesktopUpdateRecovery {
  constructor(readonly pending?: PendingRecoveryPlan) {}

  async getHighestSeenVersion(): Promise<string | undefined> { return undefined; }
  async getHighestSeenManifestSha256(): Promise<string | undefined> { return undefined; }
  async recordHighestSeenVersion(): Promise<void> {}
  async prepare(_input: PrepareUpdateRecoveryInput): Promise<PreparedUpdateRecovery> {
    throw new Error("not used");
  }
  async markStartupHealthy(): Promise<void> {}
  async markPendingFailed(): Promise<void> {}
  async abandonPending(): Promise<void> {}
  async getPendingRecoveryPlan(): Promise<PendingRecoveryPlan | undefined> { return this.pending; }
  async getLastResult(): Promise<UpdateRecoveryResult | undefined> { return undefined; }
}

function fakeExecutor(): DesktopUpdateRecoveryExecutor & {
  arm: ReturnType<typeof vi.fn>;
  disarm: ReturnType<typeof vi.fn>;
} {
  return {
    arm: vi.fn(async () => undefined),
    disarm: vi.fn(async () => undefined),
  };
}

function pendingPlan(): PendingRecoveryPlan {
  return {
    fromVersion: "0.2.0",
    targetVersion: "0.3.0",
    attemptedInstallerPath: "C:\\updates\\packages\\0.3.0\\AgentHub-Setup-0.3.0-x64.exe",
    applicationDirectory: "C:\\Agent Hub",
    applicationBackupDirectory: "C:\\updates\\backups\\application",
    applicationExecutablePath: "C:\\Agent Hub\\Agent Hub.exe",
    restoreRootDirectory: "C:\\Agent Hub Data",
    restoreFiles: [],
    preparedAt: "2026-08-26T12:00:00.000Z",
  };
}
