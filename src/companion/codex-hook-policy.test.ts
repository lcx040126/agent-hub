import { describe, expect, it } from "vitest";
import {
  enforceWriteHookPolicy,
  hasVerifiedManualExclusiveBlocker,
  isVerifiedManualExclusiveClaim,
  markVerifiedManualExclusiveBlock,
  requiresAuthoritativeModeRecheck,
} from "./codex-hook-policy.js";

const monitorPolicy = {
  authoritative: true as const,
  blockingProtectionEnabled: false,
};

describe("Codex Hook monitor-only policy", () => {
  it("does not treat a red severity or a non-exclusive deny as authority to block", () => {
    expect(isVerifiedManualExclusiveClaim({
      acquired: false,
      decision: "deny",
      conflicts: [{
        decision: "deny",
        severity: "critical",
        existingLeaseKind: "standard",
        memberId: "member-bob",
      }],
    })).toBe(false);
    expect(isVerifiedManualExclusiveClaim({
      acquired: false,
      decision: "warn",
      conflicts: [{
        decision: "warn",
        severity: "critical",
        existingLeaseKind: "exclusive",
        memberId: "member-bob",
      }],
    })).toBe(false);
  });

  it("recognizes only an authoritative manual exclusive denial", () => {
    expect(isVerifiedManualExclusiveClaim({
      acquired: false,
      decision: "deny",
      conflicts: [{
        decision: "deny",
        severity: "critical",
        existingLeaseKind: "exclusive",
        memberId: "member-bob",
      }],
    })).toBe(true);
    expect(hasVerifiedManualExclusiveBlocker({
      blockers: [{
        code: "lease_conflict",
        conflict: {
          decision: "deny",
          existingLeaseKind: "exclusive",
          memberId: "member-bob",
        },
      }],
    })).toBe(true);
  });

  it("normalizes every unmarked PreToolUse denial to allow", () => {
    const result = enforceWriteHookPolicy("PreToolUse", {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "local state is damaged",
      },
    }, monitorPolicy);

    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
    expect(JSON.stringify(result)).toContain("local state is damaged");
  });

  it("normalizes every unmarked PostToolUse stop to context-only warning", () => {
    const result = enforceWriteHookPolicy("PostToolUse", {
      continue: false,
      stopReason: "registration failed",
      decision: "block",
    }, monitorPolicy);

    expect(result).not.toHaveProperty("continue");
    expect(result).not.toHaveProperty("decision");
    expect(result).toMatchObject({
      hookSpecificOutput: { hookEventName: "PostToolUse" },
    });
    expect(JSON.stringify(result)).toContain("registration failed");
  });

  it("preserves the one output marked from an authoritative exclusive claim", () => {
    const blocked = markVerifiedManualExclusiveBlock({
      continue: false,
      stopReason: "manual exclusive conflict",
      hookSpecificOutput: { hookEventName: "PostToolUse" },
    });

    expect(enforceWriteHookPolicy("PostToolUse", blocked, monitorPolicy)).toBe(blocked);
    expect(requiresAuthoritativeModeRecheck("PostToolUse", blocked)).toBe(false);
  });

  it("downgrades a session-integrity denial in monitor-only mode", () => {
    const blocked = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "the replacement generation is not active",
      },
    };

    expect(enforceWriteHookPolicy("PreToolUse", blocked, monitorPolicy)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
    expect(requiresAuthoritativeModeRecheck("PreToolUse", blocked)).toBe(true);
  });

  it("requires a fresh authoritative mode before downgrading an unmarked block", () => {
    expect(requiresAuthoritativeModeRecheck("PreToolUse", {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    })).toBe(true);
    expect(requiresAuthoritativeModeRecheck("PostToolUse", {
      continue: false,
      stopReason: "server denied the write",
    })).toBe(true);
  });
});
