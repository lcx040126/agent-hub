import type { RiskPolicyRule } from "./risk-policy.js";

export const CONTEXT_KINDS = [
  "rule",
  "architecture",
  "risk",
  "note",
  "dependency",
] as const;

export const VERIFICATION_KINDS = [
  "static",
  "automated_test",
  "unity_edit_mode",
  "unity_play_mode",
  "manual",
] as const;

export const VERIFICATION_RESULTS = ["passed", "failed", "pending"] as const;

export type ContextKind = (typeof CONTEXT_KINDS)[number];
export type VerificationKind = (typeof VERIFICATION_KINDS)[number];
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];
export type MemberRole = "host" | "member";
export type LeaseStatus = "active" | "completed" | "cancelled" | "expired";
export type LeaseCompletionStatus = Extract<LeaseStatus, "completed" | "cancelled">;
export type PathRisk = "normal" | "high";
export type ConflictSeverity = "warning" | "blocking";
export type ConflictDecision = "allow" | "warn" | "deny";
export type LeaseMode = "read" | "write";
export type LeaseKind = "automatic" | "standard" | "exclusive";
export type AutomaticLeasePhase = "working" | "waiting" | "blocked" | "awaiting_commit";
export type ReleaseRequestStatus = "pending" | "approved" | "rejected" | "cancelled";
export type MemberCompatibility = "compatible" | "incompatible" | "unknown";
export type RecordKind = "decision" | "validation" | "handoff" | "risk";
export type FeatureRevisionRelation =
  | "add"
  | "extend"
  | "replace"
  | "deprecate"
  | "rollback"
  | "conflict";
export type FeatureRevisionStatus =
  | "draft"
  | "candidate"
  | "current"
  | "conflict"
  | "superseded"
  | "deprecated";
export type FeatureTargetKind = "system" | "path" | "symbol" | "interface" | "resource" | "test";
export type FeatureTargetRole = "implementation" | "contract" | "dependency" | "verification";
export type FeatureEditPrecision = "symbol" | "resource" | "path";

export interface Room {
  id: string;
  code: string;
  name: string;
  projectName: string;
  repository: string;
  defaultBranch: string;
  createdAt: string;
  status: "active" | "dissolved";
  autoLockAfterAutoClaim: boolean;
}

export interface Member {
  id: string;
  roomId: string;
  displayName: string;
  role: MemberRole;
  agent: string | null;
  createdAt: string;
  lastSeenAt: string;
  isAdmin: boolean;
  removedAt: string | null;
  clientVersion: string | null;
  protocolVersion: number | null;
  schemaVersion: number | null;
  compatibility: MemberCompatibility;
}

export interface LeasePath {
  path: string;
  risk: PathRisk;
  riskReason: string | null;
}

export interface Lease {
  id: string;
  roomId: string;
  memberId: string;
  sessionId: string | null;
  memberName: string;
  title: string;
  objective: string | null;
  branch: string | null;
  baseCommit: string | null;
  mode: LeaseMode;
  kind: LeaseKind;
  phase?: AutomaticLeasePhase;
  decision: ConflictDecision;
  overrideReason: string | null;
  status: LeaseStatus;
  paths: LeasePath[];
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  completionSummary: string | null;
}

export interface LeaseConflict {
  id: string;
  leaseId: string;
  memberId: string;
  memberName: string;
  requestedPath: string;
  existingPath: string;
  severity: ConflictSeverity;
  decision: Exclude<ConflictDecision, "allow">;
  reason: string;
  expiresAt: string;
  existingLeaseKind: LeaseKind;
}

export type LeaseClaimResult =
  | {
      acquired: true;
      decision: "allow" | "warn";
      lease: Lease;
      conflicts: LeaseConflict[];
      releaseRequests: ReleaseRequest[];
    }
  | {
      acquired: false;
      decision: "warn" | "deny" | "wait";
      conflicts: LeaseConflict[];
      releaseRequests: ReleaseRequest[];
      waitingFor?: {
        leaseId: string;
        sessionId: string | null;
        title: string;
        memberName: string;
        expiresAt: string;
        paths: string[];
      };
    };

