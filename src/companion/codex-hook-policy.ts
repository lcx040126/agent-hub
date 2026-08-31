export interface AuthoritativeHookProtectionPolicy {
  authoritative: true;
  blockingProtectionEnabled: boolean;
}

export interface UnavailableHookProtectionPolicy {
  authoritative: false;
  warning: string;
}

export type HookProtectionPolicy =
  | AuthoritativeHookProtectionPolicy
  | UnavailableHookProtectionPolicy;

type WriteHookEvent = "PreToolUse" | "PostToolUse";

const verifiedManualExclusiveBlocks = new WeakSet<object>();

/**
 * 监测模式的唯一强制例外必须来自在线服务端的结构化结果。
 * 红色 severity 只负责展示，不能成为 Hook 拒绝写入的依据。
 */
export function isVerifiedManualExclusiveClaim(value: unknown): boolean {
  if (!isRecord(value) || value.acquired !== false || value.decision !== "deny") return false;
  if (!Array.isArray(value.conflicts)) return false;
  const deniedConflicts = value.conflicts.filter((conflict) =>
    isRecord(conflict) && conflict.decision === "deny");
  return deniedConflicts.length > 0 && deniedConflicts.every((conflict) =>
    conflict.existingLeaseKind === "exclusive"
    && typeof conflict.memberId === "string"
    && conflict.memberId.trim().length > 0);
}

export function hasVerifiedManualExclusiveBlocker(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.blockers)) return false;
  return value.blockers.some((blocker) => {
    if (!isRecord(blocker) || !isRecord(blocker.conflict)) return false;
    const conflict = blocker.conflict;
    return conflict.decision === "deny"
      && conflict.existingLeaseKind === "exclusive"
      && typeof conflict.memberId === "string"
      && conflict.memberId.trim().length > 0;
  });
}

export function markVerifiedManualExclusiveBlock<T extends Record<string, unknown>>(output: T): T {
  verifiedManualExclusiveBlocks.add(output);
  return output;
}

/**
 * 服务端在一次写入检查期间可能切换模式。任何未标记的 deny/stop 都必须先复核，
 * 再由最新权威模式决定保留或降级；手动独占结果已经携带在线权威标记，无需复核。
 */
export function requiresAuthoritativeModeRecheck(
  event: WriteHookEvent,
  output: Record<string, unknown> | undefined,
): boolean {
  if (output === undefined) return false;
  if (verifiedManualExclusiveBlocks.has(output)) return false;
  return event === "PreToolUse"
    ? preToolPermissionDecision(output) === "deny"
    : output.continue === false;
}

/**
 * 所有 Pre/Post 结果最终都经过这里。即使以后新增了本地 deny 分支，
 * 监测模式也只能保留上面标记过的在线手动独占冲突。
 */
export function enforceWriteHookPolicy(
  event: WriteHookEvent,
  output: Record<string, unknown> | undefined,
  policy: AuthoritativeHookProtectionPolicy,
): Record<string, unknown> | undefined {
  if (policy.blockingProtectionEnabled || output === undefined) return output;
  if (verifiedManualExclusiveBlocks.has(output)) return output;

  if (event === "PreToolUse" && preToolPermissionDecision(output) === "deny") {
    return failOpenWriteHookOutput(event, blockReason(output));
  }
  if (event === "PostToolUse" && output.continue === false) {
    return failOpenWriteHookOutput(event, blockReason(output));
  }
  return output;
}

export function failOpenWriteHookOutput(
  event: WriteHookEvent,
  reason: string,
): Record<string, unknown> {
  const warning = `Agent Hub 风险提醒：${reason} 本次写入按监测或故障放行策略继续，不会被 Agent Hub 阻止。`;
  if (event === "PreToolUse") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: warning,
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: warning,
    },
  };
}

function preToolPermissionDecision(output: Record<string, unknown>): unknown {
  return isRecord(output.hookSpecificOutput)
    ? output.hookSpecificOutput.permissionDecision
    : undefined;
}

function blockReason(output: Record<string, unknown>): string {
  if (isRecord(output.hookSpecificOutput)) {
    const nested = output.hookSpecificOutput;
    if (typeof nested.permissionDecisionReason === "string" && nested.permissionDecisionReason.trim()) {
      return nested.permissionDecisionReason.trim();
    }
  }
  for (const field of ["stopReason", "reason", "systemMessage"] as const) {
    if (typeof output[field] === "string" && output[field].trim()) return output[field].trim();
  }
  if (isRecord(output.hookSpecificOutput)) {
    const nested = output.hookSpecificOutput;
    if (typeof nested.additionalContext === "string" && nested.additionalContext.trim()) {
      return nested.additionalContext.trim();
    }
  }
  return "检测到一项无法完成的协调检查。";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
