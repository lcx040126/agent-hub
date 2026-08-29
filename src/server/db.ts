import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDefaultRiskPolicy } from "./risk-policy.js";

const DEFAULT_RISK_RULES_JSON = JSON.stringify(createDefaultRiskPolicy().rules);
const DEFAULT_RISK_RULES_SQL = DEFAULT_RISK_RULES_JSON.replaceAll("'", "''");
const DATABASE_SCHEMA_VERSION = 6;

export interface AgentHubDatabaseOptions {
  path?: string;
  dataDir?: string;
}

export class AgentHubDatabase {
  readonly connection: DatabaseSync;
  private transactionDepth = 0;
  private savepointSequence = 0;

  constructor(options: AgentHubDatabaseOptions = {}) {
    const path = resolveDatabasePath(options);
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }

    this.connection = new DatabaseSync(path);
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") {
      this.connection.exec("PRAGMA journal_mode = WAL");
      this.connection.exec("PRAGMA synchronous = NORMAL");
    }
    this.migrate();
  }

  close(): void {
    this.connection.close();
  }

  transaction<T>(operation: () => T): T {
    const root = this.transactionDepth === 0;
    const savepoint = root ? null : `agent_hub_nested_${++this.savepointSequence}`;
    this.connection.exec(root ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.connection.exec(root ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      if (root) {
        this.connection.exec("ROLLBACK");
      } else {
        this.connection.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.connection.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private migrate(): void {
    const versionRow = this.connection.prepare("PRAGMA user_version").get() as {
      user_version?: number;
    };
    const existingVersion = Number(versionRow.user_version ?? 0);
    if (existingVersion > DATABASE_SCHEMA_VERSION) {
      this.connection.close();
      throw new Error(
        `Database schema ${existingVersion} is newer than supported schema ${DATABASE_SCHEMA_VERSION}.`,
      );
    }
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      this.connection.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        project_name TEXT NOT NULL,
        repository TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dissolved')),
        auto_lock_after_auto_claim INTEGER NOT NULL DEFAULT 1,
        blocking_protection_enabled INTEGER NOT NULL DEFAULT 1,
        automatic_lease_ttl_minutes INTEGER NOT NULL DEFAULT 10,
        maximum_exclusive_lease_minutes INTEGER NOT NULL DEFAULT 1440,
        risk_policy_version INTEGER NOT NULL DEFAULT 1,
        risk_policy_rules_json TEXT NOT NULL DEFAULT '${DEFAULT_RISK_RULES_SQL}',
        settings_updated_at TEXT,
        settings_updated_by TEXT,
        dissolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('host', 'member')),
        client_name TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
        ,is_admin INTEGER NOT NULL DEFAULT 0
        ,removed_at TEXT
        ,client_version TEXT
        ,protocol_version INTEGER
        ,schema_version INTEGER
      );
      CREATE INDEX IF NOT EXISTS members_room_idx ON members(room_id);

      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES work_sessions(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        intent TEXT NOT NULL,
        branch TEXT,
        base_commit TEXT,
        mode TEXT NOT NULL CHECK (mode IN ('read', 'write')),
        kind TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('automatic', 'standard', 'exclusive')),
        managed_by TEXT NOT NULL DEFAULT 'manual' CHECK (managed_by IN ('manual', 'agent')),
        created_via TEXT NOT NULL DEFAULT 'legacy' CHECK (created_via IN ('ui', 'mcp', 'hook', 'legacy')),
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled', 'expired')),
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'warn', 'deny')),
        override_reason TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        completion_summary TEXT,
        outcome TEXT,
        changed_paths_json TEXT NOT NULL DEFAULT '[]',
        commit_hash TEXT,
        validations_json TEXT NOT NULL DEFAULT '[]',
        remaining_risks_json TEXT NOT NULL DEFAULT '[]',
        handoff TEXT
        ,automatic_phase TEXT NOT NULL DEFAULT 'working' CHECK (automatic_phase IN ('working', 'awaiting_commit'))
        ,coordination_state TEXT NOT NULL DEFAULT 'working' CHECK (coordination_state IN ('working', 'waiting', 'blocked', 'awaiting_commit'))
      );
      CREATE INDEX IF NOT EXISTS leases_room_status_idx
        ON leases(room_id, status, expires_at);
      CREATE INDEX IF NOT EXISTS leases_member_idx ON leases(member_id);

      CREATE TABLE IF NOT EXISTS lease_paths (
        lease_id TEXT NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        path_key TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('normal', 'high')),
        risk_reason TEXT,
        PRIMARY KEY (lease_id, path_key)
      );
      CREATE INDEX IF NOT EXISTS lease_paths_key_idx ON lease_paths(path_key);

      CREATE TABLE IF NOT EXISTS conflicts (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        requester_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        requested_lease_id TEXT REFERENCES leases(id) ON DELETE SET NULL,
        existing_lease_id TEXT NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
        requested_path TEXT NOT NULL,
        existing_path TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('warning', 'blocking')),
        decision TEXT NOT NULL CHECK (decision IN ('warn', 'deny')),
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conflicts_room_idx ON conflicts(room_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS risk_policy_versions (
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        rules_json TEXT NOT NULL,
        author_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (room_id, version)
      );

      CREATE TABLE IF NOT EXISTS context_entries (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        author_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        paths_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS context_room_idx ON context_entries(room_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        author_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded')),
        supersedes_decision_id TEXT REFERENCES decisions(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        decision TEXT NOT NULL,
        rationale TEXT,
        paths_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS verifications (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        author_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        lease_id TEXT REFERENCES leases(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        result TEXT NOT NULL,
        summary TEXT NOT NULL,
        command TEXT,
        evidence TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS handoffs (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        from_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        to_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        lease_id TEXT REFERENCES leases(id) ON DELETE SET NULL,
        summary TEXT NOT NULL,
        completed_json TEXT NOT NULL,
        remaining_json TEXT NOT NULL,
        risks_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('decision', 'validation', 'handoff', 'risk')),
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        paths_json TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        commit_hash TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS records_room_idx ON records(room_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        actor_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        actor_name TEXT,
        type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        summary TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activities_room_idx ON activities(room_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS work_sessions (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        client_name TEXT,
        agent_name TEXT,
        repository TEXT,
        branch TEXT,
        worktree TEXT,
        base_commit TEXT,
        task TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'frozen', 'closed')),
        branch_epoch INTEGER NOT NULL DEFAULT 1,
        frozen_reason TEXT,
        metadata_json TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        closed_at TEXT,
        client_version TEXT,
        protocol_version INTEGER,
        schema_version INTEGER
        ,finalization_id TEXT
        ,finalizing_at TEXT
        ,finalization_error TEXT
        ,codex_session_id TEXT
        ,current_turn_id TEXT
        ,activity_epoch INTEGER NOT NULL DEFAULT 0
        ,turn_stopped_at TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_room_idx ON work_sessions(room_id, status);

      CREATE TABLE IF NOT EXISTS session_operations (
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL,
        operation_type TEXT NOT NULL CHECK (operation_type IN ('stop', 'resume', 'completion')),
        turn_id TEXT NOT NULL,
        activity_epoch INTEGER NOT NULL,
        payload_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, operation_id, operation_type)
      );
      CREATE INDEX IF NOT EXISTS session_operations_session_idx
        ON session_operations(session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS release_requests (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        requester_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        requester_session_id TEXT REFERENCES work_sessions(id) ON DELETE SET NULL,
        requester_lease_id TEXT REFERENCES leases(id) ON DELETE SET NULL,
        conflicting_lease_id TEXT NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
        request_title TEXT NOT NULL,
        request_objective TEXT,
        requested_kind TEXT NOT NULL CHECK (requested_kind IN ('automatic', 'standard', 'exclusive')),
        requested_mode TEXT NOT NULL CHECK (requested_mode IN ('read', 'write')),
        requested_branch TEXT,
        requested_base_commit TEXT,
        requested_ttl_minutes INTEGER,
        requested_paths_json TEXT NOT NULL,
        overlap_paths_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        transfer_key TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
        rejection_reason TEXT,
        transferred_lease_id TEXT REFERENCES leases(id) ON DELETE SET NULL,
        decision_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        requested_at TEXT NOT NULL,
        last_requested_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS release_requests_room_status_idx
        ON release_requests(room_id, status, last_requested_at DESC);
      CREATE INDEX IF NOT EXISTS release_requests_holder_idx
        ON release_requests(conflicting_lease_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS release_requests_pending_dedupe_idx
        ON release_requests(dedupe_key) WHERE status = 'pending';

      CREATE TABLE IF NOT EXISTS local_scans (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        repository TEXT,
        branch TEXT,
        worktree TEXT,
        base_commit TEXT,
        changed_paths_json TEXT NOT NULL,
        rule_files_json TEXT NOT NULL,
        systems_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        scanned_at TEXT NOT NULL,
        finalization_id TEXT
      );
      CREATE INDEX IF NOT EXISTS scans_session_idx ON local_scans(session_id, scanned_at DESC);

      CREATE TABLE IF NOT EXISTS feature_memories (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        feature_key TEXT NOT NULL,
        feature_key_normalized TEXT NOT NULL,
        name TEXT NOT NULL,
        system_id TEXT NOT NULL,
        current_revision_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (room_id, feature_key_normalized)
      );
      CREATE INDEX IF NOT EXISTS feature_memories_room_current_idx
        ON feature_memories(room_id, current_revision_id);

      CREATE TABLE IF NOT EXISTS feature_revisions (
        id TEXT PRIMARY KEY,
        feature_id TEXT NOT NULL REFERENCES feature_memories(id) ON DELETE CASCADE,
        revision_number INTEGER NOT NULL,
        parent_revision_id TEXT REFERENCES feature_revisions(id) ON DELETE RESTRICT,
        relation TEXT NOT NULL CHECK (relation IN ('add', 'extend', 'replace', 'deprecate', 'rollback', 'conflict')),
        source_session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE RESTRICT,
        author_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
        branch TEXT,
        base_commit TEXT,
        final_commit TEXT,
        completed INTEGER NOT NULL,
        objective TEXT NOT NULL,
        change_summary TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        contract_changes_json TEXT NOT NULL,
        verifications_json TEXT NOT NULL,
        remaining_risks_json TEXT NOT NULL,
        git_evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (feature_id, revision_number)
      );
      CREATE INDEX IF NOT EXISTS feature_revisions_feature_idx
        ON feature_revisions(feature_id, revision_number DESC);
      CREATE INDEX IF NOT EXISTS feature_revisions_commit_idx
        ON feature_revisions(final_commit);

      CREATE TABLE IF NOT EXISTS feature_revision_targets (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES feature_revisions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('system', 'path', 'symbol', 'interface', 'resource', 'test')),
        role TEXT NOT NULL CHECK (role IN ('implementation', 'contract', 'dependency', 'verification')),
        path TEXT,
        path_key TEXT,
        symbol TEXT,
        symbol_key TEXT,
        signature TEXT,
        label TEXT
      );
      CREATE INDEX IF NOT EXISTS feature_targets_revision_idx
        ON feature_revision_targets(revision_id);
      CREATE INDEX IF NOT EXISTS feature_targets_path_idx
        ON feature_revision_targets(path_key, kind);
      CREATE INDEX IF NOT EXISTS feature_targets_symbol_idx
        ON feature_revision_targets(symbol_key, kind);

      CREATE TABLE IF NOT EXISTS feature_revision_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        revision_id TEXT NOT NULL REFERENCES feature_revisions(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('draft', 'candidate', 'current', 'conflict', 'superseded', 'deprecated')),
        actor_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS feature_revision_events_revision_idx
        ON feature_revision_events(revision_id, sequence DESC);

      CREATE TABLE IF NOT EXISTS feature_change_confirmations (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        proposal_hash TEXT NOT NULL,
        impacts_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
        reason TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        expires_at TEXT NOT NULL,
        UNIQUE (session_id, proposal_hash)
      );
      CREATE INDEX IF NOT EXISTS feature_confirmations_session_idx
        ON feature_change_confirmations(session_id, status, expires_at);
    `);
    const decisionColumns = this.connection
      .prepare("PRAGMA table_info(decisions)")
      .all() as Array<{ name: string }>;
    if (!decisionColumns.some((column) => column.name === "status")) {
      this.connection.exec(
        "ALTER TABLE decisions ADD COLUMN status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded'))",
      );
    }
    if (!decisionColumns.some((column) => column.name === "supersedes_decision_id")) {
      this.connection.exec(
        "ALTER TABLE decisions ADD COLUMN supersedes_decision_id TEXT REFERENCES decisions(id) ON DELETE SET NULL",
      );
    }
    // v0.2.6 的上下文导入会分别生成决定和 records 投影的 ID。只有字段完全一致且
    // 一一对应时才修复投影 ID，避免把独立手工记录误归到某条决定上。
    repairLegacyImportedDecisionRecordIds(this.connection);
    this.connection.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS decisions_single_successor_idx
      ON decisions(supersedes_decision_id)
      WHERE supersedes_decision_id IS NOT NULL;
    `);
    const operationColumns = this.connection
      .prepare("PRAGMA table_info(session_operations)")
      .all() as Array<{ name: string; pk: number }>;
    const operationPrimaryKey = operationColumns
      .filter((column) => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map((column) => column.name);
    if (operationPrimaryKey.join(",") !== "session_id,operation_id,operation_type") {
      this.connection.exec(`
        DROP TABLE IF EXISTS session_operations_schema4_legacy;
        ALTER TABLE session_operations RENAME TO session_operations_schema4_legacy;
        CREATE TABLE session_operations (
          session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
          operation_id TEXT NOT NULL,
          operation_type TEXT NOT NULL CHECK (operation_type IN ('stop', 'resume', 'completion')),
          turn_id TEXT NOT NULL,
          activity_epoch INTEGER NOT NULL,
          payload_hash TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (session_id, operation_id, operation_type)
        );
        INSERT OR IGNORE INTO session_operations (
          session_id, operation_id, operation_type, turn_id, activity_epoch,
          payload_hash, result_json, created_at
        )
        SELECT session_id, operation_id, operation_type, turn_id, activity_epoch,
          payload_hash, result_json, created_at
        FROM session_operations_schema4_legacy;
        DROP TABLE session_operations_schema4_legacy;
        CREATE INDEX IF NOT EXISTS session_operations_session_idx
          ON session_operations(session_id, created_at DESC);
      `);
    }
    const leaseColumns = this.connection
      .prepare("PRAGMA table_info(leases)")
      .all() as Array<{ name: string }>;
    if (!leaseColumns.some((column) => column.name === "session_id")) {
      this.connection.exec(
        "ALTER TABLE leases ADD COLUMN session_id TEXT REFERENCES work_sessions(id) ON DELETE SET NULL",
      );
    }
    if (!leaseColumns.some((column) => column.name === "kind")) {
      this.connection.exec(
        "ALTER TABLE leases ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('automatic', 'standard', 'exclusive'))",
      );
    }
    if (!leaseColumns.some((column) => column.name === "automatic_phase")) {
      this.connection.exec(
        "ALTER TABLE leases ADD COLUMN automatic_phase TEXT NOT NULL DEFAULT 'working' CHECK (automatic_phase IN ('working', 'awaiting_commit'))",
      );
    }
    if (!leaseColumns.some((column) => column.name === "coordination_state")) {
      this.connection.exec(
        "ALTER TABLE leases ADD COLUMN coordination_state TEXT NOT NULL DEFAULT 'working' CHECK (coordination_state IN ('working', 'waiting', 'blocked', 'awaiting_commit'))",
      );
    }
    if (!leaseColumns.some((column) => column.name === "managed_by")) {
      this.connection.exec(
        "ALTER TABLE leases ADD COLUMN managed_by TEXT NOT NULL DEFAULT 'manual' CHECK (managed_by IN ('manual', 'agent'))",
      );
    }
    if (!leaseColumns.some((column) => column.name === "created_via")) {
      this.connection.exec(
        "ALTER TABLE leases ADD COLUMN created_via TEXT NOT NULL DEFAULT 'legacy' CHECK (created_via IN ('ui', 'mcp', 'hook', 'legacy'))",
      );
    }
    // schema 5 中断或手工补列后也要可重试：旧 automatic_phase 仍是迁移时的权威来源。
    this.connection.exec(`
      UPDATE leases
      SET coordination_state = automatic_phase
      WHERE kind = 'automatic'
        AND automatic_phase = 'awaiting_commit'
        AND coordination_state = 'working'
    `);
    // 旧 automatic 的生命周期含义明确；普通/独占范围则必须保守地保留为人工管理。
    this.connection.exec(`
      UPDATE leases SET managed_by = 'agent' WHERE kind = 'automatic';
      UPDATE leases SET managed_by = 'manual' WHERE kind IN ('standard', 'exclusive');
    `);

    // v0.2.6 的 MCP 入口曾把 Agent 领取保存为 standard。
    // 只有明确的 MCP session 和对应领取审计同时成立时才迁移；Hook 的通用审计不足以证明调用来源。
    const legacyStandardRows = this.connection.prepare(`
      SELECT l.id, s.metadata_json, a.metadata_json AS activity_metadata_json
      FROM leases l
      JOIN work_sessions s ON s.id = l.session_id
      JOIN activities a ON a.room_id = l.room_id
        AND a.actor_member_id = l.member_id
        AND a.entity_type = 'lease'
        AND a.entity_id = l.id
        AND a.type = 'lease.acquired'
      WHERE l.kind = 'standard'
        AND l.managed_by = 'manual'
        AND l.created_via = 'legacy'
      ORDER BY l.id, a.created_at, a.id
    `).all() as Array<{
      id: string;
      metadata_json: string;
      activity_metadata_json: string;
    }>;
    const promoteLegacyMcpLease = this.connection.prepare(`
      UPDATE leases
      SET kind = 'automatic', managed_by = 'agent', created_via = 'mcp'
      WHERE id = ? AND kind = 'standard' AND managed_by = 'manual' AND created_via = 'legacy'
    `);
    const promotedLegacyLeaseIds = new Set<string>();
    for (const row of legacyStandardRows) {
      if (promotedLegacyLeaseIds.has(row.id)) continue;
      const sessionMetadata = parseJsonObject(row.metadata_json);
      const activityMetadata = parseJsonObject(row.activity_metadata_json);
      if (sessionMetadata?.source !== "mcp" || activityMetadata?.kind !== "standard") continue;
      promoteLegacyMcpLease.run(row.id);
      promotedLegacyLeaseIds.add(row.id);
    }

    type ActiveAgentLeaseRow = {
      id: string;
      room_id: string;
      member_id: string;
      session_id: string;
      mode: "read" | "write";
      decision: "allow" | "warn" | "deny";
      expires_at: string;
      created_at: string;
      updated_at: string;
      automatic_phase: "working" | "awaiting_commit";
      coordination_state: "working" | "waiting" | "blocked" | "awaiting_commit";
      completion_summary: string | null;
    };
    const activeAgentLeases = this.connection.prepare(`
      SELECT id, room_id, member_id, session_id, mode, decision, expires_at,
        created_at, updated_at, automatic_phase, coordination_state, completion_summary
      FROM leases
      WHERE status = 'active' AND managed_by = 'agent' AND session_id IS NOT NULL
      ORDER BY room_id, member_id, session_id, created_at, id
    `).all() as ActiveAgentLeaseRow[];
    const canonicalAgentLeases = new Map<string, ActiveAgentLeaseRow>();
    const mergeLeasePaths = this.connection.prepare(`
      INSERT INTO lease_paths (lease_id, path, path_key, risk, risk_reason)
      SELECT ?, path, path_key, risk, risk_reason
      FROM lease_paths
      WHERE lease_id = ?
      ON CONFLICT (lease_id, path_key) DO UPDATE SET
        risk = CASE WHEN excluded.risk = 'high' THEN 'high' ELSE lease_paths.risk END,
        risk_reason = CASE
          WHEN excluded.risk = 'high' AND excluded.risk_reason IS NOT NULL THEN excluded.risk_reason
          ELSE lease_paths.risk_reason
        END
    `);
    const updateCanonicalAgentLease = this.connection.prepare(`
      UPDATE leases SET
        mode = ?, decision = ?, expires_at = ?, updated_at = ?,
        automatic_phase = ?, coordination_state = ?,
        completion_summary = COALESCE(completion_summary, ?)
      WHERE id = ?
    `);
    const cancelMergedAgentLease = this.connection.prepare(`
      UPDATE leases SET
        status = 'cancelled', completed_at = COALESCE(completed_at, updated_at),
        outcome = COALESCE(outcome, 'merged'),
        completion_summary = CASE
          WHEN completion_summary IS NULL OR completion_summary = '' THEN ?
          ELSE completion_summary || char(10) || ?
        END
      WHERE id = ?
    `);
    const cancelMergedLeaseReleaseRequests = this.connection.prepare(`
      UPDATE release_requests
      SET status = 'cancelled', resolved_at = COALESCE(resolved_at, ?)
      WHERE status = 'pending' AND (requester_lease_id = ? OR conflicting_lease_id = ?)
    `);
    for (const duplicate of activeAgentLeases) {
      const key = `${duplicate.room_id}\u0000${duplicate.member_id}\u0000${duplicate.session_id}`;
      const canonical = canonicalAgentLeases.get(key);
      if (!canonical) {
        canonicalAgentLeases.set(key, duplicate);
        continue;
      }

      mergeLeasePaths.run(canonical.id, duplicate.id);
      canonical.mode = canonical.mode === "write" || duplicate.mode === "write" ? "write" : "read";
      canonical.decision = stricterLeaseDecision(canonical.decision, duplicate.decision);
      canonical.expires_at = laterIsoTimestamp(canonical.expires_at, duplicate.expires_at);
      canonical.updated_at = laterIsoTimestamp(canonical.updated_at, duplicate.updated_at);
      canonical.automatic_phase = canonical.automatic_phase === "awaiting_commit"
        || duplicate.automatic_phase === "awaiting_commit"
        ? "awaiting_commit"
        : "working";
      canonical.coordination_state = stricterCoordinationState(
        canonical.coordination_state,
        duplicate.coordination_state,
      );
      if (canonical.coordination_state === "blocked" || canonical.coordination_state === "awaiting_commit") {
        canonical.automatic_phase = "awaiting_commit";
      }
      canonical.completion_summary ??= duplicate.completion_summary;
      updateCanonicalAgentLease.run(
        canonical.mode,
        canonical.decision,
        canonical.expires_at,
        canonical.updated_at,
        canonical.automatic_phase,
        canonical.coordination_state,
        canonical.completion_summary,
        canonical.id,
      );
      const mergeSummary = `Merged into Agent lease ${canonical.id} during schema 6 migration.`;
      cancelMergedAgentLease.run(mergeSummary, mergeSummary, duplicate.id);
      cancelMergedLeaseReleaseRequests.run(duplicate.updated_at, duplicate.id, duplicate.id);
    }

    // SQLite 无法在旧表上补充跨列 CHECK；触发器让升级库和新库保持同一管理类型约束。
    this.connection.exec(`
      CREATE TRIGGER IF NOT EXISTS leases_management_kind_insert
      BEFORE INSERT ON leases
      WHEN NOT (
        (NEW.managed_by = 'agent' AND NEW.kind = 'automatic')
        OR (NEW.managed_by = 'manual' AND NEW.kind IN ('standard', 'exclusive'))
      )
      BEGIN
        SELECT RAISE(ABORT, 'lease management must match lease kind');
      END;
      CREATE TRIGGER IF NOT EXISTS leases_management_kind_update
      BEFORE UPDATE OF managed_by, kind ON leases
      WHEN NOT (
        (NEW.managed_by = 'agent' AND NEW.kind = 'automatic')
        OR (NEW.managed_by = 'manual' AND NEW.kind IN ('standard', 'exclusive'))
      )
      BEGIN
        SELECT RAISE(ABORT, 'lease management must match lease kind');
      END;
      CREATE UNIQUE INDEX IF NOT EXISTS leases_active_agent_session_idx
      ON leases(room_id, member_id, session_id)
      WHERE status = 'active' AND managed_by = 'agent' AND session_id IS NOT NULL;
    `);
    this.connection.exec("CREATE INDEX IF NOT EXISTS leases_session_idx ON leases(session_id)");

    const roomColumns = this.connection.prepare("PRAGMA table_info(rooms)").all() as Array<{ name: string }>;
    if (!roomColumns.some((column) => column.name === "status")) this.connection.exec("ALTER TABLE rooms ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    if (!roomColumns.some((column) => column.name === "auto_lock_after_auto_claim")) this.connection.exec("ALTER TABLE rooms ADD COLUMN auto_lock_after_auto_claim INTEGER NOT NULL DEFAULT 1");
    if (!roomColumns.some((column) => column.name === "blocking_protection_enabled")) this.connection.exec("ALTER TABLE rooms ADD COLUMN blocking_protection_enabled INTEGER NOT NULL DEFAULT 1");
    if (!roomColumns.some((column) => column.name === "automatic_lease_ttl_minutes")) this.connection.exec("ALTER TABLE rooms ADD COLUMN automatic_lease_ttl_minutes INTEGER NOT NULL DEFAULT 10");
    if (!roomColumns.some((column) => column.name === "maximum_exclusive_lease_minutes")) this.connection.exec("ALTER TABLE rooms ADD COLUMN maximum_exclusive_lease_minutes INTEGER NOT NULL DEFAULT 1440");
    if (!roomColumns.some((column) => column.name === "risk_policy_version")) this.connection.exec("ALTER TABLE rooms ADD COLUMN risk_policy_version INTEGER NOT NULL DEFAULT 1");
    if (!roomColumns.some((column) => column.name === "risk_policy_rules_json")) this.connection.exec(`ALTER TABLE rooms ADD COLUMN risk_policy_rules_json TEXT NOT NULL DEFAULT '${DEFAULT_RISK_RULES_SQL}'`);
    if (!roomColumns.some((column) => column.name === "settings_updated_at")) this.connection.exec("ALTER TABLE rooms ADD COLUMN settings_updated_at TEXT");
    if (!roomColumns.some((column) => column.name === "settings_updated_by")) this.connection.exec("ALTER TABLE rooms ADD COLUMN settings_updated_by TEXT");
    if (!roomColumns.some((column) => column.name === "dissolved_at")) this.connection.exec("ALTER TABLE rooms ADD COLUMN dissolved_at TEXT");

    const memberColumns = this.connection.prepare("PRAGMA table_info(members)").all() as Array<{ name: string }>;
    if (!memberColumns.some((column) => column.name === "is_admin")) this.connection.exec("ALTER TABLE members ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
    if (!memberColumns.some((column) => column.name === "removed_at")) this.connection.exec("ALTER TABLE members ADD COLUMN removed_at TEXT");
    if (!memberColumns.some((column) => column.name === "client_version")) this.connection.exec("ALTER TABLE members ADD COLUMN client_version TEXT");
    if (!memberColumns.some((column) => column.name === "protocol_version")) this.connection.exec("ALTER TABLE members ADD COLUMN protocol_version INTEGER");
    if (!memberColumns.some((column) => column.name === "schema_version")) this.connection.exec("ALTER TABLE members ADD COLUMN schema_version INTEGER");

    const sessionColumns = this.connection.prepare("PRAGMA table_info(work_sessions)").all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "branch_epoch")) this.connection.exec("ALTER TABLE work_sessions ADD COLUMN branch_epoch INTEGER NOT NULL DEFAULT 1");
    if (!sessionColumns.some((column) => column.name === "frozen_reason")) this.connection.exec("ALTER TABLE work_sessions ADD COLUMN frozen_reason TEXT");
    if (!sessionColumns.some((column) => column.name === "client_version")) this.connection.exec("ALTER TABLE work_sessions ADD COLUMN client_version TEXT");
    if (!sessionColumns.some((column) => column.name === "protocol_version")) this.connection.exec("ALTER TABLE work_sessions ADD COLUMN protocol_version INTEGER");
    if (!sessionColumns.some((column) => column.name === "schema_version")) this.connection.exec("ALTER TABLE work_sessions ADD COLUMN schema_version INTEGER");
    if (!sessionColumns.some((column) => column.name === "finalization_id")) this.connection.exec("ALTER TABLE work_sessions ADD COLUMN finalization_id TEXT");
    if (!sessionColumns.some((column) => column.name === "finalizing_at")) this.connection.exec("ALTER TABLE work_sessions ADD COLUMN finalizing_at TEXT");
    if (!sessionColumns.some((column) => column.name === "finalization_error")) this.connection.exec("ALTER TABLE work_sessions ADD COLUMN finalization_error TEXT");
    if (!sessionColumns.some((column) => column.name === "codex_session_id")) this.connection.exec("ALTER TABLE work_sessions ADD COLUMN codex_session_id TEXT");
    if (!sessionColumns.some((column) => column.name === "current_turn_id")) this.connection.exec("ALTER TABLE work_sessions ADD COLUMN current_turn_id TEXT");
    if (!sessionColumns.some((column) => column.name === "activity_epoch")) this.connection.exec("ALTER TABLE work_sessions ADD COLUMN activity_epoch INTEGER NOT NULL DEFAULT 0");
    if (!sessionColumns.some((column) => column.name === "turn_stopped_at")) this.connection.exec("ALTER TABLE work_sessions ADD COLUMN turn_stopped_at TEXT");
    this.connection.exec("DROP INDEX IF EXISTS sessions_codex_identity_idx");
    const sessionIdentityRows = this.connection.prepare(`
      SELECT id, metadata_json FROM work_sessions WHERE codex_session_id IS NULL
    `).all() as Array<{ id: string; metadata_json: string }>;
    const backfillSessionIdentity = this.connection.prepare(`
      UPDATE work_sessions SET codex_session_id = ? WHERE id = ?
    `);
    for (const row of sessionIdentityRows) {
      const codexSessionId = codexSessionIdFromMetadata(row.metadata_json);
      if (codexSessionId) backfillSessionIdentity.run(codexSessionId, row.id);
    }

    const duplicateSessionRows = this.connection.prepare(`
      SELECT id, room_id, member_id, codex_session_id, status, finalizing_at,
        last_seen_at, opened_at
      FROM work_sessions
      WHERE codex_session_id IS NOT NULL AND closed_at IS NULL AND finalizing_at IS NULL
      ORDER BY room_id, member_id, codex_session_id,
        last_seen_at DESC, opened_at DESC, id DESC
    `).all() as Array<{
      id: string;
      room_id: string;
      member_id: string;
      codex_session_id: string;
      status: string;
      finalizing_at: string | null;
      last_seen_at: string;
      opened_at: string;
    }>;
    const canonicalSessions = new Set<string>();
    const closeDuplicateSession = this.connection.prepare(`
      UPDATE work_sessions SET
        status = 'closed', closed_at = COALESCE(closed_at, last_seen_at),
        finalizing_at = NULL,
        finalization_error = COALESCE(finalization_error, 'Superseded duplicate Codex session during database migration.')
      WHERE id = ?
    `);
    const preserveDuplicateWorkingLease = this.connection.prepare(`
      UPDATE leases SET
        automatic_phase = 'awaiting_commit', coordination_state = 'awaiting_commit', updated_at = ?
      WHERE session_id = ? AND status = 'active' AND kind = 'automatic'
        AND (automatic_phase = 'working' OR coordination_state = 'working')
    `);
    for (const row of duplicateSessionRows) {
      const key = `${row.room_id}\u0000${row.member_id}\u0000${row.codex_session_id}`;
      if (!canonicalSessions.has(key)) {
        canonicalSessions.add(key);
        continue;
      }
      closeDuplicateSession.run(row.id);
      // schema 3 没有提交完整性证据；重复会话关闭后停止续租，但保护必须保留到原 TTL。
      preserveDuplicateWorkingLease.run(row.last_seen_at, row.id);
    }
    this.connection.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_codex_identity_idx
      ON work_sessions(room_id, member_id, codex_session_id)
      WHERE codex_session_id IS NOT NULL AND closed_at IS NULL AND finalizing_at IS NULL
    `);

    const scanColumns = this.connection.prepare("PRAGMA table_info(local_scans)").all() as Array<{ name: string }>;
    if (!scanColumns.some((column) => column.name === "finalization_id")) this.connection.exec("ALTER TABLE local_scans ADD COLUMN finalization_id TEXT");
    // schema 3 已存在 local_scans，必须先补兼容字段，再创建依赖它的索引。
    this.connection.exec("CREATE UNIQUE INDEX IF NOT EXISTS scans_finalization_idx ON local_scans(finalization_id) WHERE finalization_id IS NOT NULL");

    const releaseRequestColumns = this.connection.prepare("PRAGMA table_info(release_requests)").all() as Array<{ name: string }>;
    if (!releaseRequestColumns.some((column) => column.name === "transfer_key")) this.connection.exec("ALTER TABLE release_requests ADD COLUMN transfer_key TEXT NOT NULL DEFAULT ''");

    this.connection.prepare(`
      UPDATE rooms
      SET risk_policy_rules_json = ?
      WHERE risk_policy_rules_json IS NULL OR risk_policy_rules_json = '' OR risk_policy_rules_json = '[]'
    `).run(DEFAULT_RISK_RULES_JSON);
    this.connection.exec(`
      INSERT OR IGNORE INTO risk_policy_versions (room_id, version, rules_json, author_member_id, created_at)
      SELECT r.id, r.risk_policy_version, r.risk_policy_rules_json,
        (SELECT m.id FROM members m WHERE m.room_id = r.id AND m.role = 'host' LIMIT 1),
        COALESCE(r.settings_updated_at, r.created_at)
      FROM rooms r
    `);
      this.connection.exec(`PRAGMA user_version = ${DATABASE_SCHEMA_VERSION}`);
      this.connection.exec("COMMIT");
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }
}

interface LegacyDecisionProjection {
  readonly rowId: number;
  readonly id: string;
  readonly roomId: string;
  readonly memberId: string;
  readonly status: "current" | "superseded";
  readonly title: string;
  readonly summary: string;
  readonly pathsJson: string;
  readonly evidenceJson: string;
  readonly createdAt: string;
}

function repairLegacyImportedDecisionRecordIds(connection: DatabaseSync): void {
  const decisions = connection.prepare(`
    SELECT d.rowid AS row_id, d.id, d.room_id, d.author_member_id,
      d.status, d.title, d.decision, d.paths_json, d.rationale, d.created_at
    FROM decisions d
    WHERE NOT EXISTS (SELECT 1 FROM records linked WHERE linked.id = d.id)
    ORDER BY d.rowid
  `).all() as Array<{
    row_id: number;
    id: string;
    room_id: string;
    author_member_id: string;
    status: "current" | "superseded";
    title: string;
    decision: string;
    paths_json: string;
    rationale: string | null;
    created_at: string;
  }>;
  const records = connection.prepare(`
    SELECT r.rowid AS row_id, r.id, r.room_id, r.member_id, r.title, r.summary,
      r.paths_json, r.evidence_json, r.created_at
    FROM records r
    WHERE r.kind = 'decision'
      AND NOT EXISTS (SELECT 1 FROM decisions linked WHERE linked.id = r.id)
    ORDER BY r.rowid
  `).all() as Array<{
    row_id: number;
    id: string;
    room_id: string;
    member_id: string;
    title: string;
    summary: string;
    paths_json: string;
    evidence_json: string;
    created_at: string;
  }>;
  if (decisions.length === 0 || records.length === 0) return;

  const decisionGroups = new Map<string, LegacyDecisionProjection[]>();
  const recordGroups = new Map<string, LegacyDecisionProjection[]>();
  const add = (
    groups: Map<string, LegacyDecisionProjection[]>,
    projection: LegacyDecisionProjection,
  ) => {
    const key = JSON.stringify([
      projection.roomId,
      projection.memberId,
      projection.title,
      projection.summary,
      projection.pathsJson,
      projection.evidenceJson,
      projection.createdAt,
    ]);
    const group = groups.get(key) ?? [];
    group.push(projection);
    groups.set(key, group);
  };
  for (const decision of decisions) {
    add(decisionGroups, {
      rowId: decision.row_id,
      id: decision.id,
      roomId: decision.room_id,
      memberId: decision.author_member_id,
      status: decision.status,
      title: decision.title,
      summary: decision.decision,
      pathsJson: decision.paths_json,
      evidenceJson: JSON.stringify(decision.rationale ? [decision.rationale] : []),
      createdAt: decision.created_at,
    });
  }
  for (const record of records) {
    add(recordGroups, {
      rowId: record.row_id,
      id: record.id,
      roomId: record.room_id,
      memberId: record.member_id,
      status: "current",
      title: record.title,
      summary: record.summary,
      pathsJson: record.paths_json,
      evidenceJson: record.evidence_json,
      createdAt: record.created_at,
    });
  }

  const updateActivity = connection.prepare(`
    UPDATE activities SET entity_id = ?
    WHERE entity_type = 'record' AND entity_id = ?
  `);
  const updateRecord = connection.prepare(`
    UPDATE records SET id = ?, status = ?
    WHERE id = ? AND kind = 'decision'
  `);
  for (const [key, decisionGroup] of decisionGroups) {
    const recordGroup = recordGroups.get(key);
    if (!recordGroup || recordGroup.length !== decisionGroup.length) continue;
    decisionGroup.sort((left, right) => left.rowId - right.rowId);
    recordGroup.sort((left, right) => left.rowId - right.rowId);
    for (let index = 0; index < decisionGroup.length; index += 1) {
      const decision = decisionGroup[index];
      const record = recordGroup[index];
      updateActivity.run(decision.id, record.id);
      updateRecord.run(decision.id, decision.status, record.id);
    }
  }
}

function resolveDatabasePath(options: AgentHubDatabaseOptions): string {
  if (options.path === ":memory:") return ":memory:";
  if (options.path) return resolve(options.path);
  const dataDir = options.dataDir ?? process.env.AGENT_HUB_DATA_DIR ?? join(process.cwd(), "data");
  return resolve(dataDir, "agent-hub.sqlite");
}

function codexSessionIdFromMetadata(value: string): string | null {
  try {
    const metadata: unknown = JSON.parse(value);
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const record = metadata as Record<string, unknown>;
    const candidate = record.codexSessionId ?? record.codex_session_id;
    if (typeof candidate !== "string") return null;
    const normalized = candidate.trim();
    return normalized && normalized.length <= 200 ? normalized : null;
  } catch {
    return null;
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function laterIsoTimestamp(left: string, right: string): string {
  return left >= right ? left : right;
}

function stricterLeaseDecision(
  left: "allow" | "warn" | "deny",
  right: "allow" | "warn" | "deny",
): "allow" | "warn" | "deny" {
  const rank = { allow: 0, warn: 1, deny: 2 } as const;
  return rank[left] >= rank[right] ? left : right;
}

function stricterCoordinationState(
  left: "working" | "waiting" | "blocked" | "awaiting_commit",
  right: "working" | "waiting" | "blocked" | "awaiting_commit",
): "working" | "waiting" | "blocked" | "awaiting_commit" {
  const rank = { working: 0, waiting: 1, awaiting_commit: 2, blocked: 3 } as const;
  return rank[left] >= rank[right] ? left : right;
}
