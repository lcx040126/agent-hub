export type HealthResponse = {
  status: "ok";
  service: "agent-hub";
  version: string;
};

export type MemberRole = "owner" | "admin" | "member" | "viewer";
export type LeaseMode = "read" | "write";
export type LeaseStatus = "active" | "completed" | "released" | "expired";
export type ConflictDecision = "allow" | "warn" | "deny";
export type RecordKind = "decision" | "validation" | "handoff" | "risk";

export type RoomSummary = {
  id: string;
  code: string;
  name: string;
  projectName: string;
  repository: string;
  defaultBranch: string;
  createdAt: string;
};

export type MemberSummary = {
  id: string;
  name: string;
  role: MemberRole;
  clientName?: string;
  lastSeenAt: string;
  isAdmin?: boolean;
  removedAt?: string;
};

export type LeaseSummary = {
  id: string;
  memberId: string;
  memberName: string;
  title: string;
  intent: string;
  branch: string;
  baseCommit?: string;
  paths: string[];
  mode: LeaseMode;
  status: LeaseStatus;
  decision: ConflictDecision;
  overrideReason?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ConflictSummary = {
  id: string;
  severity: "notice" | "warning" | "critical";
  decision: ConflictDecision;
  requestedPath: string;
  conflictingPath: string;
  leaseId: string;
  memberName: string;
  title: string;
  reason: string;
};

export type RecordSummary = {
  id: string;
  kind: RecordKind;
  title: string;
  summary: string;
  paths: string[];
  status: string;
  evidence: string[];
  commitHash?: string;
  memberId: string;
  memberName: string;
  createdAt: string;
};

export type ActivitySummary = {
  id: string;
  type: string;
  actorName: string;
  summary: string;
  createdAt: string;
};

export type DashboardResponse = {
  room: RoomSummary;
  currentMember: MemberSummary;
  members: MemberSummary[];
  leases: LeaseSummary[];
  conflicts: ConflictSummary[];
  records: RecordSummary[];
  activity: ActivitySummary[];
  server: {
    mcpUrl: string;
  };
};
