import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  CONTEXT_KINDS,
  VERIFICATION_KINDS,
  VERIFICATION_RESULTS,
  normalizePathList,
  pathComparisonKey,
  pathScopeCovers,
  pathsOverlap,
  type Activity,
  type AddContextEntryInput,
  type AddDecisionInput,
  type AddHandoffInput,
  type AddVerificationInput,
  type CheckEditsInput,
  type ContextEntry,
  type CreateRoomInput,
  type CreateRoomResult,
  type Decision,
  type EditCheckResult,
  type Handoff,
  type JoinRoomInput,
  type JoinRoomResult,
  type Lease,
  type LeaseClaimResult,
  type LeaseConflict,
  type LeaseKind,
  type LeaseMode,
  type ListReleaseRequestsInput,
  type ListActivityInput,
  type LocalScan,
  type Member,
  type ProjectRecord,
  type RecordKind,
  type ReleaseLeaseInput,
  type ReleaseRequest,
  type ResolveReleaseRequestInput,
  type RenewLeaseInput,
  type Room,
  type RoomSnapshot,
  type Verification,
  type WorkSession,
  type ClaimLeaseInput,
  type ContextExport,
  type RoomSettings,
  type FeatureMemoryQueryInput,
  type FeatureMemoryQueryResult,
  type FeatureRevision,
  type FeatureVerificationEvidence,
  type ResolveFeatureConfirmationInput,
  type RollbackFeatureRevisionInput,
  type SubmitFeatureRevisionInput,
} from "./domain.js";
import { AgentHubDatabase } from "./db.js";
import {
  evaluateRealtimeOverlaps,
  resolveLeaseDurationMinutes,
  shouldHeartbeatRenew,
} from "./lease-policy.js";
import {
  createDefaultRiskPolicy,
  normalizeRiskPolicyRules,
  type RiskPolicy,
  type RiskPolicyRule,
} from "./risk-policy.js";
import {
  AGENT_HUB_PROTOCOL_VERSION,
  AGENT_HUB_SCHEMA_VERSION,
} from "../shared/version.js";
import {
  FeatureMemoryError,
  FeatureMemoryStore,
  type FeatureMemoryActor,
  type FeatureMemorySession,
} from "./feature-memory.js";

const AUTOMATIC_TTL_OPTIONS = [5, 10, 15, 30, 60] as const;
const DEFAULT_AUTOMATIC_TTL_MINUTES = 10;
const DEFAULT_MAXIMUM_EXCLUSIVE_LEASE_MINUTES = 24 * 60;
const RELEASE_REQUEST_COOLDOWN_MS = 2 * 60 * 1000;
const MAX_ACTIVITY_LIMIT = 200;
const FEATURE_SUBMITTED_TARGET_PATHS_KEY = "agentHubSubmittedTargetPaths";

type Row = Record<string, unknown>;

interface FeaturePromotionClaims {
  branch: string | null;
  finalCommit?: string;
  gitEvidence?: Record<string, unknown>;
  verifications: FeatureVerificationEvidence[];
  paths: string[];
}

interface FeatureEvidenceAttestation {
  version: 1 | 2;
  branch: string;
  baseCommit: string;
  finalCommit: string;
  committed: boolean;
  committedPathCount: number;
  uncommittedPathCount: number;
  changedPathCount: number;
  changedPathsSha256: string;
  commitHashCount: number;
  commitHashesSha256: string;
  finalCommitIncluded: boolean;
  diffSha256: string;
}

export interface AuthenticatedMember {
  room: Room;
  member: Member;
}

export interface AddRecordInput {
  memberToken: string;
  kind: RecordKind;
  title: string;
  summary: string;
  paths?: string[];
  status?: string;
  evidence?: string[];
  commitHash?: string;
}

export interface OpenSessionInput {
  memberToken: string;
  clientName?: string;
  agentName?: string;
  repository?: string;
  branch?: string;
  worktree?: string;
  baseCommit?: string;
  task?: string;
  metadata?: Record<string, unknown>;
  clientVersion?: string;
  protocolVersion?: number;
  schemaVersion?: number;
}

export interface RecordLocalScanInput {
  memberToken: string;
  sessionId: string;
  repository?: string;
  branch?: string;
  worktree?: string;
  baseCommit?: string;
  changedPaths?: string[];
  ruleFiles?: string[];
  systems?: string[];
  metadata?: Record<string, unknown>;
}

export interface CloseSessionInput {
  memberToken: string;
  sessionId: string;
  summary?: string;
}

export interface CloseLeaseReportInput extends ReleaseLeaseInput {
  outcome?: string;
  changedPaths?: string[];
  commitHash?: string;
  validations?: string[];
  remainingRisks?: string[];
  handoff?: string;
}

export interface RelevantContextResult {
  room: Room;
  members: Member[];
  activeLeases: Lease[];
  contextEntries: ContextEntry[];
  decisions: Decision[];
  verifications: Verification[];
  handoffs: Handoff[];
  records: ProjectRecord[];
  sessions: WorkSession[];
  localScans: LocalScan[];
  generatedAt: string;
}

export interface DashboardData {
  room: Room;
  currentMember: Member;
  members: Member[];
  leases: Lease[];
  conflicts: LeaseConflict[];
  records: ProjectRecord[];
  activity: Activity[];
  sessions: WorkSession[];
  localScans: LocalScan[];
  settings: RoomSettings;
  releaseRequests: ReleaseRequest[];
}

export interface UpdateRoomSettingsInput {
  memberToken: string;
  autoLockAfterAutoClaim?: boolean;
  blockingProtectionEnabled?: boolean;
  automaticLeaseTtlMinutes?: number;
  maximumExclusiveLeaseMinutes?: number;
  riskRules?: RiskPolicyRule[];
  resetRiskPolicy?: boolean;
}

export interface HeartbeatSessionInput {
  memberToken: string;
  sessionId: string;
  clientVersion?: string;
  protocolVersion?: number;
  schemaVersion?: number;
}

export interface ChangeMemberRoleInput {
  memberToken: string;
  targetMemberId: string;
  isAdmin: boolean;
}

export interface RemoveMemberInput {
  memberToken: string;
  targetMemberId: string;
}

export interface TransferOwnershipInput {
  memberToken: string;
  targetMemberId: string;
}

export interface ImportContextInput {
  memberToken: string;
  payload: unknown;
}

export interface SyncSessionBranchInput {
  memberToken: string;
  sessionId: string;
  branch?: string;
  baseCommit?: string;
}

export interface RebaselineSessionInput extends SyncSessionBranchInput {}

export interface AgentHubServiceOptions {
  now?: () => Date;
}

