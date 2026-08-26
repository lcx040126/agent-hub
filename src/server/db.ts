import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDefaultRiskPolicy } from "./risk-policy.js";

const DEFAULT_RISK_RULES_JSON = JSON.stringify(createDefaultRiskPolicy().rules);
const DEFAULT_RISK_RULES_SQL = DEFAULT_RISK_RULES_JSON.replaceAll("'", "''");
const DATABASE_SCHEMA_VERSION = 3;

export interface AgentHubDatabaseOptions {
  path?: string;
  dataDir?: string;
}

export class AgentHubDatabase {
  readonly connection: DatabaseSync;

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
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
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
      );
      CREATE INDEX IF NOT EXISTS sessions_room_idx ON work_sessions(room_id, status);

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
        scanned_at TEXT NOT NULL
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

function resolveDatabasePath(options: AgentHubDatabaseOptions): string {
  if (options.path === ":memory:") return ":memory:";
  if (options.path) return resolve(options.path);
  const dataDir = options.dataDir ?? process.env.AGENT_HUB_DATA_DIR ?? join(process.cwd(), "data");
  return resolve(dataDir, "agent-hub.sqlite");
}
