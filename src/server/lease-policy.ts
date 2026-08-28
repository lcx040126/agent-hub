import {
  evaluateRiskPolicy,
  type RiskEvaluation,
  type RiskPolicy,
} from "./risk-policy.js";

export type CoordinationLeaseKind = "automatic" | "standard" | "exclusive";

export interface CoordinationLeaseScope {
  leaseId: string;
  memberId: string;
  memberName: string;
  sessionId: string | null;
  kind: CoordinationLeaseKind;
  paths: string[];
  expiresAt: string;
}

export interface RequestedCoordinationScope {
  memberId: string;
  sessionId: string | null;
  kind: CoordinationLeaseKind;
  paths: string[];
}

export interface EvaluatedLeaseConflict {
  leaseId: string;
  memberId: string;
  memberName: string;
  requestedPath: string;
  existingPath: string;
  severity: "warning" | "blocking";
  decision: "warn" | "deny";
  reason: string;
  expiresAt: string;
  existingLeaseKind: CoordinationLeaseKind;
  requestedRisk?: RiskEvaluation;
  existingRisk?: RiskEvaluation;
}

export interface LeaseDurationSettings {
  automaticLeaseTtlMinutes: number;
  maximumExclusiveLeaseMinutes: number;
}

export function evaluateRealtimeOverlaps(
  request: RequestedCoordinationScope,
  activeLeases: CoordinationLeaseScope[],
  policy: RiskPolicy,
  blockingProtectionEnabled: boolean,
): EvaluatedLeaseConflict[] {
  const conflicts: EvaluatedLeaseConflict[] = [];
  const seen = new Set<string>();
  for (const lease of activeLeases) {
    const sameSession = lease.memberId === request.memberId && lease.sessionId === request.sessionId;
    if (sameSession && request.kind !== "exclusive" && lease.kind !== "exclusive") continue;
    for (const requestedPath of request.paths) {
      for (const existingPath of lease.paths) {
        if (!pathsOverlap(requestedPath, existingPath)) continue;
        const key = `${lease.leaseId}\0${pathKey(requestedPath)}\0${pathKey(existingPath)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        conflicts.push(evaluateOverlap(
          request,
          lease,
          requestedPath,
          existingPath,
          policy,
          blockingProtectionEnabled,
        ));
      }
    }
  }
  return conflicts;
}

export function resolveLeaseDurationMinutes(
  kind: CoordinationLeaseKind,
  requestedMinutes: number | undefined,
  settings: LeaseDurationSettings,
): number {
  const automaticTtl = allowedAutomaticTtl(settings.automaticLeaseTtlMinutes);
  if (kind !== "exclusive") return automaticTtl;
  const maximum = Math.max(5, Math.min(7 * 24 * 60, Math.trunc(settings.maximumExclusiveLeaseMinutes)));
  const requested = requestedMinutes === undefined ? Math.min(60, maximum) : Math.trunc(requestedMinutes);
  if (!Number.isFinite(requested) || requested < 5 || requested > maximum) {
    throw new Error(`Exclusive lease duration must be between 5 and ${maximum} minutes.`);
  }
  return requested;
}

export function shouldHeartbeatRenew(kind: CoordinationLeaseKind): boolean {
  return kind !== "exclusive";
}

function evaluateOverlap(
  request: RequestedCoordinationScope,
  lease: CoordinationLeaseScope,
  requestedPath: string,
  existingPath: string,
  policy: RiskPolicy,
  blockingProtectionEnabled: boolean,
): EvaluatedLeaseConflict {
  const sameMember = lease.memberId === request.memberId;
  if (lease.kind === "exclusive") {
    const denied = request.kind === "exclusive" || !sameMember;
    return result(
      lease,
      requestedPath,
      existingPath,
      "blocking",
      denied ? "deny" : "warn",
      denied
        ? request.kind === "exclusive"
          ? "Overlapping manual exclusive leases cannot be active at the same time."
          : `${lease.memberName} has an active manual exclusive lease. Approval is required before another member's Agent can write.`
        : "Another Agent session owned by the same member is using this manual exclusive range; the critical risk remains visible but writing is allowed.",
    );
  }
  if (request.kind === "exclusive") {
    return result(
      lease,
      requestedPath,
      existingPath,
      "blocking",
      "deny",
      "A manual exclusive lease cannot start while any active work lease overlaps the requested range.",
    );
  }
  if (
    blockingProtectionEnabled
    && sameMember
    && lease.kind === "standard"
    && lease.sessionId === null
  ) {
    return result(
      lease,
      requestedPath,
      existingPath,
      "warning",
      "warn",
      "This member's shared manual work range is available to all of their Agent sessions; the additional session is recorded as a warning.",
    );
  }

  const requestedRisk = evaluateRiskPolicy(requestedPath, policy, blockingProtectionEnabled);
  const existingRisk = evaluateRiskPolicy(existingPath, policy, blockingProtectionEnabled);
  const blocking = requestedRisk.level === "blocking" || existingRisk.level === "blocking";
  const decision = blocking && blockingProtectionEnabled ? "deny" : "warn";
  return {
    ...result(
      lease,
      requestedPath,
      existingPath,
      blocking ? "blocking" : "warning",
      decision,
      blocking
        ? blockingProtectionEnabled
          ? `The active room policy marks this concrete overlap as blocking. ${requestedRisk.reason}`
          : `The active room policy marks this concrete overlap as a critical risk, but monitor-only mode allows writing. ${requestedRisk.reason}`
        : `The concrete ranges overlap and the active room policy records a warning. ${requestedRisk.reason}`,
    ),
    requestedRisk,
    existingRisk,
  };
}

function result(
  lease: CoordinationLeaseScope,
  requestedPath: string,
  existingPath: string,
  severity: "warning" | "blocking",
  decision: "warn" | "deny",
  reason: string,
): EvaluatedLeaseConflict {
  return {
    leaseId: lease.leaseId,
    memberId: lease.memberId,
    memberName: lease.memberName,
    requestedPath,
    existingPath,
    severity,
    decision,
    reason,
    expiresAt: lease.expiresAt,
    existingLeaseKind: lease.kind,
  };
}

function allowedAutomaticTtl(value: number): number {
  const normalized = Math.trunc(value);
  if (![5, 10, 15, 30, 60].includes(normalized)) {
    throw new Error("Automatic lease TTL must be 5, 10, 15, 30, or 60 minutes.");
  }
  return normalized;
}

function pathsOverlap(left: string, right: string): boolean {
  return pathScopeCovers(left, right) || pathScopeCovers(right, left);
}

function pathScopeCovers(scope: string, candidate: string): boolean {
  const normalizedScope = pathKey(scope).replace(/\/$/, "");
  const normalizedCandidate = pathKey(candidate).replace(/\/$/, "");
  return normalizedScope === "."
    || normalizedScope === normalizedCandidate
    || normalizedCandidate.startsWith(`${normalizedScope}/`);
}

function pathKey(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").toLocaleLowerCase("en-US");
}