export class AgentHubError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = "AgentHubError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class AgentHubService {
  private readonly now: () => Date;
  private readonly featureMemory: FeatureMemoryStore;

  constructor(
    readonly database: AgentHubDatabase,
    options: AgentHubServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.featureMemory = new FeatureMemoryStore(database, this.now);
  }

  createRoom(input: CreateRoomInput): CreateRoomResult {
    const name = requiredString(input.name, "Room name", 120);
    const projectName = optionalString(input.projectName, "Project name", 160) ?? name;
    const repository = requiredString(input.repository, "Repository", 1000);
    const defaultBranch = optionalString(input.defaultBranch, "Default branch", 255) ?? "main";
    const hostName = requiredString(input.hostName, "Owner name", 120);
    const hostAgent = optionalString(input.hostAgent, "Client name", 160);
    const clientVersion = optionalString(input.clientVersion, "Client version", 80);
    const protocolVersion = optionalVersionNumber(input.protocolVersion, "Protocol version");
    const schemaVersion = optionalVersionNumber(input.schemaVersion, "Schema version");
    const defaultRiskPolicy = createDefaultRiskPolicy();
    const createdAt = this.timestamp();
    const roomId = randomUUID();
    const memberId = randomUUID();
    const memberToken = createMemberToken();
    const code = this.createUniqueInviteCode();

    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO rooms (
            id, code, name, project_name, repository, default_branch, created_at,
            blocking_protection_enabled, automatic_lease_ttl_minutes,
            maximum_exclusive_lease_minutes, risk_policy_version, risk_policy_rules_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        `)
        .run(
          roomId,
          code,
          name,
          projectName,
          repository,
          defaultBranch,
          createdAt,
          DEFAULT_AUTOMATIC_TTL_MINUTES,
          DEFAULT_MAXIMUM_EXCLUSIVE_LEASE_MINUTES,
          defaultRiskPolicy.version,
          json(defaultRiskPolicy.rules),
        );
      this.database.connection
        .prepare(`
          INSERT INTO members
            (id, room_id, name, role, client_name, token_hash, created_at, last_seen_at,
             client_version, protocol_version, schema_version)
          VALUES (?, ?, ?, 'host', ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          memberId,
          roomId,
          hostName,
          hostAgent,
          hashToken(memberToken),
          createdAt,
          createdAt,
          clientVersion,
          protocolVersion,
          schemaVersion,
        );
      this.database.connection.prepare(`
        INSERT OR REPLACE INTO risk_policy_versions
          (room_id, version, rules_json, author_member_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(roomId, defaultRiskPolicy.version, json(defaultRiskPolicy.rules), memberId, createdAt);
      this.insertActivity({
        roomId,
        actorMemberId: memberId,
        actorName: hostName,
        type: "room.created",
        entityType: "room",
        entityId: roomId,
        summary: `${hostName} created the room.`,
        metadata: { projectName, repository, defaultBranch },
        createdAt,
      });
    });

    return {
      room: this.requireRoomById(roomId),
      member: this.requireMemberById(memberId),
      roomToken: code,
      memberToken,
    };
  }

  joinRoom(input: JoinRoomInput): JoinRoomResult {
    const code = normalizeInviteCode(input.roomToken);
    const displayName = requiredString(input.displayName, "Member name", 120);
    const agent = optionalString(input.agent, "Client name", 160);
    const clientVersion = optionalString(input.clientVersion, "Client version", 80);
    const protocolVersion = optionalVersionNumber(input.protocolVersion, "Protocol version");
    const schemaVersion = optionalVersionNumber(input.schemaVersion, "Schema version");
    const row = this.database.connection
      .prepare("SELECT id FROM rooms WHERE code = ? COLLATE NOCASE")
      .get(code) as Row | undefined;
    if (!row) {
      throw new AgentHubError("invite_not_found", "The invitation code is invalid.", 404);
    }

    const roomId = asString(row.id);
    const memberId = randomUUID();
    const token = createMemberToken();
    const createdAt = this.timestamp();
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO members
            (id, room_id, name, role, client_name, token_hash, created_at, last_seen_at,
             client_version, protocol_version, schema_version)
          VALUES (?, ?, ?, 'member', ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          memberId,
          roomId,
          displayName,
          agent,
          hashToken(token),
          createdAt,
          createdAt,
          clientVersion,
          protocolVersion,
          schemaVersion,
        );
      this.insertActivity({
        roomId,
        actorMemberId: memberId,
        actorName: displayName,
        type: "member.joined",
        entityType: "member",
        entityId: memberId,
        summary: `${displayName} joined the room.`,
        metadata: { clientName: agent },
        createdAt,
      });
    });

    return {
      room: this.requireRoomById(roomId),
      member: this.requireMemberById(memberId),
      memberToken: token,
    };
  }

  authenticateMemberToken(memberToken: string): AuthenticatedMember {
    const token = requiredString(memberToken, "Member token", 512);
    const row = this.database.connection
      .prepare(`
        SELECT
          m.id AS member_id, m.room_id, m.name AS member_name, m.role, m.client_name,
          m.created_at AS member_created_at, m.last_seen_at, m.is_admin, m.removed_at,
          m.client_version, m.protocol_version, m.schema_version,
          r.code, r.name AS room_name, r.project_name, r.repository,
          r.default_branch, r.created_at AS room_created_at, r.status AS room_status,
          r.auto_lock_after_auto_claim, r.settings_updated_at, r.settings_updated_by
        FROM members m
        JOIN rooms r ON r.id = m.room_id
        WHERE m.token_hash = ?
      `)
      .get(hashToken(token)) as Row | undefined;
    if (!row) {
      throw new AgentHubError("unauthorized", "The member token is invalid.", 401);
    }
    if (row.removed_at) throw new AgentHubError("member_removed", "This member has been removed from the room.", 403);
    if ((typeof row.room_status === "string" ? row.room_status : "active") === "dissolved") throw new AgentHubError("room_dissolved", "This room has been dissolved.", 410);

    const lastSeenAt = this.timestamp();
    this.database.connection
      .prepare("UPDATE members SET last_seen_at = ? WHERE id = ?")
      .run(lastSeenAt, asString(row.member_id));
    row.last_seen_at = lastSeenAt;
    return {
      room: mapRoom(row),
      member: mapMember(row),
    };
  }

  getSnapshot(memberToken: string): RoomSnapshot {
    const auth = this.authenticateMemberToken(memberToken);
    this.expireLeases(auth.room.id);
    this.reconcileReleaseRequests(auth.room.id);
    return {
      room: auth.room,
      settings: this.readRoomSettings(auth.room.id, auth.room.createdAt, auth.member.displayName),
      members: this.listMembers(auth.room.id),
      activeLeases: this.listLeases(auth.room.id, true),
      contextEntries: this.listContextEntries(auth.room.id),
      decisions: this.listDecisions(auth.room.id),
      verifications: this.listVerifications(auth.room.id),
      handoffs: this.listHandoffs(auth.room.id),
      records: this.listRecords(auth.room.id),
      sessions: this.listSessions(auth.room.id),
      localScans: this.listLocalScans(auth.room.id),
      activities: this.listActivitiesByRoom(auth.room.id, 100),
      releaseRequests: this.listReleaseRequestsByRoom(auth.room.id, "pending"),
      generatedAt: this.timestamp(),
    };
  }

  getDashboard(memberToken: string): DashboardData {
    const auth = this.authenticateMemberToken(memberToken);
    this.expireLeases(auth.room.id);
    this.reconcileReleaseRequests(auth.room.id);
    return {
      room: auth.room,
      currentMember: auth.member,
      members: this.listMembers(auth.room.id),
      leases: this.listLeases(auth.room.id, true),
      conflicts: this.listConflicts(auth.room.id),
      records: this.listRecords(auth.room.id),
      activity: this.listActivitiesByRoom(auth.room.id, 100),
      sessions: this.listSessions(auth.room.id),
      localScans: this.listLocalScans(auth.room.id),
      settings: this.readRoomSettings(auth.room.id, auth.room.createdAt, auth.member.displayName),
      releaseRequests: this.listReleaseRequestsByRoom(auth.room.id, "pending"),
    };
  }

  getRoomSettings(memberToken: string): RoomSettings {
    const auth = this.authenticateMemberToken(memberToken);
    return this.readRoomSettings(auth.room.id, auth.room.createdAt, auth.member.displayName);
  }

  updateRoomSettings(input: UpdateRoomSettingsInput): RoomSettings {
    const auth = this.authenticateMemberToken(input.memberToken);
    this.requireOwner(auth);
    const previous = this.readRoomSettings(auth.room.id, auth.room.createdAt, auth.member.displayName);
    if (input.riskRules !== undefined && input.resetRiskPolicy) {
      throw new AgentHubError("invalid_setting", "riskRules and resetRiskPolicy cannot be used together.");
    }
    const hasSetting = input.autoLockAfterAutoClaim !== undefined
      || input.blockingProtectionEnabled !== undefined
      || input.automaticLeaseTtlMinutes !== undefined
      || input.maximumExclusiveLeaseMinutes !== undefined
      || input.riskRules !== undefined
      || input.resetRiskPolicy === true;
    if (!hasSetting) throw new AgentHubError("invalid_setting", "At least one room setting is required.");

    const blockingProtectionEnabled = input.blockingProtectionEnabled
      ?? input.autoLockAfterAutoClaim
      ?? previous.blockingProtectionEnabled;
    if (typeof blockingProtectionEnabled !== "boolean") {
      throw new AgentHubError("invalid_setting", "blockingProtectionEnabled must be boolean.");
    }
    const automaticLeaseTtlMinutes = input.automaticLeaseTtlMinutes === undefined
      ? previous.automaticLeaseTtlMinutes
      : normalizeAutomaticTtlMinutes(input.automaticLeaseTtlMinutes);
    const maximumExclusiveLeaseMinutes = input.maximumExclusiveLeaseMinutes === undefined
      ? previous.maximumExclusiveLeaseMinutes
      : normalizeMaximumExclusiveLeaseMinutes(input.maximumExclusiveLeaseMinutes);
    let riskRules = previous.riskRules;
    let riskPolicyVersion = previous.riskPolicyVersion;
    if (input.resetRiskPolicy || input.riskRules !== undefined) {
      try {
        riskRules = input.resetRiskPolicy
          ? createDefaultRiskPolicy().rules
          : normalizeRiskPolicyRules(input.riskRules ?? []);
      } catch (error) {
        throw new AgentHubError(
          "invalid_risk_policy",
          error instanceof Error ? error.message : "The risk policy is invalid.",
        );
      }
      riskPolicyVersion += 1;
    }
    const now = this.timestamp();
    this.database.transaction(() => {
      this.database.connection.prepare(`
        UPDATE rooms SET
          auto_lock_after_auto_claim = ?, blocking_protection_enabled = ?,
          automatic_lease_ttl_minutes = ?, maximum_exclusive_lease_minutes = ?,
          risk_policy_version = ?, risk_policy_rules_json = ?,
          settings_updated_at = ?, settings_updated_by = ?
        WHERE id = ?
      `).run(
        blockingProtectionEnabled ? 1 : 0,
        blockingProtectionEnabled ? 1 : 0,
        automaticLeaseTtlMinutes,
        maximumExclusiveLeaseMinutes,
        riskPolicyVersion,
        json(riskRules),
        now,
        auth.member.id,
        auth.room.id,
      );
      if (riskPolicyVersion !== previous.riskPolicyVersion) {
        this.database.connection.prepare(`
          INSERT INTO risk_policy_versions
            (room_id, version, rules_json, author_member_id, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(auth.room.id, riskPolicyVersion, json(riskRules), auth.member.id, now);
      }
      this.auditRecord(
        auth,
        "room.settings.updated",
        "room",
        auth.room.id,
        `${auth.member.displayName} updated room coordination settings.`,
        {
          previous: {
            blockingProtectionEnabled: previous.blockingProtectionEnabled,
            automaticLeaseTtlMinutes: previous.automaticLeaseTtlMinutes,
            maximumExclusiveLeaseMinutes: previous.maximumExclusiveLeaseMinutes,
            riskPolicyVersion: previous.riskPolicyVersion,
          },
          current: {
            blockingProtectionEnabled,
            automaticLeaseTtlMinutes,
            maximumExclusiveLeaseMinutes,
            riskPolicyVersion,
          },
        },
      );
    });
    return {
      autoLockAfterAutoClaim: blockingProtectionEnabled,
      blockingProtectionEnabled,
      automaticLeaseTtlMinutes,
      maximumExclusiveLeaseMinutes,
      riskPolicyVersion,
      riskRules,
      updatedAt: now,
      updatedBy: auth.member.displayName,
    };
  }

  changeMemberRole(input: ChangeMemberRoleInput): Member {
    const auth = this.authenticateMemberToken(input.memberToken);
    this.requireOwner(auth);
    const target = this.requireRoomMember(input.targetMemberId, auth.room.id);
    if (target.role === "host") throw new AgentHubError("owner_role_immutable", "The owner cannot be changed to an administrator.", 409);
    const now = this.timestamp();
    this.database.transaction(() => {
      this.database.connection.prepare("UPDATE members SET is_admin = ? WHERE id = ? AND room_id = ? AND removed_at IS NULL").run(input.isAdmin ? 1 : 0, target.id, auth.room.id);
      this.auditRecord(auth, input.isAdmin ? "member.admin_granted" : "member.admin_revoked", "member", target.id, `${auth.member.displayName} changed ${target.displayName}'s administrator status.`, { isAdmin: input.isAdmin });
    });
    return this.requireMemberById(target.id);
  }

  removeMember(input: RemoveMemberInput): void {
    const auth = this.authenticateMemberToken(input.memberToken);
    const target = this.requireRoomMember(input.targetMemberId, auth.room.id);
    if (target.id === auth.member.id || target.role === "host") throw new AgentHubError("member_remove_forbidden", "The owner cannot be removed and members cannot remove themselves.", 403);
    if (!this.isOwner(auth) && (!auth.member.isAdmin || target.isAdmin)) throw new AgentHubError("member_remove_forbidden", "Only the owner can remove administrators.", 403);
    const now = this.timestamp();
    this.database.transaction(() => {
      const activeLeases = this.database.connection.prepare(`
        SELECT id FROM leases
        WHERE room_id = ? AND member_id = ? AND status = 'active'
      `).all(auth.room.id, target.id) as Row[];
      const pendingReleaseRequests = this.database.connection.prepare(`
        SELECT DISTINCT rr.id
        FROM release_requests rr
        JOIN leases holder_lease ON holder_lease.id = rr.conflicting_lease_id
        WHERE rr.room_id = ? AND rr.status = 'pending'
          AND (rr.requester_member_id = ? OR holder_lease.member_id = ?)
      `).all(auth.room.id, target.id, target.id) as Row[];
      const cancelledLeaseIds = activeLeases.map((row) => asString(row.id));
      const cancelledReleaseRequestIds = pendingReleaseRequests.map((row) => asString(row.id));
      const cancellationSummary = `Cancelled because ${target.displayName} was removed from the room.`;
      const cancelLease = this.database.connection.prepare(`
        UPDATE leases SET status = 'cancelled', completed_at = ?, updated_at = ?,
          completion_summary = ?
        WHERE id = ? AND status = 'active'
      `);
      for (const leaseId of cancelledLeaseIds) {
        cancelLease.run(now, now, cancellationSummary, leaseId);
      }
      const cancelReleaseRequest = this.database.connection.prepare(`
        UPDATE release_requests
        SET status = 'cancelled', decision_member_id = ?, resolved_at = ?
        WHERE id = ? AND status = 'pending'
      `);
      for (const requestId of cancelledReleaseRequestIds) {
        cancelReleaseRequest.run(auth.member.id, now, requestId);
      }
      this.database.connection.prepare("UPDATE members SET removed_at = ?, token_hash = ? WHERE id = ? AND room_id = ?").run(now, `revoked_${randomUUID()}`, target.id, auth.room.id);
      this.auditRecord(
        auth,
        "member.removed",
        "member",
        target.id,
        `${auth.member.displayName} removed ${target.displayName} from the room.`,
        {
          cancelledLeaseCount: cancelledLeaseIds.length,
          cancelledLeaseIds,
          cancelledReleaseRequestCount: cancelledReleaseRequestIds.length,
          cancelledReleaseRequestIds,
        },
      );
    });
  }

  transferOwnership(input: TransferOwnershipInput): Member {
    const auth = this.authenticateMemberToken(input.memberToken);
    this.requireOwner(auth);
    const target = this.requireRoomMember(input.targetMemberId, auth.room.id);
    if (target.id === auth.member.id) throw new AgentHubError("owner_transfer_invalid", "The owner is already this member.", 409);
    const now = this.timestamp();
    this.database.transaction(() => {
      this.database.connection.prepare("UPDATE members SET role = 'member', is_admin = 0 WHERE id = ?").run(auth.member.id);
      this.database.connection.prepare("UPDATE members SET role = 'host', is_admin = 0 WHERE id = ? AND room_id = ? AND removed_at IS NULL").run(target.id, auth.room.id);
      this.auditRecord(auth, "room.owner_transferred", "member", target.id, `${auth.member.displayName} transferred room ownership to ${target.displayName}.`, { previousOwnerId: auth.member.id });
    });
    return this.requireMemberById(target.id);
  }

  dissolveRoom(memberToken: string): void {
    const auth = this.authenticateMemberToken(memberToken);
    this.requireOwner(auth);
    const now = this.timestamp();
    this.database.transaction(() => {
      this.database.connection.prepare("UPDATE rooms SET status = 'dissolved', dissolved_at = ? WHERE id = ?").run(now, auth.room.id);
      this.database.connection.prepare("UPDATE members SET token_hash = ? WHERE room_id = ?").run(`revoked_${randomUUID()}`, auth.room.id);
      this.auditRecord(auth, "room.dissolved", "room", auth.room.id, `${auth.member.displayName} dissolved the room.`, {});
    });
  }

  exportContext(memberToken: string): ContextExport {
    const auth = this.authenticateMemberToken(memberToken);
    this.requireAdmin(auth);
    return {
      format: "agent-hub-context",
      version: 1,
      room: { id: auth.room.id, name: auth.room.name, projectName: auth.room.projectName },
      exportedAt: this.timestamp(),
      contextEntries: this.listContextEntries(auth.room.id).map(({ id, roomId, authorMemberId, ...entry }) => ({ ...entry, originalId: id })),
      decisions: this.listDecisions(auth.room.id).map(({ id, roomId, authorMemberId, ...entry }) => ({ ...entry, originalId: id })),
      verifications: this.listVerifications(auth.room.id).map(({ id, roomId, authorMemberId, ...entry }) => ({ ...entry, originalId: id })),
      handoffs: this.listHandoffs(auth.room.id).map(({ id, roomId, fromMemberId, toMemberId, leaseId, ...entry }) => ({ ...entry, originalId: id })),
      records: this.listRecords(auth.room.id).map(({ id, roomId, memberId, ...entry }) => ({ ...entry, originalId: id })),
    };
  }

  importContext(input: ImportContextInput): { imported: number; rejected: number } {
    const auth = this.authenticateMemberToken(input.memberToken);
    this.requireAdmin(auth);
    const payload = input.payload as Partial<ContextExport>;
    if (!payload || payload.format !== "agent-hub-context" || payload.version !== 1) throw new AgentHubError("invalid_context_export", "Unsupported context export format.");
    const arrays = [payload.contextEntries, payload.decisions, payload.verifications, payload.handoffs, payload.records];
    if (arrays.some((items) => !Array.isArray(items) || items.length > 500)) throw new AgentHubError("invalid_context_export", "Context export contains too many records.");
    let imported = 0;
    const now = this.timestamp();
    this.database.transaction(() => {
      for (const entry of payload.contextEntries ?? []) {
        const value = entry as any;
        this.database.connection.prepare("INSERT INTO context_entries (id, room_id, author_member_id, kind, title, content, paths_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), auth.room.id, auth.member.id, value.kind, requiredString(value.title, "Context title", 200), requiredString(value.content, "Context content", 20000), json(normalizePathList(value.paths ?? [], true).map((p) => p.path)), now, now); imported++;
      }
      for (const entry of payload.decisions ?? []) {
        const value = entry as any;
        this.database.connection.prepare("INSERT INTO decisions (id, room_id, author_member_id, title, decision, rationale, paths_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), auth.room.id, auth.member.id, requiredString(value.title, "Decision title", 200), requiredString(value.decision, "Decision", 20000), optionalString(value.rationale, "Rationale", 10000) ?? null, json(normalizePathList(value.paths ?? [], true).map((p) => p.path)), now); imported++;
      }
      for (const entry of payload.verifications ?? []) {
        const value = entry as any;
        this.database.connection.prepare("INSERT INTO verifications (id, room_id, author_member_id, lease_id, kind, result, summary, command, evidence, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)").run(randomUUID(), auth.room.id, auth.member.id, value.kind, value.result, requiredString(value.summary, "Verification summary", 10000), optionalString(value.command, "Command", 10000) ?? null, optionalString(value.evidence, "Evidence", 10000) ?? null, now); imported++;
      }
      for (const entry of payload.handoffs ?? []) {
        const value = entry as any;
        this.database.connection.prepare("INSERT INTO handoffs (id, room_id, from_member_id, to_member_id, lease_id, summary, completed_json, remaining_json, risks_json, created_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)").run(randomUUID(), auth.room.id, auth.member.id, requiredString(value.summary, "Handoff summary", 10000), json(stringArray(value.completed, "Completed", 100, 2000)), json(stringArray(value.remaining, "Remaining", 100, 2000)), json(stringArray(value.risks, "Risks", 100, 2000)), now); imported++;
      }
      for (const entry of payload.records ?? []) {
        const value = entry as any;
        const kind = normalizeRecordKind(value.kind);
        this.insertRecord(auth, { kind, title: requiredString(value.title, "Record title", 200), summary: requiredString(value.summary, "Record summary", 12000), paths: normalizePathList(value.paths ?? [], true).map((p) => p.path), status: optionalString(value.status, "Record status", 100) ?? defaultRecordStatus(kind), evidence: stringArray(value.evidence, "Record evidence", 100, 4000), commitHash: optionalString(value.commitHash, "Commit hash", 255) ?? null, createdAt: now }); imported++;
      }
      this.auditRecord(auth, "room.context.imported", "room", auth.room.id, `${auth.member.displayName} imported shared context.`, { imported });
    });
    return { imported, rejected: 0 };
  }

  getRelevantContext(memberToken: string, paths: string[] = []): RelevantContextResult {
    const snapshot = this.getSnapshot(memberToken);
    const scopes = normalizePathList(paths, true).map((entry) => entry.path);
    const relevant = (entryPaths: string[]) =>
      scopes.length === 0 ||
      entryPaths.length === 0 ||
      entryPaths.some((entryPath) => scopes.some((scope) => pathsOverlap(entryPath, scope)));

    return {
      room: snapshot.room,
      members: snapshot.members,
      activeLeases: snapshot.activeLeases.filter((lease) =>
        relevant(lease.paths.map((path) => path.path)),
      ),
      contextEntries: snapshot.contextEntries.filter((entry) => relevant(entry.paths)),
      decisions: snapshot.decisions.filter((entry) => relevant(entry.paths)),
      verifications: snapshot.verifications,
      handoffs: snapshot.handoffs,
      records: this.listRecords(snapshot.room.id).filter((entry) => relevant(entry.paths)),
      sessions: snapshot.sessions,
      localScans: snapshot.localScans.filter((scan) => relevant(scan.changedPaths)),
      generatedAt: snapshot.generatedAt,
    };
  }

  claimLease(input: ClaimLeaseInput): LeaseClaimResult {
    const auth = this.authenticateMemberToken(input.memberToken);
    const sessionId = this.activeOwnedSessionId(input.sessionId, auth);
    const title = requiredString(input.title, "Lease title", 200);
    const objective = optionalString(input.objective, "Lease intent", 4000) ?? "";
    const branch = optionalString(input.branch, "Branch", 255);
    const baseCommit = optionalString(input.baseCommit, "Base commit", 255);
    const mode = normalizeLeaseMode(input.mode);
    const kind = normalizeLeaseKind(input.kind, input.autoClaim);
    if (kind === "exclusive" && mode !== "write") {
      throw new AgentHubError("invalid_lease_kind", "A manual exclusive lease must use write mode.");
    }
    const overrideReason = optionalString(input.overrideReason, "Override reason", 1000);
    const paths = normalizePathList(input.paths);
    const settings = this.readRoomSettings(auth.room.id, auth.room.createdAt, auth.member.displayName);
    const requestedMinutes = input.ttlMinutes
      ?? (input.ttlMs === undefined ? undefined : input.ttlMs / 60_000);
    let durationMinutes: number;
    try {
      durationMinutes = resolveLeaseDurationMinutes(kind, requestedMinutes, settings);
    } catch (error) {
      throw new AgentHubError(
        "invalid_ttl",
        error instanceof Error ? error.message : "The lease duration is invalid.",
      );
    }
    const createdAt = this.timestamp();
    const expiresAt = new Date(this.now().getTime() + durationMinutes * 60_000).toISOString();

    return this.database.transaction(() => {
      this.expireLeases(auth.room.id, false);
      const reusableLease = this.listLeases(auth.room.id, true).find((lease) =>
        lease.memberId === auth.member.id
        && lease.sessionId === sessionId
        && lease.mode === mode
        && lease.kind === kind
        && paths.every((requestedPath) => lease.paths.some(
          (scope) => pathScopeCovers(scope.path, requestedPath.path),
        )),
      );
      const conflicts = mode === "write"
        ? this.findLeaseConflicts(
            auth.room.id,
            auth.member.id,
            sessionId,
            kind,
            paths,
            settings,
            reusableLease ? [reusableLease.id] : [],
          )
        : [];
      const hasBlocking = conflicts.some((conflict) => conflict.severity === "blocking");
      const hasWarning = conflicts.some((conflict) => conflict.severity === "warning");
      const decision = hasBlocking ? "deny" : hasWarning ? "warn" : "allow";
      const canAcquire = !hasBlocking;
      const leaseId = canAcquire ? reusableLease?.id ?? randomUUID() : null;
      const effectiveExpiresAt = reusableLease && !shouldHeartbeatRenew(reusableLease.kind)
        ? reusableLease.expiresAt
        : expiresAt;

      if (leaseId && !reusableLease) {
        this.database.connection
          .prepare(`
            INSERT INTO leases (
              id, room_id, member_id, session_id, title, intent, branch, base_commit, mode, kind, status,
              decision, override_reason, expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
          `)
          .run(
            leaseId,
            auth.room.id,
            auth.member.id,
            sessionId,
            title,
            objective,
            branch,
            baseCommit,
            mode,
            kind,
            decision,
            overrideReason,
            expiresAt,
            createdAt,
            createdAt,
          );
        const insertPath = this.database.connection.prepare(`
          INSERT INTO lease_paths (lease_id, path, path_key, risk, risk_reason)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const path of paths) {
          insertPath.run(leaseId, path.path, pathComparisonKey(path.path), path.risk, path.riskReason);
        }
      } else if (leaseId && reusableLease && shouldHeartbeatRenew(reusableLease.kind)) {
        this.database.connection.prepare(`
          UPDATE leases SET expires_at = ?, updated_at = ?, decision = ? WHERE id = ?
        `).run(effectiveExpiresAt, createdAt, decision, leaseId);
      }

      for (const conflict of conflicts) {
        this.database.connection
          .prepare(`
            INSERT INTO conflicts (
              id, room_id, requester_member_id, requested_lease_id, existing_lease_id,
              requested_path, existing_path, severity, decision, reason, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            conflict.id,
            auth.room.id,
            auth.member.id,
            leaseId,
            conflict.leaseId,
            conflict.requestedPath,
            conflict.existingPath,
            conflict.severity,
            conflict.decision,
            conflict.reason,
            createdAt,
          );
      }

      const releaseRequests = hasBlocking
        ? this.ensureReleaseRequests(auth, {
            sessionId,
            requesterLeaseId: null,
            title,
            objective,
            branch,
            baseCommit,
            kind,
            mode,
            requestedTtlMinutes: kind === "exclusive" ? durationMinutes : null,
            paths: paths.map((path) => path.path),
            conflicts,
            createdAt,
          })
        : [];

      if (!canAcquire || !leaseId) {
        this.insertActivity({
          roomId: auth.room.id,
          actorMemberId: auth.member.id,
          actorName: auth.member.displayName,
          type: "lease.rejected",
          entityType: "lease",
          entityId: null,
          summary:
            decision === "deny"
              ? `${auth.member.displayName}'s lease was denied by a blocking overlap.`
              : `${auth.member.displayName}'s lease could not be acquired.`,
          metadata: {
            title,
            kind,
            decision,
            paths: paths.map((path) => path.path),
            releaseRequestIds: releaseRequests.map((request) => request.id),
          },
          createdAt,
        });
        return { acquired: false, decision, conflicts, releaseRequests } as LeaseClaimResult;
      }

      this.insertActivity({
        roomId: auth.room.id,
        actorMemberId: auth.member.id,
        actorName: auth.member.displayName,
          type: reusableLease ? "lease.reused" : "lease.acquired",
        entityType: "lease",
        entityId: leaseId,
        summary: reusableLease
          ? `${auth.member.displayName} reused an existing ${kind} lease for ${title}.`
          : `${auth.member.displayName} registered ${mode} work: ${title}.`,
        metadata: {
          paths: paths.map((path) => path.path),
          decision,
          kind,
          expiresAt: effectiveExpiresAt,
          hasOverride: Boolean(overrideReason),
        },
        createdAt,
      });
      return {
        acquired: true,
        decision,
        lease: this.requireLeaseById(leaseId),
        conflicts,
        releaseRequests,
      } as LeaseClaimResult;
    });
  }

  renewLease(input: RenewLeaseInput): Lease {
    const auth = this.authenticateMemberToken(input.memberToken);
    const sessionId = this.activeOwnedSessionId(input.sessionId, auth);
    const updatedAt = this.timestamp();
    return this.database.transaction(() => {
      this.expireLeases(auth.room.id, false);
      const lease = this.requireOwnedLease(input.leaseId, auth);
      this.requireLeaseSession(lease, sessionId);
      if (lease.status !== "active") {
        throw new AgentHubError("lease_not_active", "Only an active lease can be renewed.", 409);
      }
      const settings = this.readRoomSettings(auth.room.id, auth.room.createdAt, auth.member.displayName);
      const requestedMinutes = input.ttlMinutes
        ?? (input.ttlMs === undefined ? undefined : input.ttlMs / 60_000);
      let durationMinutes: number;
      try {
        durationMinutes = resolveLeaseDurationMinutes(lease.kind, requestedMinutes, settings);
      } catch (error) {
        throw new AgentHubError(
          "invalid_ttl",
          error instanceof Error ? error.message : "The lease duration is invalid.",
        );
      }
      const expiresAt = new Date(this.now().getTime() + durationMinutes * 60_000).toISOString();
      this.database.connection
        .prepare("UPDATE leases SET expires_at = ?, updated_at = ? WHERE id = ?")
        .run(expiresAt, updatedAt, lease.id);
      this.insertActivity({
        roomId: auth.room.id,
        actorMemberId: auth.member.id,
        actorName: auth.member.displayName,
        type: "lease.renewed",
        entityType: "lease",
        entityId: lease.id,
        summary: `${auth.member.displayName} renewed ${lease.title}.`,
        metadata: { expiresAt, kind: lease.kind, durationMinutes, source: "explicit" },
        createdAt: updatedAt,
      });
      return this.requireLeaseById(lease.id);
    });
  }

  releaseLease(input: ReleaseLeaseInput): Lease {
    return this.closeLease(input).lease;
  }

  listReleaseRequests(input: ListReleaseRequestsInput): ReleaseRequest[] {
    const auth = this.authenticateMemberToken(input.memberToken);
    this.expireLeases(auth.room.id);
    this.reconcileReleaseRequests(auth.room.id);
    const status = input.status ?? "pending";
    if (status !== "all" && !["pending", "approved", "rejected", "cancelled"].includes(status)) {
      throw new AgentHubError("invalid_release_request_status", "The release request status is invalid.");
    }
    return this.listReleaseRequestsByRoom(auth.room.id, status);
  }

  resolveReleaseRequest(input: ResolveReleaseRequestInput): ReleaseRequest {
    const auth = this.authenticateMemberToken(input.memberToken);
    if (input.decision !== "approve" && input.decision !== "reject") {
      throw new AgentHubError(
        "invalid_release_request_decision",
        "Release request decision must be approve or reject.",
      );
    }
    const reason = optionalString(input.reason, "Release request decision reason", 2000);
    const resolvedAt = this.timestamp();
    return this.database.transaction(() => {
      this.expireLeases(auth.room.id, false);
      const row = this.requireReleaseRequestRow(input.requestId, auth.room.id);
      if (asString(row.holder_member_id) !== auth.member.id) {
        throw new AgentHubError(
          "release_request_forbidden",
          "Only the holder of the conflicting lease can process this request.",
          403,
        );
      }
      if (asString(row.status) !== "pending") {
        throw new AgentHubError(
          "release_request_not_pending",
          "Only a pending release request can be processed.",
          409,
        );
      }
      const conflictingLease = this.requireRoomLease(asString(row.conflicting_lease_id), auth.room.id);
      if (conflictingLease.status !== "active") {
        this.database.connection.prepare(`
          UPDATE release_requests
          SET status = 'cancelled', decision_member_id = ?, resolved_at = ?
          WHERE id = ?
        `).run(auth.member.id, resolvedAt, asString(row.id));
        return this.mapReleaseRequest(this.requireReleaseRequestRow(asString(row.id), auth.room.id));
      }

      if (input.decision === "reject") {
        this.database.connection.prepare(`
          UPDATE release_requests
          SET status = 'rejected', rejection_reason = ?, decision_member_id = ?, resolved_at = ?
          WHERE id = ?
        `).run(reason, auth.member.id, resolvedAt, asString(row.id));
        this.auditRecord(
          auth,
          "release_request.rejected",
          "release_request",
          asString(row.id),
          `${auth.member.displayName} declined a lease release request.`,
          { conflictingLeaseId: conflictingLease.id, reason },
        );
        return this.mapReleaseRequest(this.requireReleaseRequestRow(asString(row.id), auth.room.id));
      }

      const requesterSessionId = nullableString(row.requester_session_id);
      if (requesterSessionId) {
        const requesterSession = this.database.connection.prepare(`
          SELECT status FROM work_sessions WHERE id = ? AND member_id = ?
        `).get(requesterSessionId, asString(row.requester_member_id)) as Row | undefined;
        if (!requesterSession || asString(requesterSession.status) !== "active") {
          this.database.connection.prepare(`
            UPDATE release_requests
            SET status = 'cancelled', decision_member_id = ?, resolved_at = ?
            WHERE id = ?
          `).run(auth.member.id, resolvedAt, asString(row.id));
          return this.mapReleaseRequest(this.requireReleaseRequestRow(asString(row.id), auth.room.id));
        }
      }

      const approvedRequestedPaths = parseStringArray(row.requested_paths_json);
      const relatedBlockerRows = this.database.connection.prepare(`
        SELECT DISTINCT conflicting_lease_id
        FROM release_requests
        WHERE transfer_key = ? AND status IN ('pending', 'approved')
      `).all(asString(row.transfer_key)) as Row[];
      const currentConflicts = this.findLeaseConflicts(
        auth.room.id,
        asString(row.requester_member_id),
        requesterSessionId,
        asString(row.requested_kind) as LeaseKind,
        normalizePathList(approvedRequestedPaths),
        this.readRoomSettings(auth.room.id, auth.room.createdAt, auth.member.displayName),
        relatedBlockerRows.map((blocker) => asString(blocker.conflicting_lease_id)),
      );
      const newBlockingConflicts = currentConflicts.filter((conflict) => conflict.decision === "deny");
      if (newBlockingConflicts.length > 0) {
        throw new AgentHubError(
          "release_request_conflict_changed",
          "A new blocking lease now overlaps this request. The requester must retry so the new holder can approve the handover.",
          409,
          { conflicts: newBlockingConflicts },
        );
      }

      const overlapPaths = parseOverlapPaths(row.overlap_paths_json);
      if (conflictingLease.kind === "exclusive") {
        this.endLeaseForTransfer(conflictingLease, resolvedAt, "Approved a release request for the manual exclusive lease.");
        this.database.connection.prepare(`
          UPDATE release_requests
          SET status = 'cancelled', decision_member_id = ?, resolved_at = ?
          WHERE conflicting_lease_id = ? AND status = 'pending' AND id <> ?
        `).run(auth.member.id, resolvedAt, conflictingLease.id, asString(row.id));
      } else {
        const removePath = this.database.connection.prepare(
          "DELETE FROM lease_paths WHERE lease_id = ? AND path_key = ?",
        );
        for (const existingPath of uniqueStrings(overlapPaths.map((path) => path.existingPath))) {
          if (approvedRequestedPaths.some((requestedPath) => pathScopeCovers(requestedPath, existingPath))) {
            removePath.run(conflictingLease.id, pathComparisonKey(existingPath));
          }
        }
        const remaining = this.database.connection.prepare(
          "SELECT COUNT(*) AS count FROM lease_paths WHERE lease_id = ?",
        ).get(conflictingLease.id) as Row;
        if (Number(remaining.count) === 0) {
          this.endLeaseForTransfer(conflictingLease, resolvedAt, "All paths were handed over through an approved release request.");
        } else {
          this.database.connection.prepare("UPDATE leases SET updated_at = ? WHERE id = ?")
            .run(resolvedAt, conflictingLease.id);
        }
      }

      this.database.connection.prepare(`
        UPDATE release_requests
        SET status = 'approved', decision_member_id = ?, resolved_at = ?
        WHERE id = ?
      `).run(auth.member.id, resolvedAt, asString(row.id));
      const deleteResolvedConflict = this.database.connection.prepare(`
        DELETE FROM conflicts
        WHERE room_id = ? AND requester_member_id = ? AND existing_lease_id = ?
          AND requested_path = ? COLLATE NOCASE AND existing_path = ? COLLATE NOCASE
      `);
      for (const overlap of overlapPaths) {
        deleteResolvedConflict.run(
          auth.room.id,
          asString(row.requester_member_id),
          conflictingLease.id,
          overlap.requestedPath,
          overlap.existingPath,
        );
      }
      const transferredLeaseId = this.transferApprovedRequest(row, resolvedAt);
      if (transferredLeaseId) {
        this.database.connection.prepare(`
          UPDATE release_requests SET transferred_lease_id = ?
          WHERE transfer_key = ? AND status = 'approved' AND transferred_lease_id IS NULL
        `).run(transferredLeaseId, asString(row.transfer_key));
      }
      this.auditRecord(
        auth,
        "release_request.approved",
        "release_request",
        asString(row.id),
        `${auth.member.displayName} approved a lease range handover.`,
        {
          conflictingLeaseId: conflictingLease.id,
          conflictingLeaseKind: conflictingLease.kind,
          transferredLeaseId,
          requestedPaths: parseStringArray(row.requested_paths_json),
        },
      );
      return this.mapReleaseRequest(this.requireReleaseRequestRow(asString(row.id), auth.room.id));
    });
  }

  closeLease(input: CloseLeaseReportInput): { lease: Lease; records: ProjectRecord[] } {
    const auth = this.authenticateMemberToken(input.memberToken);
    const sessionId = input.sessionId === undefined
      ? undefined
      : requiredString(input.sessionId, "Session id", 100);
    const status = input.status ?? "completed";
    if (!(["completed", "cancelled"] as const).includes(status)) {
      throw new AgentHubError("invalid_status", "Lease status must be completed or cancelled.");
    }
    const summary = optionalString(input.summary, "Completion summary", 4000);
    const outcome = optionalString(input.outcome, "Outcome", 4000) ?? summary;
    const changedPaths = normalizePathList(input.changedPaths ?? [], true).map((path) => path.path);
    const commitHash = optionalString(input.commitHash, "Commit hash", 255);
    const validations = stringArray(input.validations, "Validations", 100, 2000);
    const remainingRisks = stringArray(input.remainingRisks, "Remaining risks", 100, 2000);
    const handoff = optionalString(input.handoff, "Handoff", 4000);
    const completedAt = this.timestamp();

    return this.database.transaction(() => {
      this.expireLeases(auth.room.id, false);
      const lease = this.requireOwnedLease(input.leaseId, auth);
      this.requireLeaseSession(lease, sessionId);
      if (lease.status !== "active") {
        throw new AgentHubError("lease_not_active", "Only an active lease can be closed.", 409);
      }
      this.database.connection
        .prepare(`
          UPDATE leases SET
            status = ?, completed_at = ?, updated_at = ?, completion_summary = ?, outcome = ?,
            changed_paths_json = ?, commit_hash = ?, validations_json = ?,
            remaining_risks_json = ?, handoff = ?
          WHERE id = ?
        `)
        .run(
          status,
          completedAt,
          completedAt,
          summary,
          outcome,
          json(changedPaths),
          commitHash,
          json(validations),
          json(remainingRisks),
          handoff,
          lease.id,
        );

      const records: ProjectRecord[] = [];
      if (validations.length > 0) {
        records.push(
          this.insertRecord(auth, {
            kind: "validation",
            title: `${lease.title}: reported validation`,
            summary: validations.join("\n"),
            paths: changedPaths,
            status: "reported",
            evidence: [],
            commitHash,
          }),
        );
      }
      if (remainingRisks.length > 0) {
        records.push(
          this.insertRecord(auth, {
            kind: "risk",
            title: `${lease.title}: remaining risks`,
            summary: remainingRisks.join("\n"),
            paths: changedPaths,
            status: "open",
            evidence: [],
            commitHash,
          }),
        );
      }
      if (handoff) {
        records.push(
          this.insertRecord(auth, {
            kind: "handoff",
            title: `${lease.title}: handoff`,
            summary: handoff,
            paths: changedPaths,
            status: "open",
            evidence: [],
            commitHash,
          }),
        );
      }
      this.insertActivity({
        roomId: auth.room.id,
        actorMemberId: auth.member.id,
        actorName: auth.member.displayName,
        type: "lease.closed",
        entityType: "lease",
        entityId: lease.id,
        summary: `${auth.member.displayName} ${status === "completed" ? "completed" : "cancelled"} ${lease.title}.`,
        metadata: { status, changedPaths, commitHash, remainingRiskCount: remainingRisks.length },
        createdAt: completedAt,
      });
      return { lease: this.requireLeaseById(lease.id), records };
    });
  }

  checkEdits(input: CheckEditsInput): EditCheckResult {
    const auth = this.authenticateMemberToken(input.memberToken);
    const sessionId = this.activeOwnedSessionId(input.sessionId, auth);
    this.expireLeases(auth.room.id);
    const paths = normalizePathList(input.paths);
    const leases = this.listLeases(auth.room.id, true);
    const ownedLeases = leases.filter(
      (lease) =>
        lease.memberId === auth.member.id &&
        lease.mode === "write" &&
        lease.sessionId === sessionId &&
        (!input.leaseId || lease.id === input.leaseId),
    );
    if (input.leaseId && ownedLeases.length === 0) {
      throw new AgentHubError("lease_not_found", "The active lease was not found for this member.", 404);
    }

    const blockers: EditCheckResult["blockers"] = [];
    const warnings: EditCheckResult["warnings"] = [];
    const coveredPaths: string[] = [];
    const uncoveredPaths: string[] = [];
    const blockingConflicts: LeaseConflict[] = [];
    const settings = this.readRoomSettings(auth.room.id, auth.room.createdAt, auth.member.displayName);
    for (const candidate of paths) {
      const covered = ownedLeases.some((lease) =>
        lease.paths.some((scope) => pathScopeCovers(scope.path, candidate.path)),
      );
      if (covered) {
        coveredPaths.push(candidate.path);
      } else {
        uncoveredPaths.push(candidate.path);
        blockers.push({
          code: "uncovered_path",
          path: candidate.path,
          message: "No active write lease owned by this member covers the path.",
        });
      }

      const conflicts = this.findLeaseConflicts(
        auth.room.id,
        auth.member.id,
        sessionId,
        "automatic",
        [candidate],
        settings,
        ownedLeases.map((lease) => lease.id),
      );
      for (const conflict of conflicts) {
        const issue = {
          code: "lease_conflict" as const,
          path: candidate.path,
          message: conflict.reason,
          conflict,
        };
        if (conflict.severity === "blocking") {
          blockers.push(issue);
          blockingConflicts.push(conflict);
        }
        else warnings.push(issue);
      }
    }
    const requestLease = ownedLeases[0];
    const releaseRequests = blockingConflicts.length > 0
      ? this.database.transaction(() => this.ensureReleaseRequests(auth, {
          sessionId,
          requesterLeaseId: requestLease?.id ?? null,
          title: requestLease?.title ?? "Agent write request",
          objective: requestLease?.objective ?? "Write paths checked by the Agent Hub pre-write gate.",
          branch: requestLease?.branch ?? null,
          baseCommit: requestLease?.baseCommit ?? null,
          kind: requestLease?.kind === "exclusive" ? "automatic" : requestLease?.kind ?? "automatic",
          mode: "write",
          requestedTtlMinutes: null,
          paths: blockingConflicts.map((conflict) => conflict.requestedPath),
          conflicts: blockingConflicts,
          createdAt: this.timestamp(),
        }))
      : [];
    let historicalImpacts: EditCheckResult["historicalImpacts"] = [];
    let featureConfirmation: EditCheckResult["featureConfirmation"];
    if (sessionId) {
      const session = this.requireOwnedSession(sessionId, auth);
      const historical = this.featureMemoryCall(() => this.featureMemory.checkHistoricalImpacts({
        actor: this.featureActor(auth),
        session: this.featureSession(session),
        paths: paths.map((path) => path.path),
        proposedEdits: input.proposedEdits,
      }));
      historicalImpacts = historical.impacts;
      featureConfirmation = historical.confirmation;
      if (!historical.authorized && historical.confirmation) {
        for (const impact of historical.impacts) {
          blockers.push({
            code: "feature_confirmation_required",
            path: impact.path,
            message:
              `Changing ${impact.featureName} may alter an established behavior contract. `
              + "The current member must explicitly confirm this exact proposal before writing.",
            featureImpact: impact,
            confirmationId: historical.confirmation.id,
          });
        }
      }
    }
    return {
      allowed: blockers.length === 0,
      blockers,
      warnings,
      coveredPaths,
      uncoveredPaths,
      historicalImpacts,
      featureConfirmation,
      releaseRequests,
    };
  }

  queryFeatureMemories(input: FeatureMemoryQueryInput): FeatureMemoryQueryResult {
    const auth = this.authenticateMemberToken(input.memberToken);
    if (input.sessionId) {
      const sessionId = this.activeOwnedSessionId(input.sessionId, auth);
      if (!sessionId) throw new AgentHubError("feature_session_required", "An active session is required.", 409);
    }
    return this.featureMemoryCall(() => this.featureMemory.query(this.featureActor(auth), input));
  }

  getFeatureHistory(memberToken: string, featureId: string) {
    const auth = this.authenticateMemberToken(memberToken);
    return this.featureMemoryCall(() => this.featureMemory.history(this.featureActor(auth), featureId));
  }

  submitFeatureRevision(input: SubmitFeatureRevisionInput): FeatureRevision {
    const auth = this.authenticateMemberToken(input.memberToken);
    const session = this.requireOwnedSession(input.sessionId, auth);
    const submittedTargetPaths = uniqueStrings(
      input.targets.map((target) => target.path).filter((path): path is string => Boolean(path)),
    );
    const promotionEvidenceVerified = this.featurePromotionEvidenceVerified(session, {
      branch: session.branch,
      finalCommit: input.finalCommit,
      gitEvidence: input.gitEvidence,
      verifications: input.verifications ?? [],
      paths: submittedTargetPaths,
    });
    const revision = this.featureMemoryCall(() => this.featureMemory.submitRevision(
      this.featureActor(auth),
      this.featureSession(session, promotionEvidenceVerified),
      {
        ...input,
        gitEvidence: {
          ...(input.gitEvidence ?? {}),
          [FEATURE_SUBMITTED_TARGET_PATHS_KEY]: submittedTargetPaths,
        },
      },
    ));
    this.auditRecord(
      auth,
      "feature.revision.submitted",
      "feature_revision",
      revision.id,
      `Submitted feature revision ${revision.revisionNumber} with status ${revision.status}.`,
      { featureId: revision.featureId, relation: revision.relation, status: revision.status },
    );
    return revision;
  }

  rollbackFeatureRevision(input: RollbackFeatureRevisionInput): FeatureRevision {
    const auth = this.authenticateMemberToken(input.memberToken);
    const session = this.requireOwnedSession(input.sessionId, auth);
    const submittedTargetPaths = this.featureRevisionTargetPaths(auth.room.id, input.targetRevisionId);
    const promotionEvidenceVerified = this.featurePromotionEvidenceVerified(session, {
      branch: session.branch,
      finalCommit: input.finalCommit,
      gitEvidence: input.gitEvidence,
      verifications: input.verifications ?? [],
      paths: submittedTargetPaths,
    });
    const revision = this.featureMemoryCall(() => this.featureMemory.rollbackRevision(
      this.featureActor(auth),
      this.featureSession(session, promotionEvidenceVerified),
      {
        ...input,
        gitEvidence: {
          ...(input.gitEvidence ?? {}),
          [FEATURE_SUBMITTED_TARGET_PATHS_KEY]: submittedTargetPaths,
        },
      },
    ));
    this.auditRecord(
      auth,
      "feature.revision.rolled_back",
      "feature_revision",
      revision.id,
      `Created rollback revision ${revision.revisionNumber}.`,
      { featureId: revision.featureId, targetRevisionId: input.targetRevisionId, status: revision.status },
    );
    return revision;
  }

  resolveFeatureConfirmation(input: ResolveFeatureConfirmationInput) {
    const auth = this.authenticateMemberToken(input.memberToken);
    const session = this.requireOwnedSession(input.sessionId, auth);
    const confirmation = this.featureMemoryCall(() => this.featureMemory.resolveConfirmation(
      this.featureActor(auth),
      this.featureSession(session),
      input,
    ));
    this.auditRecord(
      auth,
      `feature.confirmation.${input.decision}`,
      "feature_confirmation",
      confirmation.id,
      `${auth.member.displayName} ${input.decision} a historical feature change proposal.`,
      { sessionId: session.id, proposalHash: confirmation.proposalHash },
    );
    return confirmation;
  }

  addContextEntry(input: AddContextEntryInput): ContextEntry {
    const auth = this.authenticateMemberToken(input.memberToken);
    if (!CONTEXT_KINDS.includes(input.kind)) {
      throw new AgentHubError("invalid_context_kind", "Unsupported context kind.");
    }
    const entry: ContextEntry = {
      id: randomUUID(),
      roomId: auth.room.id,
      authorMemberId: auth.member.id,
      authorName: auth.member.displayName,
      kind: input.kind,
      title: requiredString(input.title, "Context title", 200),
      content: requiredString(input.content, "Context content", 12000),
      paths: normalizePathList(input.paths ?? [], true).map((path) => path.path),
      createdAt: this.timestamp(),
      updatedAt: this.timestamp(),
    };
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO context_entries
            (id, room_id, author_member_id, kind, title, content, paths_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          entry.id,
          entry.roomId,
          entry.authorMemberId,
          entry.kind,
          entry.title,
          entry.content,
          json(entry.paths),
          entry.createdAt,
          entry.updatedAt,
        );
      this.auditRecord(auth, "context.added", "context", entry.id, `Added context: ${entry.title}.`, {
        kind: entry.kind,
        paths: entry.paths,
      });
    });
    return entry;
  }

  addDecision(input: AddDecisionInput): Decision {
    const auth = this.authenticateMemberToken(input.memberToken);
    const decision: Decision = {
      id: randomUUID(),
      roomId: auth.room.id,
      authorMemberId: auth.member.id,
      authorName: auth.member.displayName,
      title: requiredString(input.title, "Decision title", 200),
      decision: requiredString(input.decision, "Decision", 12000),
      rationale: optionalString(input.rationale, "Rationale", 12000),
      paths: normalizePathList(input.paths ?? [], true).map((path) => path.path),
      createdAt: this.timestamp(),
    };
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO decisions
            (id, room_id, author_member_id, title, decision, rationale, paths_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          decision.id,
          decision.roomId,
          decision.authorMemberId,
          decision.title,
          decision.decision,
          decision.rationale,
          json(decision.paths),
          decision.createdAt,
        );
      this.insertRecord(auth, {
        id: decision.id,
        kind: "decision",
        title: decision.title,
        summary: decision.decision,
        paths: decision.paths,
        status: "accepted",
        evidence: decision.rationale ? [decision.rationale] : [],
        commitHash: null,
        createdAt: decision.createdAt,
      });
      this.auditRecord(auth, "decision.added", "decision", decision.id, `Recorded decision: ${decision.title}.`, {
        paths: decision.paths,
      });
    });
    return decision;
  }

  addVerification(input: AddVerificationInput): Verification {
    const auth = this.authenticateMemberToken(input.memberToken);
    const sessionId = input.sessionId === undefined
      ? undefined
      : this.activeOwnedSessionId(input.sessionId, auth);
    if (!VERIFICATION_KINDS.includes(input.kind)) {
      throw new AgentHubError("invalid_verification_kind", "Unsupported verification kind.");
    }
    if (!VERIFICATION_RESULTS.includes(input.result)) {
      throw new AgentHubError("invalid_verification_result", "Unsupported verification result.");
    }
    if (input.leaseId) {
      const lease = sessionId === undefined
        ? this.requireRoomLease(input.leaseId, auth.room.id)
        : this.requireOwnedLease(input.leaseId, auth);
      this.requireLeaseSession(lease, sessionId);
    }
    const verification: Verification = {
      id: randomUUID(),
      roomId: auth.room.id,
      authorMemberId: auth.member.id,
      authorName: auth.member.displayName,
      leaseId: input.leaseId ?? null,
      kind: input.kind,
      result: input.result,
      summary: requiredString(input.summary, "Verification summary", 12000),
      command: optionalString(input.command, "Verification command", 4000),
      evidence: optionalString(input.evidence, "Verification evidence", 12000),
      createdAt: this.timestamp(),
    };
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO verifications
            (id, room_id, author_member_id, lease_id, kind, result, summary, command, evidence, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          verification.id,
          verification.roomId,
          verification.authorMemberId,
          verification.leaseId,
          verification.kind,
          verification.result,
          verification.summary,
          verification.command,
          verification.evidence,
          verification.createdAt,
        );
      this.insertRecord(auth, {
        id: verification.id,
        kind: "validation",
        title: `${verification.kind}: ${verification.result}`,
        summary: verification.summary,
        paths: [],
        status: verification.result,
        evidence: [verification.command, verification.evidence].filter(
          (value): value is string => Boolean(value),
        ),
        commitHash: null,
        createdAt: verification.createdAt,
      });
      this.auditRecord(
        auth,
        "verification.added",
        "verification",
        verification.id,
        `Recorded ${verification.result} ${verification.kind} verification.`,
        { leaseId: verification.leaseId },
      );
    });
    return verification;
  }

  addHandoff(input: AddHandoffInput): Handoff {
    const auth = this.authenticateMemberToken(input.memberToken);
    const sessionId = input.sessionId === undefined
      ? undefined
      : this.activeOwnedSessionId(input.sessionId, auth);
    if (input.leaseId) {
      const lease = sessionId === undefined
        ? this.requireRoomLease(input.leaseId, auth.room.id)
        : this.requireOwnedLease(input.leaseId, auth);
      this.requireLeaseSession(lease, sessionId);
    }
    let toMember: Member | null = null;
    if (input.toMemberId) {
      toMember = this.requireMemberById(input.toMemberId);
      if (toMember.roomId !== auth.room.id) {
        throw new AgentHubError("member_not_found", "The handoff target is not in this room.", 404);
      }
    }
    const handoff: Handoff = {
      id: randomUUID(),
      roomId: auth.room.id,
      fromMemberId: auth.member.id,
      fromMemberName: auth.member.displayName,
      toMemberId: toMember?.id ?? null,
      toMemberName: toMember?.displayName ?? null,
      leaseId: input.leaseId ?? null,
      summary: requiredString(input.summary, "Handoff summary", 12000),
      completed: stringArray(input.completed, "Completed items", 100, 2000),
      remaining: stringArray(input.remaining, "Remaining items", 100, 2000),
      risks: stringArray(input.risks, "Handoff risks", 100, 2000),
      createdAt: this.timestamp(),
    };
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO handoffs (
            id, room_id, from_member_id, to_member_id, lease_id, summary,
            completed_json, remaining_json, risks_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          handoff.id,
          handoff.roomId,
          handoff.fromMemberId,
          handoff.toMemberId,
          handoff.leaseId,
          handoff.summary,
          json(handoff.completed),
          json(handoff.remaining),
          json(handoff.risks),
          handoff.createdAt,
        );
      this.insertRecord(auth, {
        id: handoff.id,
        kind: "handoff",
        title: toMember ? `Handoff to ${toMember.displayName}` : "Team handoff",
        summary: handoff.summary,
        paths: [],
        status: "open",
        evidence: [...handoff.completed, ...handoff.remaining, ...handoff.risks],
        commitHash: null,
        createdAt: handoff.createdAt,
      });
      this.auditRecord(auth, "handoff.added", "handoff", handoff.id, "Recorded a project handoff.", {
        toMemberId: handoff.toMemberId,
        leaseId: handoff.leaseId,
      });
    });
    return handoff;
  }

  addRecord(input: AddRecordInput): ProjectRecord {
    const auth = this.authenticateMemberToken(input.memberToken);
    const kind = normalizeRecordKind(input.kind);
    return this.database.transaction(() => {
      const record = this.insertRecord(auth, {
        kind,
        title: requiredString(input.title, "Record title", 200),
        summary: requiredString(input.summary, "Record summary", 12000),
        paths: normalizePathList(input.paths ?? [], true).map((path) => path.path),
        status: optionalString(input.status, "Record status", 100) ?? defaultRecordStatus(kind),
        evidence: stringArray(input.evidence, "Record evidence", 100, 4000),
        commitHash: optionalString(input.commitHash, "Commit hash", 255),
      });
      this.auditRecord(auth, "record.added", "record", record.id, `Recorded ${kind}: ${record.title}.`, {
        kind,
        paths: record.paths,
      });
      return record;
    });
  }

  listActivity(input: ListActivityInput): Activity[] {
    const auth = this.authenticateMemberToken(input.memberToken);
    const limit = Math.max(1, Math.min(input.limit ?? 100, MAX_ACTIVITY_LIMIT));
    const rows = input.after
      ? this.database.connection
          .prepare(`
            SELECT * FROM activities
            WHERE room_id = ? AND created_at > ?
            ORDER BY created_at ASC, id ASC LIMIT ?
          `)
          .all(auth.room.id, input.after, limit)
      : this.database.connection
          .prepare(`
            SELECT * FROM activities
            WHERE room_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
          `)
          .all(auth.room.id, limit);
    return (rows as Row[]).map(mapActivity);
  }

  openSession(input: OpenSessionInput): WorkSession {
    const auth = this.authenticateMemberToken(input.memberToken);
    const metadata = objectValue(input.metadata, "Session metadata");
    const clientVersion = optionalString(
      input.clientVersion ?? metadata.clientVersion,
      "Client version",
      80,
    );
    const protocolVersion = optionalVersionNumber(
      input.protocolVersion ?? metadata.protocolVersion,
      "Protocol version",
    );
    const schemaVersion = optionalVersionNumber(
      input.schemaVersion ?? metadata.schemaVersion,
      "Schema version",
    );
    const session: WorkSession = {
      id: randomUUID(),
      roomId: auth.room.id,
      memberId: auth.member.id,
      clientName: optionalString(input.clientName, "Client name", 160),
      agentName: optionalString(input.agentName, "Agent name", 160),
      repository: optionalString(input.repository, "Repository", 1000),
      branch: optionalString(input.branch, "Branch", 255),
      worktree: optionalString(input.worktree, "Worktree", 2000),
      baseCommit: optionalString(input.baseCommit, "Base commit", 255),
      task: optionalString(input.task, "Task", 4000),
      status: "active",
      branchEpoch: 1,
      frozenReason: null,
      metadata,
      openedAt: this.timestamp(),
      lastSeenAt: this.timestamp(),
      closedAt: null,
      clientVersion,
      protocolVersion,
      schemaVersion,
    };
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO work_sessions (
            id, room_id, member_id, client_name, agent_name, repository, branch, worktree,
            base_commit, task, status, metadata_json, opened_at, last_seen_at,
            client_version, protocol_version, schema_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
        `)
        .run(
          session.id,
          session.roomId,
          session.memberId,
          session.clientName,
          session.agentName,
          session.repository,
          session.branch,
          session.worktree,
          session.baseCommit,
          session.task,
          json(session.metadata),
          session.openedAt,
          session.lastSeenAt,
          session.clientVersion,
          session.protocolVersion,
          session.schemaVersion,
        );
      this.database.connection.prepare(`
        UPDATE members SET
          client_version = COALESCE(?, client_version),
          protocol_version = COALESCE(?, protocol_version),
          schema_version = COALESCE(?, schema_version),
          last_seen_at = ?
        WHERE id = ?
      `).run(clientVersion, protocolVersion, schemaVersion, session.lastSeenAt, auth.member.id);
      this.auditRecord(auth, "session.opened", "session", session.id, "Opened a local Agent session.", {
        clientName: session.clientName,
        agentName: session.agentName,
        branch: session.branch,
        baseCommit: session.baseCommit,
      });
    });
    return session;
  }

  heartbeatSession(input: HeartbeatSessionInput): {
    session: WorkSession;
    renewedLeases: Lease[];
  } {
    const auth = this.authenticateMemberToken(input.memberToken);
    const session = this.requireOwnedSession(input.sessionId, auth);
    if (session.status !== "active") {
      throw new AgentHubError("session_not_active", "The work session is not active.", 409);
    }
    const clientVersion = optionalString(input.clientVersion, "Client version", 80);
    const protocolVersion = optionalVersionNumber(input.protocolVersion, "Protocol version");
    const schemaVersion = optionalVersionNumber(input.schemaVersion, "Schema version");
    const heartbeatAt = this.timestamp();
    const settings = this.readRoomSettings(auth.room.id, auth.room.createdAt, auth.member.displayName);
    const expiresAt = new Date(
      this.now().getTime() + settings.automaticLeaseTtlMinutes * 60_000,
    ).toISOString();
    const renewedLeaseIds: string[] = [];
    this.database.transaction(() => {
      this.expireLeases(auth.room.id, false);
      this.database.connection.prepare(`
        UPDATE work_sessions SET
          last_seen_at = ?,
          client_version = COALESCE(?, client_version),
          protocol_version = COALESCE(?, protocol_version),
          schema_version = COALESCE(?, schema_version)
        WHERE id = ?
      `).run(heartbeatAt, clientVersion, protocolVersion, schemaVersion, session.id);
      this.database.connection.prepare(`
        UPDATE members SET
          last_seen_at = ?,
          client_version = COALESCE(?, client_version),
          protocol_version = COALESCE(?, protocol_version),
          schema_version = COALESCE(?, schema_version)
        WHERE id = ?
      `).run(heartbeatAt, clientVersion, protocolVersion, schemaVersion, auth.member.id);
      const leases = this.database.connection.prepare(`
        SELECT id, kind FROM leases
        WHERE member_id = ? AND status = 'active'
          AND (session_id = ? OR (session_id IS NULL AND kind = 'standard'))
      `).all(auth.member.id, session.id) as Row[];
      const renew = this.database.connection.prepare(
        "UPDATE leases SET expires_at = ?, updated_at = ? WHERE id = ?",
      );
      for (const lease of leases) {
        const kind = asString(lease.kind) as LeaseKind;
        if (!shouldHeartbeatRenew(kind)) continue;
        renew.run(expiresAt, heartbeatAt, asString(lease.id));
        renewedLeaseIds.push(asString(lease.id));
      }
    });
    return {
      session: this.requireSessionById(session.id),
      renewedLeases: renewedLeaseIds.map((id) => this.requireLeaseById(id)),
    };
  }

  syncSessionBranch(input: SyncSessionBranchInput): WorkSession {
    const auth = this.authenticateMemberToken(input.memberToken);
    const session = this.requireOwnedSession(input.sessionId, auth);
    const branch = optionalString(input.branch, "Branch", 255) ?? null;
    const baseCommit = optionalString(input.baseCommit, "Base commit", 255) ?? null;
    if (session.status === "frozen") throw new AgentHubError("session_frozen", session.frozenReason ?? "The session is frozen after a branch change.", 409);
    if (session.branch === branch) {
      const now = this.timestamp();
      this.database.connection.prepare("UPDATE work_sessions SET base_commit = ?, last_seen_at = ? WHERE id = ?").run(baseCommit, now, session.id);
      return this.requireSessionById(session.id);
    }
    const now = this.timestamp();
    const reason = `Branch changed from ${session.branch ?? "(unknown)"} to ${branch ?? "(detached)"}; re-baselining is required.`;
    this.database.transaction(() => {
      this.database.connection.prepare("UPDATE work_sessions SET branch = ?, base_commit = ?, frozen_reason = ?, last_seen_at = ? WHERE id = ?").run(branch, baseCommit, reason, now, session.id);
      const leases = this.database.connection.prepare("SELECT id, title FROM leases WHERE session_id = ? AND status = 'active' AND kind <> 'exclusive'").all(session.id) as Row[];
      for (const lease of leases) {
        this.database.connection.prepare("UPDATE leases SET status = 'cancelled', completed_at = ?, updated_at = ?, completion_summary = ? WHERE id = ?").run(now, now, reason, asString(lease.id));
      }
      this.database.connection.prepare(`
        UPDATE release_requests SET status = 'cancelled', resolved_at = ?
        WHERE requester_session_id = ? AND status = 'pending'
      `).run(now, session.id);
      this.auditRecord(auth, "session.branch_changed", "session", session.id, reason, { previousBranch: session.branch, branch, previousBaseCommit: session.baseCommit, baseCommit, cancelledLeaseCount: leases.length });
    });
    throw new AgentHubError("branch_changed", reason, 409, { branch, baseCommit, sessionId: session.id });
  }

  rebaselineSession(input: RebaselineSessionInput): WorkSession {
    const auth = this.authenticateMemberToken(input.memberToken);
    const session = this.requireOwnedSession(input.sessionId, auth);
    const branch = optionalString(input.branch, "Branch", 255) ?? null;
    const baseCommit = optionalString(input.baseCommit, "Base commit", 255) ?? null;
    const now = this.timestamp();
    this.database.transaction(() => {
      this.database.connection.prepare("UPDATE work_sessions SET branch = ?, base_commit = ?, branch_epoch = branch_epoch + 1, frozen_reason = NULL, last_seen_at = ? WHERE id = ?").run(branch, baseCommit, now, session.id);
      this.auditRecord(auth, "session.rebaselined", "session", session.id, "Re-baselined a session after a branch change.", { branch, baseCommit, previousBranch: session.branch });
    });
    return this.requireSessionById(session.id);
  }

  recordLocalScan(input: RecordLocalScanInput): LocalScan {
    const auth = this.authenticateMemberToken(input.memberToken);
    const session = this.requireOwnedSession(input.sessionId, auth);
    if (session.status !== "active") {
      throw new AgentHubError("session_not_active", "The local session is closed.", 409);
    }
    const scan: LocalScan = {
      id: randomUUID(),
      sessionId: session.id,
      roomId: auth.room.id,
      memberId: auth.member.id,
      repository: optionalString(input.repository, "Repository", 1000) ?? session.repository,
      branch: optionalString(input.branch, "Branch", 255) ?? session.branch,
      worktree: optionalString(input.worktree, "Worktree", 2000) ?? session.worktree,
      baseCommit: optionalString(input.baseCommit, "Base commit", 255) ?? session.baseCommit,
      changedPaths: normalizePathList(input.changedPaths ?? [], true).map((path) => path.path),
      ruleFiles: normalizePathList(input.ruleFiles ?? [], true).map((path) => path.path),
      systems: stringArray(input.systems, "Systems", 200, 255),
      metadata: objectValue(input.metadata, "Scan metadata"),
      scannedAt: this.timestamp(),
    };
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO local_scans (
            id, session_id, room_id, member_id, repository, branch, worktree, base_commit,
            changed_paths_json, rule_files_json, systems_json, metadata_json, scanned_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          scan.id,
          scan.sessionId,
          scan.roomId,
          scan.memberId,
          scan.repository,
          scan.branch,
          scan.worktree,
          scan.baseCommit,
          json(scan.changedPaths),
          json(scan.ruleFiles),
          json(scan.systems),
          json(scan.metadata),
          scan.scannedAt,
        );
      this.database.connection
        .prepare(`
          UPDATE work_sessions SET
            repository = ?, branch = ?, worktree = ?, base_commit = ?, last_seen_at = ?
          WHERE id = ?
        `)
        .run(
          scan.repository,
          scan.branch,
          scan.worktree,
          scan.baseCommit,
          scan.scannedAt,
          scan.sessionId,
        );
      this.auditRecord(auth, "scan.recorded", "local_scan", scan.id, "Recorded local project metadata.", {
        sessionId: scan.sessionId,
        changedPathCount: scan.changedPaths.length,
        ruleFileCount: scan.ruleFiles.length,
        systems: scan.systems,
      });
    });
    this.promoteRecordedSessionCandidates(auth, this.requireSessionById(session.id), scan);
    return scan;
  }

  closeSession(input: CloseSessionInput): WorkSession {
    const auth = this.authenticateMemberToken(input.memberToken);
    const session = this.requireOwnedSession(input.sessionId, auth);
    const closedAt = this.timestamp();
    const summary = optionalString(input.summary, "Session summary", 4000);
    this.database.transaction(() => {
      this.expireLeases(auth.room.id, false);
      this.featureMemory.expireSessionConfirmations(session.id, closedAt);
      const activeLeases = this.database.connection
        .prepare(`
          SELECT id, title
          FROM leases
          WHERE session_id = ? AND status = 'active' AND kind <> 'exclusive'
        `)
        .all(session.id) as Row[];
      const cancellationSummary = summary
        ?? "The work session closed before this lease was explicitly completed.";
      const cancelLease = this.database.connection.prepare(`
        UPDATE leases
        SET status = 'cancelled', completed_at = ?, updated_at = ?, completion_summary = ?
        WHERE id = ?
      `);
      for (const lease of activeLeases) {
        const leaseId = asString(lease.id);
        cancelLease.run(closedAt, closedAt, cancellationSummary, leaseId);
        this.insertActivity({
          roomId: auth.room.id,
          actorMemberId: auth.member.id,
          actorName: auth.member.displayName,
          type: "lease.closed",
          entityType: "lease",
          entityId: leaseId,
          summary: `${auth.member.displayName} cancelled ${asString(lease.title)} when its Agent session closed.`,
          metadata: { status: "cancelled", sessionId: session.id, automatic: true },
          createdAt: closedAt,
        });
      }
      if (session.status === "active") {
        this.database.connection
          .prepare("UPDATE work_sessions SET status = 'closed', closed_at = ?, last_seen_at = ? WHERE id = ?")
          .run(closedAt, closedAt, session.id);
        this.auditRecord(auth, "session.closed", "session", session.id, "Closed a local Agent session.", {
          summary,
          automaticallyCancelledLeaseIds: activeLeases.map((lease) => asString(lease.id)),
        });
      }
    });
    return this.requireSessionById(session.id);
  }

  listRoomSessions(memberToken: string): { sessions: WorkSession[]; localScans: LocalScan[] } {
    const auth = this.authenticateMemberToken(memberToken);
    return {
      sessions: this.listSessions(auth.room.id),
      localScans: this.listLocalScans(auth.room.id),
    };
  }

  private readRoomSettings(
    roomId: string,
    fallbackUpdatedAt: string,
    fallbackUpdatedBy: string,
  ): RoomSettings {
    const row = this.database.connection.prepare(`
      SELECT r.blocking_protection_enabled, r.automatic_lease_ttl_minutes,
        r.maximum_exclusive_lease_minutes, r.risk_policy_version,
        r.risk_policy_rules_json, r.settings_updated_at,
        updater.name AS settings_updated_by_name
      FROM rooms r
      LEFT JOIN members updater ON updater.id = r.settings_updated_by
      WHERE r.id = ?
    `).get(roomId) as Row | undefined;
    if (!row) throw new AgentHubError("room_not_found", "Room not found.", 404);
    let riskRules = createDefaultRiskPolicy().rules;
    try {
      const parsed: unknown = JSON.parse(asString(row.risk_policy_rules_json));
      if (Array.isArray(parsed)) riskRules = normalizeRiskPolicyRules(parsed as RiskPolicyRule[]);
    } catch {
      riskRules = createDefaultRiskPolicy().rules;
    }
    const storedTtl = Number(row.automatic_lease_ttl_minutes ?? DEFAULT_AUTOMATIC_TTL_MINUTES);
    const automaticLeaseTtlMinutes = AUTOMATIC_TTL_OPTIONS.includes(
      storedTtl as (typeof AUTOMATIC_TTL_OPTIONS)[number],
    )
      ? storedTtl as RoomSettings["automaticLeaseTtlMinutes"]
      : DEFAULT_AUTOMATIC_TTL_MINUTES;
    const storedMaximum = Number(
      row.maximum_exclusive_lease_minutes ?? DEFAULT_MAXIMUM_EXCLUSIVE_LEASE_MINUTES,
    );
    const maximumExclusiveLeaseMinutes = Number.isInteger(storedMaximum) && storedMaximum >= 5
      ? Math.min(7 * 24 * 60, storedMaximum)
      : DEFAULT_MAXIMUM_EXCLUSIVE_LEASE_MINUTES;
    const blockingProtectionEnabled = Number(row.blocking_protection_enabled ?? 1) !== 0;
    return {
      autoLockAfterAutoClaim: blockingProtectionEnabled,
      blockingProtectionEnabled,
      automaticLeaseTtlMinutes,
      maximumExclusiveLeaseMinutes,
      riskPolicyVersion: Math.max(1, Math.trunc(Number(row.risk_policy_version ?? 1))),
      riskRules,
      updatedAt: nullableString(row.settings_updated_at) ?? fallbackUpdatedAt,
      updatedBy: nullableString(row.settings_updated_by_name) ?? fallbackUpdatedBy,
    };
  }

  private ensureReleaseRequests(
    auth: AuthenticatedMember,
    input: {
      sessionId: string | null;
      requesterLeaseId: string | null;
      title: string;
      objective: string | null;
      branch: string | null;
      baseCommit: string | null;
      kind: LeaseKind;
      mode: LeaseMode;
      requestedTtlMinutes: number | null;
      paths: string[];
      conflicts: LeaseConflict[];
      createdAt: string;
    },
  ): ReleaseRequest[] {
    const blocking = input.conflicts.filter(
      (conflict) => conflict.decision === "deny" && conflict.memberId !== auth.member.id,
    );
    const grouped = new Map<string, LeaseConflict[]>();
    for (const conflict of blocking) {
      grouped.set(conflict.leaseId, [...(grouped.get(conflict.leaseId) ?? []), conflict]);
    }
    const normalizedPaths = uniqueStrings(input.paths.map((path) => normalizePathList([path])[0].path));
    const transferKey = createHash("sha256").update(json({
      roomId: auth.room.id,
      requesterMemberId: auth.member.id,
      requesterSessionId: input.sessionId,
      title: input.title,
      kind: input.kind,
      mode: input.mode,
      branch: input.branch,
      baseCommit: input.baseCommit,
      paths: normalizedPaths.map(pathComparisonKey).sort(),
    })).digest("hex");
    const requests: ReleaseRequest[] = [];
    for (const [leaseId, conflicts] of grouped) {
      const overlapPaths = conflicts.map((conflict) => ({
        requestedPath: conflict.requestedPath,
        existingPath: conflict.existingPath,
      }));
      const requestedPaths = uniqueStrings(conflicts.map((conflict) => conflict.requestedPath));
      const reason = uniqueStrings(conflicts.map((conflict) => conflict.reason)).join("\n");
      const dedupeKey = createHash("sha256").update(json({
        transferKey,
        leaseId,
        overlapPaths: overlapPaths
          .map((path) => [pathComparisonKey(path.requestedPath), pathComparisonKey(path.existingPath)])
          .sort(),
      })).digest("hex");
      const pending = this.database.connection.prepare(`
        SELECT id FROM release_requests WHERE dedupe_key = ? AND status = 'pending'
      `).get(dedupeKey) as Row | undefined;
      if (pending) {
        this.database.connection.prepare(`
          UPDATE release_requests SET
            last_requested_at = ?, occurrence_count = occurrence_count + 1,
            reason = ?, requested_paths_json = ?, overlap_paths_json = ?
          WHERE id = ?
        `).run(
          input.createdAt,
          reason,
          json(requestedPaths),
          json(overlapPaths),
          asString(pending.id),
        );
        requests.push(this.mapReleaseRequest(
          this.requireReleaseRequestRow(asString(pending.id), auth.room.id),
        ));
        continue;
      }
      const recent = this.database.connection.prepare(`
        SELECT id, last_requested_at FROM release_requests
        WHERE dedupe_key = ? ORDER BY last_requested_at DESC LIMIT 1
      `).get(dedupeKey) as Row | undefined;
      if (
        recent
        && Date.parse(asString(recent.last_requested_at))
          > this.now().getTime() - RELEASE_REQUEST_COOLDOWN_MS
      ) {
        requests.push(this.mapReleaseRequest(
          this.requireReleaseRequestRow(asString(recent.id), auth.room.id),
        ));
        continue;
      }
      const id = randomUUID();
      this.database.connection.prepare(`
        INSERT INTO release_requests (
          id, room_id, requester_member_id, requester_session_id, requester_lease_id,
          conflicting_lease_id, request_title, request_objective, requested_kind,
          requested_mode, requested_branch, requested_base_commit, requested_ttl_minutes,
          requested_paths_json, overlap_paths_json, reason, transfer_key, dedupe_key,
          status, requested_at, last_requested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        id,
        auth.room.id,
        auth.member.id,
        input.sessionId,
        input.requesterLeaseId,
        leaseId,
        input.title,
        input.objective,
        input.kind,
        input.mode,
        input.branch,
        input.baseCommit,
        input.requestedTtlMinutes,
        json(requestedPaths),
        json(overlapPaths),
        reason,
        transferKey,
        dedupeKey,
        input.createdAt,
        input.createdAt,
      );
      this.insertActivity({
        roomId: auth.room.id,
        actorMemberId: auth.member.id,
        actorName: auth.member.displayName,
        type: "release_request.created",
        entityType: "release_request",
        entityId: id,
        summary: `${auth.member.displayName} requested a blocking lease range handover.`,
        metadata: { conflictingLeaseId: leaseId, requestedPaths, requestedKind: input.kind },
        createdAt: input.createdAt,
      });
      requests.push(this.mapReleaseRequest(this.requireReleaseRequestRow(id, auth.room.id)));
    }
    return requests;
  }

  private requireReleaseRequestRow(id: string, roomId: string): Row {
    const row = this.database.connection.prepare(`
      SELECT rr.*, requester.name AS requester_name,
        holder.id AS holder_member_id, holder.name AS holder_name,
        lease.title AS conflicting_lease_title, lease.kind AS conflicting_lease_kind,
        lease.expires_at AS holder_lease_expires_at
      FROM release_requests rr
      JOIN members requester ON requester.id = rr.requester_member_id
      JOIN leases lease ON lease.id = rr.conflicting_lease_id
      JOIN members holder ON holder.id = lease.member_id
      WHERE rr.id = ? AND rr.room_id = ?
    `).get(requiredString(id, "Release request id", 100), roomId) as Row | undefined;
    if (!row) throw new AgentHubError("release_request_not_found", "Release request not found.", 404);
    return row;
  }

  private listReleaseRequestsByRoom(
    roomId: string,
    status: ListReleaseRequestsInput["status"] = "pending",
  ): ReleaseRequest[] {
    const rows = this.database.connection.prepare(`
      SELECT rr.*, requester.name AS requester_name,
        holder.id AS holder_member_id, holder.name AS holder_name,
        lease.title AS conflicting_lease_title, lease.kind AS conflicting_lease_kind,
        lease.expires_at AS holder_lease_expires_at
      FROM release_requests rr
      JOIN members requester ON requester.id = rr.requester_member_id
      JOIN leases lease ON lease.id = rr.conflicting_lease_id
      JOIN members holder ON holder.id = lease.member_id
      WHERE rr.room_id = ? ${status === "all" ? "" : "AND rr.status = ?"}
      ORDER BY rr.last_requested_at DESC, rr.id DESC
      LIMIT 500
    `).all(...(status === "all" ? [roomId] : [roomId, status ?? "pending"])) as Row[];
    return rows.map((row) => this.mapReleaseRequest(row));
  }

  private mapReleaseRequest(row: Row): ReleaseRequest {
    return {
      id: asString(row.id),
      roomId: asString(row.room_id),
      requesterMemberId: asString(row.requester_member_id),
      requesterName: asString(row.requester_name),
      requesterSessionId: nullableString(row.requester_session_id),
      requesterLeaseId: nullableString(row.requester_lease_id),
      holderMemberId: asString(row.holder_member_id),
      holderName: asString(row.holder_name),
      conflictingLeaseId: asString(row.conflicting_lease_id),
      conflictingLeaseTitle: asString(row.conflicting_lease_title),
      conflictingLeaseKind: asString(row.conflicting_lease_kind) as LeaseKind,
      requestTitle: asString(row.request_title),
      requestObjective: nullableString(row.request_objective),
      requestedKind: asString(row.requested_kind) as LeaseKind,
      requestedMode: asString(row.requested_mode) as LeaseMode,
      requestedPaths: parseStringArray(row.requested_paths_json),
      overlapPaths: parseOverlapPaths(row.overlap_paths_json),
      reason: asString(row.reason),
      status: asString(row.status) as ReleaseRequest["status"],
      rejectionReason: nullableString(row.rejection_reason),
      transferredLeaseId: nullableString(row.transferred_lease_id),
      occurrenceCount: Math.max(1, Math.trunc(Number(row.occurrence_count ?? 1))),
      requestedAt: asString(row.requested_at),
      lastRequestedAt: asString(row.last_requested_at),
      resolvedAt: nullableString(row.resolved_at),
      holderLeaseExpiresAt: asString(row.holder_lease_expires_at),
    };
  }

  private reconcileReleaseRequests(roomId: string): void {
    const rows = this.database.connection.prepare(`
      SELECT rr.id, rr.overlap_paths_json, l.status AS lease_status, l.expires_at
      FROM release_requests rr
      JOIN leases l ON l.id = rr.conflicting_lease_id
      WHERE rr.room_id = ? AND rr.status = 'pending'
    `).all(roomId) as Row[];
    const now = this.timestamp();
    const cancel = this.database.connection.prepare(`
      UPDATE release_requests SET status = 'cancelled', resolved_at = ? WHERE id = ?
    `);
    for (const row of rows) {
      if (asString(row.lease_status) !== "active" || asString(row.expires_at) <= now) {
        cancel.run(now, asString(row.id));
        continue;
      }
      const currentPaths = new Set((this.database.connection.prepare(`
        SELECT path_key FROM lease_paths
        WHERE lease_id = (SELECT conflicting_lease_id FROM release_requests WHERE id = ?)
      `).all(asString(row.id)) as Row[]).map((path) => asString(path.path_key)));
      const stillOverlaps = parseOverlapPaths(row.overlap_paths_json)
        .some((path) => currentPaths.has(pathComparisonKey(path.existingPath)));
      if (!stillOverlaps) cancel.run(now, asString(row.id));
    }
  }

  private endLeaseForTransfer(lease: Lease, completedAt: string, summary: string): void {
    this.database.connection.prepare(`
      UPDATE leases SET status = 'cancelled', completed_at = ?, updated_at = ?,
        completion_summary = ? WHERE id = ?
    `).run(completedAt, completedAt, summary, lease.id);
  }

  private transferApprovedRequest(row: Row, transferredAt: string): string | null {
    const requestedKind = asString(row.requested_kind) as LeaseKind;
    const transferKey = asString(row.transfer_key);
    let requestedPaths = parseStringArray(row.requested_paths_json);
    if (requestedKind === "exclusive") {
      const pending = this.database.connection.prepare(`
        SELECT 1 AS found FROM release_requests
        WHERE transfer_key = ? AND status = 'pending' LIMIT 1
      `).get(transferKey);
      if (pending) return null;
      const siblings = this.database.connection.prepare(`
        SELECT requested_paths_json FROM release_requests
        WHERE transfer_key = ? AND status = 'approved'
      `).all(transferKey) as Row[];
      requestedPaths = uniqueStrings(siblings.flatMap((sibling) => parseStringArray(sibling.requested_paths_json)));
    }
    const normalizedPaths = normalizePathList(requestedPaths);
    const requesterMemberId = asString(row.requester_member_id);
    const requesterSessionId = nullableString(row.requester_session_id);
    if (requesterSessionId) {
      const session = this.database.connection.prepare(`
        SELECT status FROM work_sessions WHERE id = ? AND member_id = ?
      `).get(requesterSessionId, requesterMemberId) as Row | undefined;
      if (!session || asString(session.status) !== "active") return null;
    }
    const settings = this.readRoomSettings(
      asString(row.room_id),
      transferredAt,
      asString(row.requester_name),
    );
    if (requestedKind === "exclusive") {
      const conflicts = this.findLeaseConflicts(
        asString(row.room_id),
        requesterMemberId,
        requesterSessionId,
        requestedKind,
        normalizedPaths,
        settings,
      );
      if (conflicts.some((conflict) => conflict.decision === "deny")) return null;
    }

    const requesterLeaseId = nullableString(row.requester_lease_id);
    let targetLease = requesterLeaseId
      ? this.database.connection.prepare(`
          SELECT id FROM leases
          WHERE id = ? AND member_id = ? AND room_id = ? AND status = 'active'
        `).get(requesterLeaseId, requesterMemberId, asString(row.room_id)) as Row | undefined
      : undefined;
    if (!targetLease) {
      targetLease = this.database.connection.prepare(`
        SELECT l.id FROM release_requests rr
        JOIN leases l ON l.id = rr.transferred_lease_id
        WHERE rr.transfer_key = ? AND l.status = 'active'
        ORDER BY rr.resolved_at DESC LIMIT 1
      `).get(transferKey) as Row | undefined;
    }
    let leaseId = targetLease ? asString(targetLease.id) : randomUUID();
    let durationMinutes: number;
    try {
      durationMinutes = resolveLeaseDurationMinutes(
        requestedKind,
        nullableNumber(row.requested_ttl_minutes) ?? undefined,
        settings,
      );
    } catch {
      durationMinutes = requestedKind === "exclusive"
        ? Math.min(60, settings.maximumExclusiveLeaseMinutes)
        : settings.automaticLeaseTtlMinutes;
    }
    const expiresAt = new Date(this.now().getTime() + durationMinutes * 60_000).toISOString();
    if (!targetLease) {
      this.database.connection.prepare(`
        INSERT INTO leases (
          id, room_id, member_id, session_id, title, intent, branch, base_commit,
          mode, kind, status, decision, override_reason, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'allow', ?, ?, ?, ?)
      `).run(
        leaseId,
        asString(row.room_id),
        requesterMemberId,
        requesterSessionId,
        asString(row.request_title),
        nullableString(row.request_objective) ?? "",
        nullableString(row.requested_branch),
        nullableString(row.requested_base_commit),
        asString(row.requested_mode),
        requestedKind,
        `Transferred by approved release request ${asString(row.id)}.`,
        expiresAt,
        transferredAt,
        transferredAt,
      );
    } else if (requestedKind !== "exclusive") {
      this.database.connection.prepare(`
        UPDATE leases SET expires_at = ?, updated_at = ? WHERE id = ?
      `).run(expiresAt, transferredAt, leaseId);
    }
    const insertPath = this.database.connection.prepare(`
      INSERT OR IGNORE INTO lease_paths (lease_id, path, path_key, risk, risk_reason)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const path of normalizedPaths) {
      insertPath.run(leaseId, path.path, pathComparisonKey(path.path), path.risk, path.riskReason);
    }
    this.insertActivity({
      roomId: asString(row.room_id),
      actorMemberId: null,
      actorName: null,
      type: "lease.transferred",
      entityType: "lease",
      entityId: leaseId,
      summary: "Approved conflict paths were atomically registered for the requester.",
      metadata: {
        releaseRequestId: asString(row.id),
        requesterMemberId,
        requestedKind,
        paths: normalizedPaths.map((path) => path.path),
      },
      createdAt: transferredAt,
    });
    return leaseId;
  }

  private findLeaseConflicts(
    roomId: string,
    requesterMemberId: string,
    requesterSessionId: string | null,
    requestedKind: LeaseKind,
    requestedPaths: ReturnType<typeof normalizePathList>,
    settings: RoomSettings,
    excludedLeaseIds: string[] = [],
  ): LeaseConflict[] {
    const rows = this.database.connection
      .prepare(`
        SELECT
          l.id AS lease_id, l.member_id, l.session_id, l.kind, l.expires_at,
          m.name AS member_name, lp.path AS existing_path
        FROM leases l
        JOIN members m ON m.id = l.member_id
        JOIN lease_paths lp ON lp.lease_id = l.id
        WHERE l.room_id = ? AND l.status = 'active' AND l.expires_at > ?
          AND l.mode = 'write'
      `)
      .all(roomId, this.timestamp()) as Row[];
    const excluded = new Set(excludedLeaseIds);
    const leases = new Map<string, {
      leaseId: string;
      memberId: string;
      memberName: string;
      sessionId: string | null;
      kind: LeaseKind;
      paths: string[];
      expiresAt: string;
    }>();
    for (const row of rows) {
      const leaseId = asString(row.lease_id);
      if (excluded.has(leaseId)) continue;
      const lease = leases.get(leaseId) ?? {
        leaseId,
        memberId: asString(row.member_id),
        memberName: asString(row.member_name),
        sessionId: nullableString(row.session_id),
        kind: asString(row.kind) as LeaseKind,
        paths: [],
        expiresAt: asString(row.expires_at),
      };
      lease.paths.push(asString(row.existing_path));
      leases.set(leaseId, lease);
    }
    const policy: RiskPolicy = {
      version: settings.riskPolicyVersion,
      rules: settings.riskRules,
    };
    const approvedCarveOutRows = this.database.connection.prepare(`
      SELECT
        rr.conflicting_lease_id, rr.requester_session_id, rr.requested_paths_json,
        rr.transferred_lease_id, transferred.member_id AS transferred_member_id,
        transferred.session_id AS transferred_session_id,
        transferred.kind AS transferred_kind, transferred_path.path AS transferred_path
      FROM release_requests rr
      JOIN leases transferred ON transferred.id = rr.transferred_lease_id
      JOIN lease_paths transferred_path ON transferred_path.lease_id = transferred.id
      WHERE rr.room_id = ? AND rr.status = 'approved'
        AND rr.requester_member_id = ?
        AND transferred.room_id = rr.room_id
        AND transferred.member_id = rr.requester_member_id
        AND transferred.status = 'active' AND transferred.expires_at > ?
    `).all(roomId, requesterMemberId, this.timestamp()) as Row[];
    const approvedCarveOuts = approvedCarveOutRows.flatMap((row) => {
      const approvedSessionId = nullableString(row.requester_session_id);
      if (approvedSessionId !== null && approvedSessionId !== requesterSessionId) return [];
      if (asString(row.transferred_member_id) !== requesterMemberId) return [];
      const transferredSessionId = nullableString(row.transferred_session_id);
      const transferredKind = asString(row.transferred_kind) as LeaseKind;
      const sessionCompatible = transferredSessionId === requesterSessionId
        || (transferredSessionId === null && transferredKind !== "automatic");
      if (!sessionCompatible) return [];
      return [{
        conflictingLeaseId: asString(row.conflicting_lease_id),
        requestedPaths: parseStringArray(row.requested_paths_json),
        transferredPaths: [asString(row.transferred_path)],
      }];
    });
    const conflicts = evaluateRealtimeOverlaps(
      {
        memberId: requesterMemberId,
        sessionId: requesterSessionId,
        kind: requestedKind,
        paths: requestedPaths.map((path) => path.path),
      },
      [...leases.values()],
      policy,
      settings.blockingProtectionEnabled,
    ).filter((conflict) => !approvedCarveOuts.some((carveOut) =>
      carveOut.conflictingLeaseId === conflict.leaseId
      && carveOut.requestedPaths.some((path) => pathScopeCovers(path, conflict.requestedPath))
      && carveOut.transferredPaths.some((path) => pathScopeCovers(path, conflict.requestedPath)),
    ));
    return conflicts.map((conflict) => ({
      id: randomUUID(),
      leaseId: conflict.leaseId,
      memberId: conflict.memberId,
      memberName: conflict.memberName,
      requestedPath: conflict.requestedPath,
      existingPath: conflict.existingPath,
      severity: conflict.severity,
      decision: conflict.decision,
      reason: conflict.reason,
      expiresAt: conflict.expiresAt,
      existingLeaseKind: conflict.existingLeaseKind,
    }));
  }

  private expireLeases(roomId: string, ownTransaction = true): void {
    const operation = () => {
      const expiredAt = this.timestamp();
      const rows = this.database.connection
        .prepare(`
          SELECT l.id, l.title, l.member_id, m.name AS member_name
          FROM leases l JOIN members m ON m.id = l.member_id
          WHERE l.room_id = ? AND l.status = 'active' AND l.expires_at <= ?
        `)
        .all(roomId, expiredAt) as Row[];
      const update = this.database.connection.prepare(
        "UPDATE leases SET status = 'expired', updated_at = ?, completed_at = ? WHERE id = ?",
      );
      for (const row of rows) {
        update.run(expiredAt, expiredAt, asString(row.id));
        this.database.connection.prepare(`
          UPDATE release_requests
          SET status = 'cancelled', resolved_at = ?
          WHERE conflicting_lease_id = ? AND status = 'pending'
        `).run(expiredAt, asString(row.id));
        this.insertActivity({
          roomId,
          actorMemberId: null,
          actorName: null,
          type: "lease.expired",
          entityType: "lease",
          entityId: asString(row.id),
          summary: `Lease expired: ${asString(row.title)} (${asString(row.member_name)}).`,
          metadata: { memberId: asString(row.member_id) },
          createdAt: expiredAt,
        });
      }
    };
    if (ownTransaction) this.database.transaction(operation);
    else operation();
  }

  private listMembers(roomId: string): Member[] {
    const rows = this.database.connection
      .prepare(`
        SELECT id AS member_id, room_id, name AS member_name, role, client_name,
          created_at AS member_created_at, last_seen_at, is_admin, removed_at,
          client_version, protocol_version, schema_version
        FROM members WHERE room_id = ? AND removed_at IS NULL ORDER BY created_at ASC
      `)
      .all(roomId) as Row[];
    return rows.map(mapMember);
  }

  private listLeases(roomId: string, activeOnly: boolean): Lease[] {
    const rows = this.database.connection
      .prepare(`
        SELECT l.*, m.name AS member_name
        FROM leases l JOIN members m ON m.id = l.member_id
        WHERE l.room_id = ? ${activeOnly ? "AND l.status = 'active'" : ""}
        ORDER BY l.created_at DESC
      `)
      .all(roomId) as Row[];
    return rows.map((row) => this.mapLease(row));
  }

  private listContextEntries(roomId: string): ContextEntry[] {
    const rows = this.database.connection
      .prepare(`
        SELECT c.*, m.name AS author_name
        FROM context_entries c JOIN members m ON m.id = c.author_member_id
        WHERE c.room_id = ? ORDER BY c.created_at DESC LIMIT 500
      `)
      .all(roomId) as Row[];
    return rows.map(mapContextEntry);
  }

  private listDecisions(roomId: string): Decision[] {
    const rows = this.database.connection
      .prepare(`
        SELECT d.*, m.name AS author_name
        FROM decisions d JOIN members m ON m.id = d.author_member_id
        WHERE d.room_id = ? ORDER BY d.created_at DESC LIMIT 500
      `)
      .all(roomId) as Row[];
    return rows.map(mapDecision);
  }

  private listVerifications(roomId: string): Verification[] {
    const rows = this.database.connection
      .prepare(`
        SELECT v.*, m.name AS author_name
        FROM verifications v JOIN members m ON m.id = v.author_member_id
        WHERE v.room_id = ? ORDER BY v.created_at DESC LIMIT 500
      `)
      .all(roomId) as Row[];
    return rows.map(mapVerification);
  }

  private listHandoffs(roomId: string): Handoff[] {
    const rows = this.database.connection
      .prepare(`
        SELECT h.*, fm.name AS from_member_name, tm.name AS to_member_name
        FROM handoffs h
        JOIN members fm ON fm.id = h.from_member_id
        LEFT JOIN members tm ON tm.id = h.to_member_id
        WHERE h.room_id = ? ORDER BY h.created_at DESC LIMIT 500
      `)
      .all(roomId) as Row[];
    return rows.map(mapHandoff);
  }

  private listRecords(roomId: string): ProjectRecord[] {
    const rows = this.database.connection
      .prepare(`
        SELECT r.*, m.name AS member_name
        FROM records r JOIN members m ON m.id = r.member_id
        WHERE r.room_id = ? ORDER BY r.created_at DESC LIMIT 500
      `)
      .all(roomId) as Row[];
    return rows.map(mapRecord);
  }

  private listSessions(roomId: string): WorkSession[] {
    const rows = this.database.connection
      .prepare(`
        SELECT * FROM work_sessions WHERE room_id = ?
        ORDER BY opened_at DESC LIMIT 500
      `)
      .all(roomId) as Row[];
    return rows.map(mapSession);
  }

  private listLocalScans(roomId: string): LocalScan[] {
    const rows = this.database.connection
      .prepare(`
        SELECT * FROM local_scans WHERE room_id = ?
        ORDER BY scanned_at DESC LIMIT 500
      `)
      .all(roomId) as Row[];
    return rows.map(mapLocalScan);
  }

  private listConflicts(roomId: string): LeaseConflict[] {
    const rows = this.database.connection
      .prepare(`
        SELECT c.*, m.id AS existing_member_id, m.name AS member_name, l.expires_at, l.kind AS existing_lease_kind
        FROM conflicts c
        JOIN leases l ON l.id = c.existing_lease_id
        JOIN members m ON m.id = l.member_id
        WHERE c.room_id = ?
          AND l.status = 'active' AND l.expires_at > ?
          AND EXISTS (
            SELECT 1 FROM lease_paths lp
            WHERE lp.lease_id = l.id AND lp.path = c.existing_path COLLATE NOCASE
          )
        ORDER BY c.created_at DESC LIMIT 200
      `)
      .all(roomId, this.timestamp()) as Row[];
    return rows.map((row) => ({
      id: asString(row.id),
      leaseId: asString(row.existing_lease_id),
      memberId: asString(row.existing_member_id),
      memberName: asString(row.member_name),
      requestedPath: asString(row.requested_path),
      existingPath: asString(row.existing_path),
      severity: asString(row.severity) as LeaseConflict["severity"],
      decision: asString(row.decision) as LeaseConflict["decision"],
      reason: asString(row.reason),
      expiresAt: asString(row.expires_at),
      existingLeaseKind: asString(row.existing_lease_kind) as LeaseKind,
    }));
  }

  private listActivitiesByRoom(roomId: string, limit: number): Activity[] {
    const rows = this.database.connection
      .prepare(`
        SELECT * FROM activities WHERE room_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?
      `)
      .all(roomId, limit) as Row[];
    return rows.map(mapActivity);
  }

  private insertRecord(
    auth: AuthenticatedMember,
    input: {
      id?: string;
      kind: RecordKind;
      title: string;
      summary: string;
      paths: string[];
      status: string;
      evidence: string[];
      commitHash: string | null;
      createdAt?: string;
    },
  ): ProjectRecord {
    const record: ProjectRecord = {
      id: input.id ?? randomUUID(),
      roomId: auth.room.id,
      memberId: auth.member.id,
      memberName: auth.member.displayName,
      kind: input.kind,
      title: input.title,
      summary: input.summary,
      paths: input.paths,
      status: input.status,
      evidence: input.evidence,
      commitHash: input.commitHash,
      createdAt: input.createdAt ?? this.timestamp(),
    };
    this.database.connection
      .prepare(`
        INSERT INTO records (
          id, room_id, member_id, kind, title, summary, paths_json,
          status, evidence_json, commit_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.roomId,
        record.memberId,
        record.kind,
        record.title,
        record.summary,
        json(record.paths),
        record.status,
        json(record.evidence),
        record.commitHash,
        record.createdAt,
      );
    return record;
  }

  private auditRecord(
    auth: AuthenticatedMember,
    type: string,
    entityType: string,
    entityId: string,
    summary: string,
    metadata: Record<string, unknown>,
  ): void {
    this.insertActivity({
      roomId: auth.room.id,
      actorMemberId: auth.member.id,
      actorName: auth.member.displayName,
      type,
      entityType,
      entityId,
      summary,
      metadata,
      createdAt: this.timestamp(),
    });
  }

  private insertActivity(activity: Omit<Activity, "id">): void {
    this.database.connection
      .prepare(`
        INSERT INTO activities (
          id, room_id, actor_member_id, actor_name, type, entity_type,
          entity_id, summary, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        activity.roomId,
        activity.actorMemberId,
        activity.actorName,
        activity.type,
        activity.entityType,
        activity.entityId,
        activity.summary,
        json(activity.metadata),
        activity.createdAt,
      );
  }

  private requireRoomById(id: string): Room {
    const row = this.database.connection
      .prepare(`
        SELECT id AS room_id, code, name AS room_name, project_name, repository,
          default_branch, created_at AS room_created_at, status AS room_status,
          auto_lock_after_auto_claim, settings_updated_at, settings_updated_by
        FROM rooms WHERE id = ?
      `)
      .get(id) as Row | undefined;
    if (!row) throw new AgentHubError("room_not_found", "Room not found.", 404);
    return mapRoom(row);
  }

  private requireMemberById(id: string): Member {
    const row = this.database.connection
      .prepare(`
        SELECT id AS member_id, room_id, name AS member_name, role, client_name,
          created_at AS member_created_at, last_seen_at, is_admin, removed_at,
          client_version, protocol_version, schema_version
        FROM members WHERE id = ?
      `)
      .get(id) as Row | undefined;
    if (!row) throw new AgentHubError("member_not_found", "Member not found.", 404);
    return mapMember(row);
  }

  private requireLeaseById(id: string): Lease {
    const row = this.database.connection
      .prepare(`
        SELECT l.*, m.name AS member_name
        FROM leases l JOIN members m ON m.id = l.member_id WHERE l.id = ?
      `)
      .get(id) as Row | undefined;
    if (!row) throw new AgentHubError("lease_not_found", "Lease not found.", 404);
    return this.mapLease(row);
  }

  private requireRoomLease(id: string, roomId: string): Lease {
    const lease = this.requireLeaseById(id);
    if (lease.roomId !== roomId) {
      throw new AgentHubError("lease_not_found", "Lease not found in this room.", 404);
    }
    return lease;
  }

  private requireOwnedLease(id: string, auth: AuthenticatedMember): Lease {
    const lease = this.requireRoomLease(requiredString(id, "Lease id", 100), auth.room.id);
    if (lease.memberId !== auth.member.id) {
      throw new AgentHubError("lease_forbidden", "A member can only change their own lease.", 403);
    }
    return lease;
  }

  private requireSessionById(id: string): WorkSession {
    const row = this.database.connection
      .prepare("SELECT * FROM work_sessions WHERE id = ?")
      .get(id) as Row | undefined;
    if (!row) throw new AgentHubError("session_not_found", "Session not found.", 404);
    return mapSession(row);
  }

  private requireRoomMember(id: string, roomId: string): Member {
    const member = this.requireMemberById(requiredString(id, "Member id", 128));
    if (member.roomId !== roomId || member.removedAt) {
      throw new AgentHubError("member_not_found", "Member not found in this room.", 404);
    }
    return member;
  }

  private isOwner(auth: AuthenticatedMember): boolean {
    return auth.member.role === "host";
  }

  private requireOwner(auth: AuthenticatedMember): void {
    if (!this.isOwner(auth)) throw new AgentHubError("owner_required", "Only the room owner can perform this operation.", 403);
  }

  private requireAdmin(auth: AuthenticatedMember): void {
    if (!this.isOwner(auth) && !auth.member.isAdmin) throw new AgentHubError("admin_required", "Only the owner or an administrator can perform this operation.", 403);
  }

  private requireOwnedSession(id: string, auth: AuthenticatedMember): WorkSession {
    const session = this.requireSessionById(requiredString(id, "Session id", 100));
    if (session.roomId !== auth.room.id || session.memberId !== auth.member.id) {
      throw new AgentHubError("session_not_found", "Session not found for this member.", 404);
    }
    return session;
  }

  private activeOwnedSessionId(
    value: string | undefined,
    auth: AuthenticatedMember,
  ): string | null {
    if (value === undefined) return null;
    const session = this.requireOwnedSession(value, auth);
    if (session.status !== "active") {
      throw new AgentHubError("session_not_active", "The work session is closed.", 409);
    }
    return session.id;
  }

  private featureActor(auth: AuthenticatedMember): FeatureMemoryActor {
    return {
      roomId: auth.room.id,
      memberId: auth.member.id,
      memberName: auth.member.displayName,
      defaultBranch: auth.room.defaultBranch,
    };
  }

  private featureSession(
    session: WorkSession,
    promotionEvidenceVerified = false,
  ): FeatureMemorySession {
    return {
      id: session.id,
      memberId: session.memberId,
      branch: session.branch,
      baseCommit: session.baseCommit,
      status: session.status,
      promotionEvidenceVerified,
    };
  }

  private featurePromotionEvidenceVerified(
    session: WorkSession,
    claims: FeaturePromotionClaims,
  ): boolean {
    if (session.status !== "active" || !claims.finalCommit || claims.verifications.length === 0) return false;
    if (claims.verifications.some((verification) => verification.result !== "passed")) return false;

    const scanRow = this.database.connection.prepare(`
      SELECT * FROM local_scans
      WHERE session_id = ?
      ORDER BY scanned_at DESC
    `).all(session.id).find((row) => featureEvidenceAttestation(mapLocalScan(row as Row).metadata)) as Row | undefined;
    if (!scanRow) return false;
    const scan = mapLocalScan(scanRow);
    const evidence = featureEvidenceAttestation(scan.metadata);
    if (!evidence) return false;

    if (!sameText(evidence.finalCommit, claims.finalCommit)) return false;
    if (!sameText(evidence.branch, claims.branch)) return false;
    if (!sameText(scan.branch, evidence.branch) || !sameText(session.branch, evidence.branch)) return false;
    if (!evidence.committed || evidence.uncommittedPathCount > 0 || evidence.changedPathCount === 0) return false;
    if (evidence.committedPathCount !== evidence.changedPathCount) return false;
    if (scan.changedPaths.length !== evidence.changedPathCount) return false;
    if (digestEvidenceSet(scan.changedPaths, pathComparisonKey) !== evidence.changedPathsSha256) return false;
    if (!evidence.finalCommitIncluded) return false;
    if (!gitClaimsMatchAttestation(claims.gitEvidence ?? {}, evidence, scan.changedPaths)) return false;

    const claimedPaths = uniqueStrings(claims.paths);
    if (claimedPaths.length === 0) return false;
    if (!claimedPaths.every((claimedPath) =>
      scan.changedPaths.some((changedPath) => pathsOverlap(claimedPath, changedPath)))) return false;
    if (!scan.changedPaths.every((changedPath) =>
      claimedPaths.some((claimedPath) => pathsOverlap(claimedPath, changedPath)))) return false;

    const verificationRows = this.database.connection.prepare(`
      SELECT v.*, l.session_id, lp.path AS lease_path
      FROM verifications v
      JOIN leases l ON l.id = v.lease_id
      JOIN lease_paths lp ON lp.lease_id = l.id
      WHERE l.session_id = ?
        AND v.author_member_id = ?
        AND v.created_at >= ?
        AND v.created_at <= ?
      ORDER BY v.created_at DESC, v.id DESC
    `).all(session.id, session.memberId, session.openedAt, scan.scannedAt) as Row[];
    const consumedVerificationIds = new Set<string>();
    for (const claim of claims.verifications) {
      const matching = verificationRows.find((row) => {
        const id = asString(row.id);
        if (consumedVerificationIds.has(id)) return false;
        if (asString(row.result) !== claim.result || asString(row.summary) !== claim.summary) return false;
        if (!sameNullableText(nullableString(row.command), claim.command)) return false;
        if (!sameNullableText(nullableString(row.evidence), claim.evidence)) return false;
        const leasePath = nullableString(row.lease_path);
        return leasePath !== null
          && scan.changedPaths.some((changedPath) => pathsOverlap(leasePath, changedPath));
      });
      if (!matching) return false;
      consumedVerificationIds.add(asString(matching.id));
    }
    return true;
  }

  private featureRevisionTargetPaths(roomId: string, revisionId: string): string[] {
    const rows = this.database.connection.prepare(`
      SELECT t.path
      FROM feature_revision_targets t
      JOIN feature_revisions r ON r.id = t.revision_id
      JOIN feature_memories f ON f.id = r.feature_id
      WHERE t.revision_id = ? AND f.room_id = ? AND t.path IS NOT NULL
    `).all(revisionId, roomId) as Row[];
    return uniqueStrings(rows.map((row) => asString(row.path)));
  }

  private promoteRecordedSessionCandidates(
    auth: AuthenticatedMember,
    session: WorkSession,
    scan: LocalScan,
  ): void {
    if (!featureEvidenceAttestation(scan.metadata)) return;
    const rows = this.database.connection.prepare(`
      SELECT r.id, r.branch, r.final_commit, r.git_evidence_json, r.verifications_json
      FROM feature_revisions r
      JOIN feature_revision_events e ON e.sequence = (
        SELECT MAX(latest.sequence)
        FROM feature_revision_events latest
        WHERE latest.revision_id = r.id
      )
      WHERE r.source_session_id = ? AND e.status = 'candidate'
      ORDER BY r.revision_number ASC
    `).all(session.id) as Row[];
    for (const row of rows) {
      const revisionId = asString(row.id);
      const pathRows = this.database.connection.prepare(`
        SELECT path FROM feature_revision_targets
        WHERE revision_id = ? AND path IS NOT NULL
      `).all(revisionId) as Row[];
      const gitEvidence = parseObject(row.git_evidence_json);
      const submittedTargetPaths = stringListValue(gitEvidence[FEATURE_SUBMITTED_TARGET_PATHS_KEY])
        ?? pathRows.map((pathRow) => asString(pathRow.path));
      const claims: FeaturePromotionClaims = {
        branch: nullableString(row.branch),
        finalCommit: nullableString(row.final_commit) ?? undefined,
        gitEvidence,
        verifications: parseJsonArray<FeatureVerificationEvidence>(row.verifications_json),
        paths: submittedTargetPaths,
      };
      if (!this.featurePromotionEvidenceVerified(session, claims)) continue;
      const revision = this.featureMemoryCall(() => this.featureMemory.promoteCandidate(
        this.featureActor(auth),
        this.featureSession(session, true),
        revisionId,
      ));
      if (revision.status === "current" || revision.status === "deprecated") {
        this.auditRecord(
          auth,
          "feature.revision.promoted",
          "feature_revision",
          revision.id,
          `Promoted feature revision ${revision.revisionNumber} after matching final Hook and verification evidence.`,
          { featureId: revision.featureId, sessionId: session.id, scanId: scan.id },
        );
      }
    }
  }

  private featureMemoryCall<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof FeatureMemoryError) {
        throw new AgentHubError(error.code, error.message, error.status, error.details);
      }
      throw error;
    }
  }

  private requireLeaseSession(lease: Lease, sessionId: string | null | undefined): void {
    if (sessionId === undefined) return;
    if (lease.sessionId !== sessionId) {
      throw new AgentHubError(
        "lease_session_mismatch",
        "The lease belongs to a different work session.",
        409,
      );
    }
  }

  private mapLease(row: Row): Lease {
    const pathRows = this.database.connection
      .prepare("SELECT path, risk, risk_reason FROM lease_paths WHERE lease_id = ? ORDER BY path_key")
      .all(asString(row.id)) as Row[];
    return {
      id: asString(row.id),
      roomId: asString(row.room_id),
      memberId: asString(row.member_id),
      sessionId: nullableString(row.session_id),
      memberName: asString(row.member_name),
      title: asString(row.title),
      objective: nullableString(row.intent),
      branch: nullableString(row.branch),
      baseCommit: nullableString(row.base_commit),
      mode: asString(row.mode) as LeaseMode,
      kind: asString(row.kind ?? "standard") as LeaseKind,
      decision: asString(row.decision) as Lease["decision"],
      overrideReason: nullableString(row.override_reason),
      status: asString(row.status) as Lease["status"],
      paths: pathRows.map((path) => ({
        path: asString(path.path),
        risk: asString(path.risk) as "normal" | "high",
        riskReason: nullableString(path.risk_reason),
      })),
      expiresAt: asString(row.expires_at),
      createdAt: asString(row.created_at),
      updatedAt: asString(row.updated_at),
      completedAt: nullableString(row.completed_at),
      completionSummary: nullableString(row.completion_summary),
    };
  }

  private createUniqueInviteCode(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = randomBytes(5).toString("hex").toUpperCase();
      const exists = this.database.connection
        .prepare("SELECT 1 AS found FROM rooms WHERE code = ? COLLATE NOCASE")
        .get(code);
      if (!exists) return code;
    }
    throw new AgentHubError("invite_generation_failed", "Could not create an invitation code.", 500);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function mapRoom(row: Row): Room {
  return {
    id: asString(row.room_id),
    code: asString(row.code),
    name: asString(row.room_name),
    projectName: asString(row.project_name),
    repository: asString(row.repository),
    defaultBranch: asString(row.default_branch),
    createdAt: asString(row.room_created_at),
    status: (typeof row.room_status === "string" ? row.room_status : "active") as Room["status"],
    autoLockAfterAutoClaim: Number(row.auto_lock_after_auto_claim ?? 1) !== 0,
  };
}

function mapMember(row: Row): Member {
  const protocolVersion = nullableNumber(row.protocol_version);
  const schemaVersion = nullableNumber(row.schema_version);
  return {
    id: asString(row.member_id),
    roomId: asString(row.room_id),
    displayName: asString(row.member_name),
    role: asString(row.role) as Member["role"],
    agent: nullableString(row.client_name),
    createdAt: asString(row.member_created_at),
    lastSeenAt: asString(row.last_seen_at),
    isAdmin: Number(row.is_admin ?? 0) !== 0,
    removedAt: nullableString(row.removed_at),
    clientVersion: nullableString(row.client_version),
    protocolVersion,
    schemaVersion,
    compatibility: memberCompatibility(protocolVersion, schemaVersion),
  };
}

function mapContextEntry(row: Row): ContextEntry {
  return {
    id: asString(row.id),
    roomId: asString(row.room_id),
    authorMemberId: asString(row.author_member_id),
    authorName: asString(row.author_name),
    kind: asString(row.kind) as ContextEntry["kind"],
    title: asString(row.title),
    content: asString(row.content),
    paths: parseStringArray(row.paths_json),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
}

function mapDecision(row: Row): Decision {
  return {
    id: asString(row.id),
    roomId: asString(row.room_id),
    authorMemberId: asString(row.author_member_id),
    authorName: asString(row.author_name),
    title: asString(row.title),
    decision: asString(row.decision),
    rationale: nullableString(row.rationale),
    paths: parseStringArray(row.paths_json),
    createdAt: asString(row.created_at),
  };
}

function mapVerification(row: Row): Verification {
  return {
    id: asString(row.id),
    roomId: asString(row.room_id),
    authorMemberId: asString(row.author_member_id),
    authorName: asString(row.author_name),
    leaseId: nullableString(row.lease_id),
    kind: asString(row.kind) as Verification["kind"],
    result: asString(row.result) as Verification["result"],
    summary: asString(row.summary),
    command: nullableString(row.command),
    evidence: nullableString(row.evidence),
    createdAt: asString(row.created_at),
  };
}

function mapHandoff(row: Row): Handoff {
  return {
    id: asString(row.id),
    roomId: asString(row.room_id),
    fromMemberId: asString(row.from_member_id),
    fromMemberName: asString(row.from_member_name),
    toMemberId: nullableString(row.to_member_id),
    toMemberName: nullableString(row.to_member_name),
    leaseId: nullableString(row.lease_id),
    summary: asString(row.summary),
    completed: parseStringArray(row.completed_json),
    remaining: parseStringArray(row.remaining_json),
    risks: parseStringArray(row.risks_json),
    createdAt: asString(row.created_at),
  };
}

function mapRecord(row: Row): ProjectRecord {
  return {
    id: asString(row.id),
    roomId: asString(row.room_id),
    memberId: asString(row.member_id),
    memberName: asString(row.member_name),
    kind: asString(row.kind) as RecordKind,
    title: asString(row.title),
    summary: asString(row.summary),
    paths: parseStringArray(row.paths_json),
    status: asString(row.status),
    evidence: parseStringArray(row.evidence_json),
    commitHash: nullableString(row.commit_hash),
    createdAt: asString(row.created_at),
  };
}

function mapActivity(row: Row): Activity {
  return {
    id: asString(row.id),
    roomId: asString(row.room_id),
    actorMemberId: nullableString(row.actor_member_id),
    actorName: nullableString(row.actor_name),
    type: asString(row.type),
    entityType: asString(row.entity_type),
    entityId: nullableString(row.entity_id),
    summary: asString(row.summary),
    metadata: parseObject(row.metadata_json),
    createdAt: asString(row.created_at),
  };
}

function mapSession(row: Row): WorkSession {
  return {
    id: asString(row.id),
    roomId: asString(row.room_id),
    memberId: asString(row.member_id),
    clientName: nullableString(row.client_name),
    agentName: nullableString(row.agent_name),
    repository: nullableString(row.repository),
    branch: nullableString(row.branch),
    worktree: nullableString(row.worktree),
    baseCommit: nullableString(row.base_commit),
    task: nullableString(row.task),
    status: row.frozen_reason ? "frozen" : asString(row.status) as WorkSession["status"],
    branchEpoch: Number(row.branch_epoch ?? 1),
    frozenReason: nullableString(row.frozen_reason),
    metadata: parseObject(row.metadata_json),
    openedAt: asString(row.opened_at),
    lastSeenAt: asString(row.last_seen_at),
    closedAt: nullableString(row.closed_at),
    clientVersion: nullableString(row.client_version),
    protocolVersion: nullableNumber(row.protocol_version),
    schemaVersion: nullableNumber(row.schema_version),
  };
}

function mapLocalScan(row: Row): LocalScan {
  return {
    id: asString(row.id),
    sessionId: asString(row.session_id),
    roomId: asString(row.room_id),
    memberId: asString(row.member_id),
    repository: nullableString(row.repository),
    branch: nullableString(row.branch),
    worktree: nullableString(row.worktree),
    baseCommit: nullableString(row.base_commit),
    changedPaths: parseStringArray(row.changed_paths_json),
    ruleFiles: parseStringArray(row.rule_files_json),
    systems: parseStringArray(row.systems_json),
    metadata: parseObject(row.metadata_json),
    scannedAt: asString(row.scanned_at),
  };
}

function createMemberToken(): string {
  return `ahm_${randomBytes(32).toString("base64url")}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function normalizeInviteCode(value: string): string {
  const code = requiredString(value, "Invitation code", 32).replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(code)) {
    throw new AgentHubError("invalid_invite", "The invitation code format is invalid.");
  }
  return code;
}

function normalizeLeaseMode(mode: LeaseMode | undefined): LeaseMode {
  if (mode === undefined) return "write";
  if (mode !== "read" && mode !== "write") {
    throw new AgentHubError("invalid_lease_mode", "Lease mode must be read or write.");
  }
  return mode;
}

function normalizeLeaseKind(kind: LeaseKind | undefined, autoClaim: boolean | undefined): LeaseKind {
  if (autoClaim) {
    if (kind && kind !== "automatic") {
      throw new AgentHubError(
        "invalid_lease_kind",
        "autoClaim can only create an automatic lease.",
      );
    }
    return "automatic";
  }
  if (kind === undefined) return "standard";
  if (!["automatic", "standard", "exclusive"].includes(kind)) {
    throw new AgentHubError(
      "invalid_lease_kind",
      "Lease kind must be automatic, standard, or exclusive.",
    );
  }
  return kind;
}

function normalizeAutomaticTtlMinutes(value: number): RoomSettings["automaticLeaseTtlMinutes"] {
  if (!Number.isInteger(value) || !AUTOMATIC_TTL_OPTIONS.includes(
    value as (typeof AUTOMATIC_TTL_OPTIONS)[number],
  )) {
    throw new AgentHubError(
      "invalid_automatic_lease_ttl",
      "Automatic lease TTL must be 5, 10, 15, 30, or 60 minutes.",
    );
  }
  return value as RoomSettings["automaticLeaseTtlMinutes"];
}

function normalizeMaximumExclusiveLeaseMinutes(value: number): number {
  if (!Number.isInteger(value) || value < 5 || value > 7 * 24 * 60) {
    throw new AgentHubError(
      "invalid_maximum_exclusive_lease_ttl",
      "Maximum exclusive lease duration must be between 5 minutes and 7 days.",
    );
  }
  return value;
}

function normalizeRecordKind(kind: RecordKind): RecordKind {
  if (!["decision", "validation", "handoff", "risk"].includes(kind)) {
    throw new AgentHubError("invalid_record_kind", "Unsupported record kind.");
  }
  return kind;
}

function defaultRecordStatus(kind: RecordKind): string {
  if (kind === "risk") return "open";
  if (kind === "decision") return "accepted";
  return "reported";
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentHubError("invalid_input", `${label} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new AgentHubError("invalid_input", `${label} cannot exceed ${maxLength} characters.`);
  }
  return normalized;
}

function optionalString(value: unknown, label: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, label, maxLength);
}

function optionalVersionNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1_000_000) {
    throw new AgentHubError("invalid_input", `${label} must be a positive integer.`);
  }
  return value;
}

function stringArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxItemLength: number,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new AgentHubError("invalid_input", `${label} must contain at most ${maxItems} items.`);
  }
  return value.map((item, index) => requiredString(item, `${label}[${index}]`, maxItemLength));
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new AgentHubError("invalid_input", `${label} must be an object.`);
  }
  const object = value as Record<string, unknown>;
  if (json(object).length > 32_000) {
    throw new AgentHubError("invalid_input", `${label} is too large.`);
  }
  return object;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function memberCompatibility(
  protocolVersion: number | null,
  schemaVersion: number | null,
): Member["compatibility"] {
  if (protocolVersion === null || schemaVersion === null) return "unknown";
  return protocolVersion === AGENT_HUB_PROTOCOL_VERSION && schemaVersion === AGENT_HUB_SCHEMA_VERSION
    ? "compatible"
    : "incompatible";
}

function uniqueStrings(values: string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    const key = value.toLocaleLowerCase("en-US");
    if (!unique.has(key)) unique.set(key, value);
  }
  return [...unique.values()];
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(asString(value));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseOverlapPaths(
  value: unknown,
): Array<{ requestedPath: string; existingPath: string }> {
  try {
    const parsed: unknown = JSON.parse(asString(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.requestedPath !== "string" || typeof record.existingPath !== "string") {
        return [];
      }
      return [{ requestedPath: record.requestedPath, existingPath: record.existingPath }];
    });
  } catch {
    return [];
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(asString(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray<T>(value: unknown): T[] {
  try {
    const parsed: unknown = JSON.parse(asString(value));
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function featureEvidenceAttestation(metadata: Record<string, unknown>): FeatureEvidenceAttestation | null {
  if (metadata.source !== "codex-hook" || metadata.event !== "SessionEnd") return null;
  const value = metadata.featureEvidence;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const branch = stringField(record, "branch");
  const baseCommit = stringField(record, "baseCommit");
  const finalCommit = stringField(record, "finalCommit");
  const diffSha256 = stringField(record, "diffSha256");
  if (
    typeof record.committed !== "boolean"
    || !branch
    || !/^[0-9a-f]{7,64}$/i.test(baseCommit ?? "")
    || !/^[0-9a-f]{7,64}$/i.test(finalCommit ?? "")
    || !/^[0-9a-f]{64}$/i.test(diffSha256 ?? "")
  ) {
    return null;
  }
  if (record.version === 1) {
    const committedPaths = stringListField(record, "committedPaths");
    const uncommittedPaths = stringListField(record, "uncommittedPaths");
    const changedPaths = stringListField(record, "changedPaths");
    const commitHashes = stringListField(record, "commitHashes");
    if (!committedPaths || !uncommittedPaths || !changedPaths || !commitHashes) return null;
    return {
      version: 1,
      branch,
      baseCommit: baseCommit!,
      finalCommit: finalCommit!,
      committed: record.committed,
      committedPathCount: evidenceSetSize(committedPaths, pathComparisonKey),
      uncommittedPathCount: evidenceSetSize(uncommittedPaths, pathComparisonKey),
      changedPathCount: evidenceSetSize(changedPaths, pathComparisonKey),
      changedPathsSha256: digestEvidenceSet(changedPaths, pathComparisonKey),
      commitHashCount: evidenceSetSize(commitHashes, normalizedEvidenceText),
      commitHashesSha256: digestEvidenceSet(commitHashes, normalizedEvidenceText),
      finalCommitIncluded: commitHashes.some((hash) => sameText(hash, finalCommit)),
      diffSha256: diffSha256!,
    };
  }
  const committedPathCount = nonNegativeIntegerField(record, "committedPathCount");
  const uncommittedPathCount = nonNegativeIntegerField(record, "uncommittedPathCount");
  const changedPathCount = nonNegativeIntegerField(record, "changedPathCount");
  const changedPathsSha256 = stringField(record, "changedPathsSha256");
  const commitHashCount = nonNegativeIntegerField(record, "commitHashCount");
  const commitHashesSha256 = stringField(record, "commitHashesSha256");
  if (
    record.version !== 2
    || committedPathCount === null
    || uncommittedPathCount === null
    || changedPathCount === null
    || commitHashCount === null
    || !/^[0-9a-f]{64}$/i.test(changedPathsSha256 ?? "")
    || !/^[0-9a-f]{64}$/i.test(commitHashesSha256 ?? "")
    || typeof record.finalCommitIncluded !== "boolean"
  ) return null;
  return {
    version: 2,
    branch,
    baseCommit: baseCommit!,
    finalCommit: finalCommit!,
    committed: record.committed,
    committedPathCount,
    uncommittedPathCount,
    changedPathCount,
    changedPathsSha256: changedPathsSha256!,
    commitHashCount,
    commitHashesSha256: commitHashesSha256!,
    finalCommitIncluded: record.finalCommitIncluded,
    diffSha256: diffSha256!,
  };
}

function gitClaimsMatchAttestation(
  claims: Record<string, unknown>,
  evidence: FeatureEvidenceAttestation,
  changedPaths: string[],
): boolean {
  const scalarClaims: Array<[string, string]> = [
    ["branch", evidence.branch],
    ["baseCommit", evidence.baseCommit],
    ["finalCommit", evidence.finalCommit],
    ["diffSha256", evidence.diffSha256],
  ];
  for (const [key, expected] of scalarClaims) {
    if (key in claims && !sameText(claims[key], expected)) return false;
  }
  if ("committed" in claims && claims.committed !== evidence.committed) return false;
  if ("changedPaths" in claims) {
    const values = stringListValue(claims.changedPaths);
    if (!values || !samePathSet(values, changedPaths)) return false;
  }
  if ("committedPaths" in claims) {
    const values = stringListValue(claims.committedPaths);
    if (!values || evidenceSetSize(values, pathComparisonKey) !== evidence.committedPathCount) return false;
    if (evidence.uncommittedPathCount === 0 && !samePathSet(values, changedPaths)) return false;
  }
  if ("uncommittedPaths" in claims) {
    const values = stringListValue(claims.uncommittedPaths);
    if (!values || evidenceSetSize(values, pathComparisonKey) !== evidence.uncommittedPathCount) return false;
  }
  if ("commits" in claims) {
    if (!Array.isArray(claims.commits)) return false;
    const commitHashes = claims.commits.flatMap((commit) => {
      if (!commit || typeof commit !== "object" || Array.isArray(commit)) return [];
      const hash = stringField(commit as Record<string, unknown>, "hash");
      return hash ? [hash] : [];
    });
    if (evidenceSetSize(commitHashes, normalizedEvidenceText) !== evidence.commitHashCount) return false;
    if (digestEvidenceSet(commitHashes, normalizedEvidenceText) !== evidence.commitHashesSha256) return false;
  }
  return true;
}

function samePathSet(left: string[], right: string[]): boolean {
  return sameTextSet(left.map(pathComparisonKey), right.map(pathComparisonKey));
}

function sameTextSet(left: string[], right: string[]): boolean {
  const normalizedLeft = [...new Set(left.map(normalizedEvidenceText).filter(Boolean))].sort();
  const normalizedRight = [...new Set(right.map(normalizedEvidenceText).filter(Boolean))].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function evidenceSetSize(values: string[], normalize: (value: string) => string): number {
  return new Set(values.map(normalize).filter(Boolean)).size;
}

function digestEvidenceSet(values: string[], normalize: (value: string) => string): string {
  const normalized = [...new Set(values.map(normalize).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, "en-US"));
  return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}

function sameText(left: unknown, right: unknown): boolean {
  return normalizedEvidenceText(left) === normalizedEvidenceText(right);
}

function sameNullableText(left: string | null, right: string | undefined): boolean {
  return normalizedEvidenceText(left) === normalizedEvidenceText(right);
}

function normalizedEvidenceText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase("en-US") : "";
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonNegativeIntegerField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000
    ? value
    : null;
}

function stringListField(record: Record<string, unknown>, key: string): string[] | null {
  return stringListValue(record[key]);
}

function stringListValue(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return value.map((item) => item.trim()).filter(Boolean);
}
