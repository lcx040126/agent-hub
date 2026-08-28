import { describe, expect, it } from "vitest";
import { createDefaultRiskPolicy } from "./risk-policy.js";
import {
  evaluateRealtimeOverlaps,
  resolveLeaseDurationMinutes,
  shouldHeartbeatRenew,
  type CoordinationLeaseScope,
} from "./lease-policy.js";

const existing = (overrides: Partial<CoordinationLeaseScope> = {}): CoordinationLeaseScope => ({
  leaseId: "lease-a",
  memberId: "alice",
  memberName: "Alice",
  sessionId: "session-a",
  kind: "automatic",
  paths: ["src/shared.ts"],
  expiresAt: "2026-08-26T12:00:00.000Z",
  ...overrides,
});

describe("lease overlap policy", () => {
  it("warns for ordinary source overlap without requiring an override", () => {
    const conflicts = evaluateRealtimeOverlaps(
      { memberId: "bob", sessionId: "session-b", kind: "automatic", paths: ["src/shared.ts"] },
      [existing()],
      createDefaultRiskPolicy(),
      true,
    );
    expect(conflicts).toMatchObject([{ severity: "warning", decision: "warn" }]);
  });

  it("keeps critical risk red but allows it when the owner switch is off", () => {
    const scene = existing({ paths: ["Assets/Scenes/Main.unity"] });
    const request = { memberId: "bob", sessionId: "session-b", kind: "automatic" as const, paths: ["Assets/Scenes/Main.unity"] };
    expect(evaluateRealtimeOverlaps(request, [scene], createDefaultRiskPolicy(), true)[0]).toMatchObject({ severity: "blocking" });
    expect(evaluateRealtimeOverlaps(request, [scene], createDefaultRiskPolicy(), false)[0]).toMatchObject({
      severity: "blocking",
      decision: "warn",
    });
  });

  it("keeps Luban warning-only by default", () => {
    const conflicts = evaluateRealtimeOverlaps(
      { memberId: "bob", sessionId: "session-b", kind: "automatic", paths: ["Config/Luban/TbItem.xlsx"] },
      [existing({ paths: ["Config/Luban"] })],
      createDefaultRiskPolicy(),
      true,
    );
    expect(conflicts[0]).toMatchObject({ severity: "warning", requestedRisk: { category: "luban" } });
  });

  it("always blocks another member on a manual exclusive lease", () => {
    const exclusive = existing({ kind: "exclusive", paths: ["Config/Luban"] });
    const request = { memberId: "bob", sessionId: "session-b", kind: "automatic" as const, paths: ["Config/Luban/TbItem.xlsx"] };
    expect(evaluateRealtimeOverlaps(request, [exclusive], createDefaultRiskPolicy(), false)[0]).toMatchObject({
      severity: "blocking",
      existingLeaseKind: "exclusive",
    });
  });

  it("warns rather than blocks the exclusive renter's other Agent sessions", () => {
    const exclusive = existing({ kind: "exclusive", paths: ["Assets/Vanguard"] });
    const conflicts = evaluateRealtimeOverlaps(
      { memberId: "alice", sessionId: "session-other", kind: "automatic", paths: ["Assets/Vanguard/UI/Hud.cs"] },
      [exclusive],
      createDefaultRiskPolicy(),
      true,
    );
    expect(conflicts[0]).toMatchObject({ severity: "blocking", decision: "warn" });
  });

  it("shares a sessionless manual standard lease across the same member's Agent sessions", () => {
    const manual = existing({
      sessionId: null,
      kind: "standard",
      paths: ["Assets/Scenes/Main.unity"],
    });
    const sameMember = evaluateRealtimeOverlaps(
      { memberId: "alice", sessionId: "session-other", kind: "automatic", paths: ["Assets/Scenes/Main.unity"] },
      [manual],
      createDefaultRiskPolicy(),
      true,
    );
    const otherMember = evaluateRealtimeOverlaps(
      { memberId: "bob", sessionId: "session-b", kind: "automatic", paths: ["Assets/Scenes/Main.unity"] },
      [manual],
      createDefaultRiskPolicy(),
      true,
    );
    expect(sameMember[0]).toMatchObject({ severity: "warning", decision: "warn" });
    expect(otherMember[0]).toMatchObject({ severity: "blocking", decision: "deny" });
  });

  it("prevents a new exclusive lease from overlapping any active work", () => {
    const conflicts = evaluateRealtimeOverlaps(
      { memberId: "alice", sessionId: "session-a", kind: "exclusive", paths: ["src"] },
      [existing()],
      createDefaultRiskPolicy(),
      false,
    );
    expect(conflicts[0]).toMatchObject({ severity: "blocking" });
  });

  it("uses room TTL choices and never heartbeat-renews exclusive leases", () => {
    const settings = { automaticLeaseTtlMinutes: 10, maximumExclusiveLeaseMinutes: 1_440 };
    expect(resolveLeaseDurationMinutes("automatic", 60, settings)).toBe(10);
    expect(resolveLeaseDurationMinutes("exclusive", 90, settings)).toBe(90);
    expect(() => resolveLeaseDurationMinutes("exclusive", 1_441, settings)).toThrow(/between 5 and 1440/);
    expect(shouldHeartbeatRenew("automatic")).toBe(true);
    expect(shouldHeartbeatRenew("exclusive")).toBe(false);
  });
});