export interface ReleaseRequest {
  id: string;
  roomId: string;
  requesterMemberId: string;
  requesterName: string;
  requesterSessionId: string | null;
  requesterLeaseId: string | null;
  holderMemberId: string;
  holderName: string;
  conflictingLeaseId: string;
  conflictingLeaseTitle: string;
  conflictingLeaseKind: LeaseKind;
  requestTitle: string;
  requestObjective: string | null;
  requestedKind: LeaseKind;
  requestedMode: LeaseMode;
  requestedPaths: string[];
  overlapPaths: Array<{ requestedPath: string; existingPath: string }>;
  reason: string;
  status: ReleaseRequestStatus;
  rejectionReason: string | null;
  transferredLeaseId: string | null;
  occurrenceCount: number;
  requestedAt: string;
  lastRequestedAt: string;
  resolvedAt: string | null;
  holderLeaseExpiresAt: string;
}

export interface ContextEntry {
  id: string;
  roomId: string;
  authorMemberId: string;
  authorName: string;
  kind: ContextKind;
  title: string;
  content: string;
  paths: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Decision {
  id: string;
  roomId: string;
  authorMemberId: string;
  authorName: string;
  title: string;
  decision: string;
  rationale: string | null;
  paths: string[];
  createdAt: string;
}

export interface Verification {
  id: string;
  roomId: string;
  authorMemberId: string;
  authorName: string;
  leaseId: string | null;
  kind: VerificationKind;
  result: VerificationResult;
  summary: string;
  command: string | null;
  evidence: string | null;
  createdAt: string;
}

export interface Handoff {
  id: string;
  roomId: string;
  fromMemberId: string;
  fromMemberName: string;
  toMemberId: string | null;
  toMemberName: string | null;
  leaseId: string | null;
  summary: string;
  completed: string[];
  remaining: string[];
  risks: string[];
  createdAt: string;
}

export interface Activity {
  id: string;
  roomId: string;
  actorMemberId: string | null;
  actorName: string | null;
  type: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RoomSnapshot {
  room: Room;
  settings: RoomSettings;
  members: Member[];
  activeLeases: Lease[];
  contextEntries: ContextEntry[];
  decisions: Decision[];
  verifications: Verification[];
  handoffs: Handoff[];
  records: ProjectRecord[];
  sessions: WorkSession[];
  localScans: LocalScan[];
  activities: Activity[];
  releaseRequests: ReleaseRequest[];
  generatedAt: string;
}

export interface EditIssue {
  code: "uncovered_path" | "lease_conflict" | "feature_confirmation_required" | "session_write_blocked";
  path: string;
  message: string;
  conflict?: LeaseConflict;
  featureImpact?: FeatureImpact;
  confirmationId?: string;
}

export interface EditCheckResult {
  allowed: boolean;
  blockers: EditIssue[];
  warnings: EditIssue[];
  coveredPaths: string[];
  uncoveredPaths: string[];
  historicalImpacts: FeatureImpact[];
  featureConfirmation?: FeatureChangeConfirmation;
  releaseRequests: ReleaseRequest[];
}

export interface ProposedFeatureEdit {
  path: string;
  precision?: FeatureEditPrecision;
  symbols?: string[];
  operation?: "add" | "update" | "delete" | "move" | "unknown";
}

export interface FeatureContract {
  key: string;
  behavior: string;
  constraints: string[];
}

export interface FeatureContractChange {
  operation: "add" | "update" | "remove";
  key: string;
  behavior?: string;
  constraints?: string[];
}

export interface FeatureTargetInput {
  kind: FeatureTargetKind;
  role?: FeatureTargetRole;
  path?: string;
  symbol?: string;
  signature?: string;
  label?: string;
}

export interface FeatureTarget {
  id: string;
  revisionId: string;
  kind: FeatureTargetKind;
  role: FeatureTargetRole;
  path: string | null;
  symbol: string | null;
  signature: string | null;
  label: string | null;
}

export interface FeatureVerificationEvidence {
  testKey: string;
  result: VerificationResult;
  summary: string;
  command?: string;
  evidence?: string;
}

export interface FeatureRevisionSnapshot {
  name: string;
  systemId: string;
  objective: string;
  contracts: FeatureContract[];
  constraints: string[];
  dependencies: string[];
}

export interface FeatureMemory {
  id: string;
  roomId: string;
  featureKey: string;
  name: string;
  systemId: string;
  currentRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureRevision {
  id: string;
  featureId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  relation: FeatureRevisionRelation;
  status: FeatureRevisionStatus;
  sourceSessionId: string;
  authorMemberId: string;
  authorName: string;
  branch: string | null;
  baseCommit: string | null;
  finalCommit: string | null;
  completed: boolean;
  changeSummary: string;
  snapshot: FeatureRevisionSnapshot;
  contractChanges: FeatureContractChange[];
  targets: FeatureTarget[];
  verifications: FeatureVerificationEvidence[];
  remainingRisks: string[];
  gitEvidence: Record<string, unknown>;
  createdAt: string;
}

export interface FeatureMemoryCard {
  featureId: string;
  featureKey: string;
  name: string;
  systemId: string;
  revisionId: string;
  revisionNumber: number;
  status: FeatureRevisionStatus;
  coreContract: string;
  paths: string[];
  symbols: string[];
  verificationStatus: VerificationResult | "missing";
  hitReasons: string[];
}

export interface FeatureMemoryQueryInput {
  memberToken: string;
  sessionId?: string;
  finalizationId?: string;
  level?: "cards" | "detail";
  query?: string;
  featureIds?: string[];
  paths?: string[];
  systems?: string[];
  symbols?: string[];
  statuses?: FeatureRevisionStatus[];
  limit?: number;
  cursor?: string;
}

export interface FeatureMemoryQueryResult {
  level: "cards" | "detail";
  cards: FeatureMemoryCard[];
  details: FeatureRevision[];
  nextCursor: string | null;
}

export interface SubmitFeatureRevisionInput {
  memberToken: string;
  sessionId: string;
  finalizationId?: string;
  featureKey: string;
  name: string;
  systemId: string;
  parentRevisionId?: string;
  relation?: Exclude<FeatureRevisionRelation, "rollback">;
  objective: string;
  changeSummary: string;
  contractChanges: FeatureContractChange[];
  constraints?: string[];
  dependencies?: string[];
  targets: FeatureTargetInput[];
  finalCommit?: string;
  completed?: boolean;
  verifications?: FeatureVerificationEvidence[];
  remainingRisks?: string[];
  gitEvidence?: Record<string, unknown>;
}

export interface RollbackFeatureRevisionInput {
  memberToken: string;
  sessionId: string;
  finalizationId?: string;
  featureId: string;
  targetRevisionId: string;
  changeSummary: string;
  finalCommit?: string;
  completed?: boolean;
  verifications?: FeatureVerificationEvidence[];
  gitEvidence?: Record<string, unknown>;
}

export interface FeatureImpact {
  featureId: string;
  featureName: string;
  revisionId: string;
  revisionNumber: number;
  path: string;
  symbols: string[];
  contracts: string[];
  reason: string;
  confidence: "exact" | "fallback";
}

export interface FeatureChangeConfirmation {
  id: string;
  roomId: string;
  sessionId: string;
  memberId: string;
  proposalHash: string;
  impacts: FeatureImpact[];
  status: "pending" | "approved" | "rejected" | "expired";
  reason: string | null;
  createdAt: string;
  resolvedAt: string | null;
  expiresAt: string;
}

export interface ResolveFeatureConfirmationInput {
  memberToken: string;
  sessionId: string;
  confirmationId: string;
  decision: "approved" | "rejected";
  reason?: string;
}

export interface CreateRoomInput {
  name: string;
  projectName?: string;
  repository: string;
  defaultBranch?: string;
  hostName: string;
  hostAgent?: string;
  clientVersion?: string;
  protocolVersion?: number;
  schemaVersion?: number;
}

export interface CreateRoomResult {
  room: Room;
  member: Member;
  roomToken: string;
  memberToken: string;
}

export interface JoinRoomInput {
  roomToken: string;
  displayName: string;
  agent?: string;
  clientVersion?: string;
  protocolVersion?: number;
  schemaVersion?: number;
}

export interface JoinRoomResult {
  room: Room;
  member: Member;
  memberToken: string;
}

/**
 * Requests that the authenticated member's local integration is paused.
 *
 * `cutoffAt` is a client request timestamp used for idempotency. The applied
 * cleanup boundary is captured from the room server clock on first handling;
 * clients do not create new remote work while a delayed request is pending.
 */
export interface PauseMemberInput {
  memberToken: string;
  reason: string;
  cutoffAt: string;
  requestId: string;
}

export interface PauseMemberResult {
  requestId: string;
  roomId: string;
  memberId: string;
  memberRole: MemberRole;
  reason: string;
  cutoffAt: string;
  appliedAt: string;
  alreadyApplied: boolean;
  closedSessionIds: string[];
  releasedLeaseIds: string[];
  cancelledReleaseRequestIds: string[];
  expiredConfirmationIds: string[];
  closedSessionCount: number;
  releasedLeaseCount: number;
  cancelledReleaseRequestCount: number;
  expiredConfirmationCount: number;
}

export interface ClaimLeaseInput {
  memberToken: string;
  sessionId?: string;
  title: string;
  objective?: string;
  branch?: string;
  baseCommit?: string;
  paths: string[];
  mode?: LeaseMode;
  kind?: LeaseKind;
  overrideReason?: string;
  ttlMs?: number;
  ttlMinutes?: number;
  autoClaim?: boolean;
}

export interface RenewLeaseInput {
  memberToken: string;
  leaseId: string;
  sessionId?: string;
  ttlMs?: number;
  ttlMinutes?: number;
}

export interface ResolveReleaseRequestInput {
  memberToken: string;
  requestId: string;
  decision: "approve" | "reject";
  reason?: string;
}

export interface ListReleaseRequestsInput {
  memberToken: string;
  status?: ReleaseRequestStatus | "all";
}

export interface ProjectRecord {
  id: string;
  roomId: string;
  memberId: string;
  memberName: string;
  kind: RecordKind;
  title: string;
  summary: string;
  paths: string[];
  status: string;
  evidence: string[];
  commitHash: string | null;
  createdAt: string;
}

export interface WorkSession {
  id: string;
  roomId: string;
  memberId: string;
  clientName: string | null;
  agentName: string | null;
  repository: string | null;
  branch: string | null;
  worktree: string | null;
  baseCommit: string | null;
  task: string | null;
  status: "active" | "frozen" | "finalizing" | "closed";
  branchEpoch: number;
  frozenReason: string | null;
  metadata: Record<string, unknown>;
  openedAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  clientVersion: string | null;
  protocolVersion: number | null;
  schemaVersion: number | null;
  codexSessionId: string | null;
  currentTurnId: string | null;
  activityEpoch: number;
  turnStoppedAt: string | null;
  /** 仅用于打开会话响应，表明服务端复用了同一 Codex 身份的未关闭会话。 */
  reused?: boolean;
}

export interface LocalScan {
  id: string;
  sessionId: string;
  roomId: string;
  memberId: string;
  repository: string | null;
  branch: string | null;
  worktree: string | null;
  baseCommit: string | null;
  changedPaths: string[];
  ruleFiles: string[];
  systems: string[];
  metadata: Record<string, unknown>;
  scannedAt: string;
}

export interface RoomSettings {
  autoLockAfterAutoClaim: boolean;
  blockingProtectionEnabled: boolean;
  automaticLeaseTtlMinutes: 5 | 10 | 15 | 30 | 60;
  maximumExclusiveLeaseMinutes: number;
  riskPolicyVersion: number;
  riskRules: RiskPolicyRule[];
  updatedAt: string;
  updatedBy: string;
}

export interface ContextExport {
  format: "agent-hub-context";
  version: 1;
  room: { id: string; name: string; projectName: string };
  exportedAt: string;
  contextEntries: Array<Omit<ContextEntry, "id" | "roomId" | "authorMemberId"> & { originalId?: string }>;
  decisions: Array<Omit<Decision, "id" | "roomId" | "authorMemberId"> & { originalId?: string }>;
  verifications: Array<Omit<Verification, "id" | "roomId" | "authorMemberId"> & { originalId?: string }>;
  handoffs: Array<Omit<Handoff, "id" | "roomId" | "fromMemberId" | "toMemberId" | "leaseId"> & { originalId?: string }>;
  records: Array<Omit<ProjectRecord, "id" | "roomId" | "memberId"> & { originalId?: string }>;
}

export interface ReleaseLeaseInput {
  memberToken: string;
  leaseId: string;
  sessionId?: string;
  status?: LeaseCompletionStatus;
  summary?: string;
}

export interface CheckEditsInput {
  memberToken: string;
  sessionId?: string;
  paths: string[];
  leaseId?: string;
  proposedEdits?: ProposedFeatureEdit[];
}

export interface AddContextEntryInput {
  memberToken: string;
  kind: ContextKind;
  title: string;
  content: string;
  paths?: string[];
}

export interface AddDecisionInput {
  memberToken: string;
  title: string;
  decision: string;
  rationale?: string;
  paths?: string[];
}

export interface AddVerificationInput {
  memberToken: string;
  sessionId?: string;
  leaseId?: string;
  kind: VerificationKind;
  result: VerificationResult;
  summary: string;
  command?: string;
  evidence?: string;
}

export interface AddHandoffInput {
  memberToken: string;
  sessionId?: string;
  leaseId?: string;
  toMemberId?: string;
  summary: string;
  completed?: string[];
  remaining?: string[];
  risks?: string[];
}

export interface ListActivityInput {
  memberToken: string;
  limit?: number;
  after?: string;
}

export interface PathRiskClassification {
  risk: PathRisk;
  reason: string | null;
}

const UNITY_SERIALIZED_EXTENSIONS = new Set([
  ".anim",
  ".asset",
  ".controller",
  ".cubemap",
  ".flare",
  ".fontsettings",
  ".guiskin",
  ".inputactions",
  ".lighting",
  ".mat",
  ".meta",
  ".mixer",
  ".overridecontroller",
  ".physicmaterial",
  ".physicsmaterial2d",
  ".playable",
  ".prefab",
  ".preset",
  ".rendertexture",
  ".scene",
  ".shadergraph",
  ".shadervariants",
  ".spriteatlas",
  ".terrainlayer",
  ".unity",
  ".vfx",
]);

const CONFIG_EXTENSIONS = new Set([
  ".asmdef",
  ".asmref",
  ".cfg",
  ".config",
  ".csv",
  ".ini",
  ".json",
  ".lock",
  ".properties",
  ".toml",
  ".tsv",
  ".xls",
  ".xlsx",
  ".xml",
  ".yaml",
  ".yml",
]);

const HIGH_RISK_DIRECTORY_PREFIXES = [
  ".git/",
  ".github/workflows/",
  "assets/animations/",
  "assets/prefabs/",
  "assets/scenes/",
  "packages/",
  "projectsettings/",
  "usersettings/",
];

export function normalizeRepoPath(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError("Repository path must be a string.");
  }

