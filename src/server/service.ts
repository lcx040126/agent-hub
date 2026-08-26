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
  type LeaseMode,
  type ListActivityInput,
  type LocalScan,
  type Member,
  type ProjectRecord,
  type RecordKind,
  type ReleaseLeaseInput,
  type RenewLeaseInput,
  type Room,
  type RoomSnapshot,
  type Verification,
  type WorkSession,
  type ClaimLeaseInput,
  type ContextExport,
  type RoomSettings,
} from "./domain.js";
import { AgentHubDatabase } from "./db.js";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVITY_LIMIT = 200;

type Row = Record<string, unknown>;

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
}

export interface UpdateRoomSettingsInput {
  memberToken: string;
  autoLockAfterAutoClaim: boolean;
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

  constructor(
    readonly database: AgentHubDatabase,
    options: AgentHubServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  createRoom(input: CreateRoomInput): CreateRoomResult {
    const name = requiredString(input.name, "Room name", 120);
    const projectName = optionalString(input.projectName, "Project name", 160) ?? name;
    const repository = requiredString(input.repository, "Repository", 1000);
    const defaultBranch = optionalString(input.defaultBranch, "Default branch", 255) ?? "main";
    const hostName = requiredString(input.hostName, "Owner name", 120);
    const hostAgent = optionalString(input.hostAgent, "Client name", 160);
    const createdAt = this.timestamp();
    const roomId = randomUUID();
    const memberId = randomUUID();
    const memberToken = createMemberToken();
    const code = this.createUniqueInviteCode();

    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO rooms (id, code, name, project_name, repository, default_branch, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(roomId, code, name, projectName, repository, defaultBranch, createdAt);
      this.database.connection
        .prepare(`
          INSERT INTO members
            (id, room_id, name, role, client_name, token_hash, created_at, last_seen_at)
          VALUES (?, ?, ?, 'host', ?, ?, ?, ?)
        `)
        .run(
          memberId,
          roomId,
          hostName,
          hostAgent,
          hashToken(memberToken),
          createdAt,
          createdAt,
        );
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
            (id, room_id, name, role, client_name, token_hash, created_at, last_seen_at)
          VALUES (?, ?, ?, 'member', ?, ?, ?, ?)
        `)
        .run(memberId, roomId, displayName, agent, hashToken(token), createdAt, createdAt);
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
    return {
      room: auth.room,
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
      generatedAt: this.timestamp(),
    };
  }

  getDashboard(memberToken: string): DashboardData {
    const auth = this.authenticateMemberToken(memberToken);
    this.expireLeases(auth.room.id);
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
    };
  }

  getRoomSettings(memberToken: string): RoomSettings {
    const auth = this.authenticateMemberToken(memberToken);
    return {
      autoLockAfterAutoClaim: auth.room.autoLockAfterAutoClaim,
      updatedAt: (this.database.connection.prepare("SELECT settings_updated_at FROM rooms WHERE id = ?").get(auth.room.id) as Row | undefined)?.settings_updated_at as string ?? auth.room.createdAt,
      updatedBy: (this.database.connection.prepare("SELECT settings_updated_by FROM rooms WHERE id = ?").get(auth.room.id) as Row | undefined)?.settings_updated_by as string ?? auth.member.displayName,
    };
  }

  updateRoomSettings(input: UpdateRoomSettingsInput): RoomSettings {
    const auth = this.authenticateMemberToken(input.memberToken);
    this.requireAdmin(auth);
    if (typeof input.autoLockAfterAutoClaim !== "boolean") throw new AgentHubError("invalid_setting", "autoLockAfterAutoClaim must be boolean.");
    const now = this.timestamp();
    this.database.transaction(() => {
      this.database.connection.prepare("UPDATE rooms SET auto_lock_after_auto_claim = ?, settings_updated_at = ?, settings_updated_by = ? WHERE id = ?").run(input.autoLockAfterAutoClaim ? 1 : 0, now, auth.member.id, auth.room.id);
      this.auditRecord(auth, "room.settings.updated", "room", auth.room.id, `${auth.member.displayName} updated room settings.`, { autoLockAfterAutoClaim: input.autoLockAfterAutoClaim });
    });
    return { autoLockAfterAutoClaim: input.autoLockAfterAutoClaim, updatedAt: now, updatedBy: auth.member.displayName };
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
      this.database.connection.prepare("UPDATE members SET removed_at = ?, token_hash = ? WHERE id = ? AND room_id = ?").run(now, `revoked_${randomUUID()}`, target.id, auth.room.id);
      this.auditRecord(auth, "member.removed", "member", target.id, `${auth.member.displayName} removed ${target.displayName} from the room.`, {});
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
    const overrideReason = optionalString(input.overrideReason, "Override reason", 1000);
    const paths = normalizePathList(input.paths);
    const ttlMs = normalizeTtl(input.ttlMs);
    const createdAt = this.timestamp();
    const expiresAt = new Date(this.now().getTime() + ttlMs).toISOString();

    return this.database.transaction(() => {
      this.expireLeases(auth.room.id, false);
      const conflicts = mode === "write"
        ? this.findLeaseConflicts(auth.room.id, auth.member.id, sessionId, paths)
        : [];
      if (input.autoClaim && auth.room.autoLockAfterAutoClaim) {
        for (const conflict of conflicts) {
          if (conflict.severity === "warning") {
            conflict.severity = "blocking";
            conflict.decision = "deny";
            conflict.reason = "Automatic range locking is enabled for this room; overlapping automatic work is denied.";
          }
        }
      }
      const hasBlocking = conflicts.some((conflict) => conflict.severity === "blocking");
      const hasWarning = conflicts.some((conflict) => conflict.severity === "warning");
      const decision = hasBlocking ? "deny" : hasWarning ? "warn" : "allow";
      const canAcquire = !hasBlocking && (!hasWarning || Boolean(overrideReason));
      const leaseId = canAcquire ? randomUUID() : null;

      if (leaseId) {
        this.database.connection
          .prepare(`
            INSERT INTO leases (
              id, room_id, member_id, session_id, title, intent, branch, base_commit, mode, status,
              decision, override_reason, expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
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
              ? `${auth.member.displayName}'s lease was denied by an exclusive overlap.`
              : `${auth.member.displayName}'s lease needs an override reason.`,
          metadata: { title, decision, paths: paths.map((path) => path.path) },
          createdAt,
        });
        return { acquired: false, decision, conflicts } as LeaseClaimResult;
      }

      this.insertActivity({
        roomId: auth.room.id,
        actorMemberId: auth.member.id,
        actorName: auth.member.displayName,
        type: "lease.acquired",
        entityType: "lease",
        entityId: leaseId,
        summary: `${auth.member.displayName} registered ${mode} work: ${title}.`,
        metadata: {
          paths: paths.map((path) => path.path),
          decision,
          expiresAt,
          hasOverride: Boolean(overrideReason),
        },
        createdAt,
      });
      return {
        acquired: true,
        decision,
        lease: this.requireLeaseById(leaseId),
        conflicts,
      } as LeaseClaimResult;
    });
  }

  renewLease(input: RenewLeaseInput): Lease {
    const auth = this.authenticateMemberToken(input.memberToken);
    const sessionId = this.activeOwnedSessionId(input.sessionId, auth);
    const ttlMs = normalizeTtl(input.ttlMs);
    const updatedAt = this.timestamp();
    const expiresAt = new Date(this.now().getTime() + ttlMs).toISOString();
    return this.database.transaction(() => {
      this.expireLeases(auth.room.id, false);
      const lease = this.requireOwnedLease(input.leaseId, auth);
      this.requireLeaseSession(lease, sessionId);
      if (lease.status !== "active") {
        throw new AgentHubError("lease_not_active", "Only an active lease can be renewed.", 409);
      }
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
        metadata: { expiresAt },
        createdAt: updatedAt,
      });
      return this.requireLeaseById(lease.id);
    });
  }

  releaseLease(input: ReleaseLeaseInput): Lease {
    return this.closeLease(input).lease;
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
        [candidate],
      );
      for (const conflict of conflicts) {
        const issue = {
          code: "lease_conflict" as const,
          path: candidate.path,
          message: conflict.reason,
          conflict,
        };
        if (conflict.severity === "blocking") blockers.push(issue);
        else warnings.push(issue);
      }
    }
    return {
      allowed: blockers.length === 0,
      blockers,
      warnings,
      coveredPaths,
      uncoveredPaths,
    };
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
      metadata: objectValue(input.metadata, "Session metadata"),
      openedAt: this.timestamp(),
      lastSeenAt: this.timestamp(),
      closedAt: null,
    };
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO work_sessions (
            id, room_id, member_id, client_name, agent_name, repository, branch, worktree,
            base_commit, task, status, metadata_json, opened_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
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
        );
      this.auditRecord(auth, "session.opened", "session", session.id, "Opened a local Agent session.", {
        clientName: session.clientName,
        agentName: session.agentName,
        branch: session.branch,
        baseCommit: session.baseCommit,
      });
    });
    return session;
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
      const leases = this.database.connection.prepare("SELECT id, title FROM leases WHERE session_id = ? AND status = 'active'").all(session.id) as Row[];
      for (const lease of leases) {
        this.database.connection.prepare("UPDATE leases SET status = 'cancelled', completed_at = ?, updated_at = ?, completion_summary = ? WHERE id = ?").run(now, now, reason, asString(lease.id));
      }
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
    return scan;
  }

  closeSession(input: CloseSessionInput): WorkSession {
    const auth = this.authenticateMemberToken(input.memberToken);
    const session = this.requireOwnedSession(input.sessionId, auth);
    const closedAt = this.timestamp();
    const summary = optionalString(input.summary, "Session summary", 4000);
    this.database.transaction(() => {
      this.expireLeases(auth.room.id, false);
      const activeLeases = this.database.connection
        .prepare(`
          SELECT id, title
          FROM leases
          WHERE session_id = ? AND status = 'active'
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

  private findLeaseConflicts(
    roomId: string,
    requesterMemberId: string,
    requesterSessionId: string | null,
    requestedPaths: ReturnType<typeof normalizePathList>,
  ): LeaseConflict[] {
    const rows = this.database.connection
      .prepare(`
        SELECT
          l.id AS lease_id, l.member_id, l.expires_at,
          m.name AS member_name, lp.path AS existing_path,
          lp.risk AS existing_risk, lp.risk_reason
        FROM leases l
        JOIN members m ON m.id = l.member_id
        JOIN lease_paths lp ON lp.lease_id = l.id
        WHERE l.room_id = ? AND l.status = 'active' AND l.expires_at > ?
          AND l.mode = 'write'
          AND NOT (l.member_id = ? AND l.session_id IS ?)
      `)
      .all(
        roomId,
        this.timestamp(),
        requesterMemberId,
        requesterSessionId,
      ) as Row[];
    const conflicts: LeaseConflict[] = [];
    const seen = new Set<string>();
    for (const requestedPath of requestedPaths) {
      for (const row of rows) {
        const existingPath = asString(row.existing_path);
        if (!pathsOverlap(requestedPath.path, existingPath)) continue;
        const key = `${asString(row.lease_id)}\0${pathComparisonKey(requestedPath.path)}\0${pathComparisonKey(existingPath)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const blocking = requestedPath.risk === "high" || asString(row.existing_risk) === "high";
        conflicts.push({
          id: randomUUID(),
          leaseId: asString(row.lease_id),
          memberId: asString(row.member_id),
          memberName: asString(row.member_name),
          requestedPath: requestedPath.path,
          existingPath,
          severity: blocking ? "blocking" : "warning",
          decision: blocking ? "deny" : "warn",
          reason: blocking
            ? "The overlap includes a Unity, configuration, or Luban scope that requires exclusive access."
            : "Ordinary source write scopes overlap; provide an explicit override reason to continue.",
          expiresAt: asString(row.expires_at),
        });
      }
    }
    return conflicts;
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
          created_at AS member_created_at, last_seen_at, is_admin, removed_at
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
        SELECT c.*, m.id AS existing_member_id, m.name AS member_name, l.expires_at
        FROM conflicts c
        JOIN leases l ON l.id = c.existing_lease_id
        JOIN members m ON m.id = l.member_id
        WHERE c.room_id = ?
          AND l.status = 'active' AND l.expires_at > ?
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
          created_at AS member_created_at, last_seen_at, is_admin, removed_at
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

function normalizeTtl(ttlMs?: number): number {
  if (ttlMs === undefined) return DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    throw new AgentHubError(
      "invalid_ttl",
      `Lease TTL must be between ${MIN_TTL_MS} and ${MAX_TTL_MS} milliseconds.`,
    );
  }
  return Math.round(ttlMs);
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
