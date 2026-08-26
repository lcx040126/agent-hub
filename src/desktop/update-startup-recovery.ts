import type {
  DesktopUpdateRecovery,
  DesktopUpdateRecoveryExecutor,
} from "./update-recovery.js";

export type UpdateStartupRecoveryAction = "continue" | "quit-for-rollback";

export async function reconcilePendingUpdateAtStartup(options: {
  recovery: DesktopUpdateRecovery;
  recoveryExecutor: DesktopUpdateRecoveryExecutor;
  currentVersion: string;
}): Promise<UpdateStartupRecoveryAction> {
  const pending = await options.recovery.getPendingRecoveryPlan();
  if (!pending) return "continue";

  if (options.currentVersion === pending.targetVersion) {
    await options.recoveryExecutor.arm(pending, { replaceExisting: true });
    return "continue";
  }

  if (options.currentVersion === pending.fromVersion) {
    await options.recoveryExecutor.arm(pending, {
      replaceExisting: true,
      timeoutSeconds: 0,
    });
    return "quit-for-rollback";
  }

  throw new Error(
    `Agent Hub ${options.currentVersion} cannot safely recover the pending update from ${pending.fromVersion} to ${pending.targetVersion}.`,
  );
}