  const trimmed = input.trim().normalize("NFC");
  if (trimmed.length === 0) {
    throw new Error("Repository path cannot be empty.");
  }
  if (trimmed.length > 1024) {
    throw new Error("Repository path cannot exceed 1024 characters.");
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || /^[\\/]{1,2}/.test(trimmed)) {
    throw new Error("Repository path must be relative to the repository root.");
  }
  if (/[*?\[\]\0-\x1f]/.test(trimmed)) {
    throw new Error("Repository path cannot contain wildcards or control characters.");
  }

  const segments = trimmed.replace(/\\/g, "/").split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      throw new Error("Repository path cannot escape the repository root.");
    }
    normalized.push(segment);
  }

  if (normalized.length === 0) {
    return ".";
  }
  return normalized.join("/");
}

export function pathComparisonKey(path: string): string {
  return normalizeRepoPath(path).toLocaleLowerCase("en-US");
}

export function pathsOverlap(left: string, right: string): boolean {
  const leftKey = pathComparisonKey(left);
  const rightKey = pathComparisonKey(right);
  if (leftKey === "." || rightKey === ".") {
    return true;
  }
  return (
    leftKey === rightKey ||
    leftKey.startsWith(`${rightKey}/`) ||
    rightKey.startsWith(`${leftKey}/`)
  );
}

