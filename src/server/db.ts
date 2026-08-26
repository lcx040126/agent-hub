import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
        closed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_room_idx ON work_sessions(room_id, status);

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
    `);
    const leaseColumns = this.connection
      .prepare("PRAGMA table_info(leases)")
      .all() as Array<{ name: string }>;
    if (!leaseColumns.some((column) => column.name === "session_id")) {
      this.connection.exec(
        "ALTER TABLE leases ADD COLUMN session_id TEXT REFERENCES work_sessions(id) ON DELETE SET NULL",
      );
    }
    this.connection.exec("CREATE INDEX IF NOT EXISTS leases_session_idx ON leases(session_id)");

    const roomColumns = this.connection.prepare("PRAGMA table_info(rooms)").all() as Array<{ name: string }>;
    if (!roomColumns.some((column) => column.name === "status")) this.connection.exec("ALTER TABLE rooms ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    if (!roomColumns.some((column) => column.name === "auto_lock_after_auto_claim")) this.connection.exec("ALTER TABLE rooms ADD COLUMN auto_lock_after_auto_claim INTEGER NOT NULL DEFAULT 1");
    if (!roomColumns.some((column) => column.name === "settings_updated_at")) this.connection.exec("ALTER TABLE rooms ADD COLUMN settings_updated_at TEXT");
    if (!roomColumns.some((column) => column.name === "settings_updated_by")) this.connection.exec("ALTER TABLE rooms ADD COLUMN settings_updated_by TEXT");
    if (!roomColumns.some((column) => column.name === "dissolved_at")) this.connection.exec("ALTER TABLE rooms ADD COLUMN dissolved_at TEXT");

    const memberColumns = this.connection.prepare("PRAGMA table_info(members)").all() as Array<{ name: string }>;
    if (!memberColumns.some((column) => column.name === "is_admin")) this.connection.exec("ALTER TABLE members ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
    if (!memberColumns.some((column) => column.name === "removed_at")) this.connection.exec("ALTER TABLE members ADD COLUMN removed_at TEXT");

    const sessionColumns = this.connection.prepare("PRAGMA table_info(work_sessions)").all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "branch_epoch")) this.connection.exec("ALTER TABLE work_sessions ADD COLUMN branch_epoch INTEGER NOT NULL DEFAULT 1");
    if (!sessionColumns.some((column) => column.name === "frozen_reason")) this.connection.exec("ALTER TABLE work_sessions ADD COLUMN frozen_reason TEXT");
  }
}

function resolveDatabasePath(options: AgentHubDatabaseOptions): string {
  if (options.path === ":memory:") return ":memory:";
  if (options.path) return resolve(options.path);
  const dataDir = options.dataDir ?? process.env.AGENT_HUB_DATA_DIR ?? join(process.cwd(), "data");
  return resolve(dataDir, "agent-hub.sqlite");
}