export function pathScopeCovers(scope: string, candidate: string): boolean {
  const scopeKey = pathComparisonKey(scope);
  const candidateKey = pathComparisonKey(candidate);
  return (
    scopeKey === "." ||
    scopeKey === candidateKey ||
    candidateKey.startsWith(`${scopeKey}/`)
  );
}

export function classifyPathRisk(input: string): PathRiskClassification {
  const normalized = normalizeRepoPath(input);
  const key = normalized.toLocaleLowerCase("en-US");
  if (key === ".") {
    return { risk: "high", reason: "A repository-wide scope requires exclusive access." };
  }

  const extensionIndex = key.lastIndexOf(".");
  const slashIndex = key.lastIndexOf("/");
  const extension = extensionIndex > slashIndex ? key.slice(extensionIndex) : "";
  if (UNITY_SERIALIZED_EXTENSIONS.has(extension)) {
    return {
      risk: "high",
      reason: "Unity serialized assets and metadata require exclusive access.",
    };
  }
  if (CONFIG_EXTENSIONS.has(extension)) {
    return {
      risk: "high",
      reason: "Configuration and structured data files require exclusive access.",
    };
  }
  if (
    HIGH_RISK_DIRECTORY_PREFIXES.some(
      (prefix) => key === prefix.slice(0, -1) || key.startsWith(prefix),
    )
  ) {
    return {
      risk: "high",
      reason: "This Unity or project configuration directory requires exclusive access.",
    };
  }
  if (key.split("/").includes("luban")) {
    return {
      risk: "high",
      reason: "Luban source and generation scopes require exclusive access.",
    };
  }
  return { risk: "normal", reason: null };
}

export function normalizePathList(paths: string[], allowEmpty = false): LeasePath[] {
  if (!Array.isArray(paths) || (!allowEmpty && paths.length === 0)) {
    throw new Error(allowEmpty ? "Paths must be an array." : "At least one path is required.");
  }
  if (paths.length > 100) {
    throw new Error("A request cannot contain more than 100 paths.");
  }

  const deduplicated = new Map<string, LeasePath>();
  for (const rawPath of paths) {
    const path = normalizeRepoPath(rawPath);
    const key = path.toLocaleLowerCase("en-US");
    if (!deduplicated.has(key)) {
      const classification = classifyPathRisk(path);
      deduplicated.set(key, {
        path,
        risk: classification.risk,
        riskReason: classification.reason,
      });
    }
  }
  return [...deduplicated.values()];
}
