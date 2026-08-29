import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHubDatabase } from "./db.js";
import { AgentHubService } from "./service.js";

const temporaryDirectories: string[] = [];

type HistoricalSchemaVersion = 2 | 3 | 4 | 5;

function createHistoricalDatabaseFixture(
  databasePath: string,
  schemaVersion: HistoricalSchemaVersion,
  options: { finalizationColumn?: boolean } = {},
): void {
  const legacy = new DatabaseSync(databasePath);
  const roomColumns = schemaVersion === 2 ? "" : `,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dissolved')),
        auto_lock_after_auto_claim INTEGER NOT NULL DEFAULT 1,
        blocking_protection_enabled INTEGER NOT NULL DEFAULT 1,
        automatic_lease_ttl_minutes INTEGER NOT NULL DEFAULT 10,
        maximum_exclusive_lease_minutes INTEGER NOT NULL DEFAULT 1440,
        risk_policy_version INTEGER NOT NULL DEFAULT 1,
        risk_policy_rules_json TEXT NOT NULL DEFAULT '[]',
        settings_updated_at TEXT,
        settings_updated_by TEXT,
        dissolved_at TEXT`;
  const memberColumns = schemaVersion === 2 ? "" : `,
        is_admin INTEGER NOT NULL DEFAULT 0,
        removed_at TEXT,
        client_version TEXT,
        protocol_version INTEGER,
        schema_version INTEGER`;
  const leaseKindColumn = schemaVersion === 2 ? "" : `,
        kind TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('automatic', 'standard', 'exclusive'))`;
  const automaticPhaseColumn = schemaVersion >= 4 ? `,
        automatic_phase TEXT NOT NULL DEFAULT 'working' CHECK (automatic_phase IN ('working', 'awaiting_commit'))` : "";
  const coordinationStateColumn = schemaVersion >= 5 ? `,
        coordination_state TEXT NOT NULL DEFAULT 'working' CHECK (coordination_state IN ('working', 'waiting', 'blocked', 'awaiting_commit'))` : "";
  const sessionColumns = schemaVersion === 2 ? "" : `,
        branch_epoch INTEGER NOT NULL DEFAULT 1,
        frozen_reason TEXT`;
  const sessionCompatibilityColumns = schemaVersion === 2 ? "" : `,
        client_version TEXT,
        protocol_version INTEGER,
        schema_version INTEGER`;
  const sessionLifecycleColumns = schemaVersion >= 4 ? `,
        finalization_id TEXT,
        finalizing_at TEXT,
        finalization_error TEXT,
        codex_session_id TEXT,
        current_turn_id TEXT,
        activity_epoch INTEGER NOT NULL DEFAULT 0,
        turn_stopped_at TEXT` : "";
  const hasScanFinalizationColumn = schemaVersion >= 4 || options.finalizationColumn === true;
  const scanFinalizationColumn = hasScanFinalizationColumn ? ",\n        finalization_id TEXT" : "";
  const fixturePrefix = `schema${schemaVersion}`;

  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      project_name TEXT NOT NULL,
      repository TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      created_at TEXT NOT NULL${roomColumns}
    );
    CREATE TABLE members (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('host', 'member')),
      client_name TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL${memberColumns}
    );
    CREATE TABLE work_sessions (
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
      status TEXT NOT NULL CHECK (status IN ('active', ${schemaVersion === 2 ? "" : "'frozen', "}'closed'))${sessionColumns},
      metadata_json TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      closed_at TEXT${sessionCompatibilityColumns}${sessionLifecycleColumns}
    );
    CREATE TABLE leases (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES work_sessions(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      intent TEXT NOT NULL,
      branch TEXT,
      base_commit TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('read', 'write'))${leaseKindColumn},
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
      handoff TEXT${automaticPhaseColumn}${coordinationStateColumn}
    );
    CREATE TABLE lease_paths (
      lease_id TEXT NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      path_key TEXT NOT NULL,
      risk TEXT NOT NULL CHECK (risk IN ('normal', 'high')),
      risk_reason TEXT,
      PRIMARY KEY (lease_id, path_key)
    );
    CREATE TABLE local_scans (
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
      scanned_at TEXT NOT NULL${scanFinalizationColumn}
    );
    INSERT INTO rooms (
      id, code, name, project_name, repository, default_branch, created_at
    ) VALUES (
      '${fixturePrefix}-room', 'SCHEMA0${schemaVersion}',
      'Historical room', 'Historical project', 'C:/historical/repo', 'main',
      '2026-08-20T08:00:00.000Z'
    );
    INSERT INTO members (
      id, room_id, name, role, client_name, token_hash, created_at, last_seen_at
    ) VALUES (
      '${fixturePrefix}-member', '${fixturePrefix}-room', 'Alice', 'host', 'Codex',
      'historical-token-hash-${schemaVersion}', '2026-08-20T08:00:00.000Z',
      '2026-08-20T09:00:00.000Z'
    );
    INSERT INTO work_sessions (
      id, room_id, member_id, client_name, agent_name, repository, branch,
      worktree, base_commit, task, status, metadata_json, opened_at, last_seen_at
    ) VALUES (
      '${fixturePrefix}-session', '${fixturePrefix}-room', '${fixturePrefix}-member',
      'Codex', 'Codex', 'C:/historical/repo', 'main', 'C:/historical/repo',
      'base-${schemaVersion}', 'Preserve historical session', 'active',
      '{"source":"historical-${schemaVersion}"}', '2026-08-20T08:10:00.000Z',
      '2026-08-20T09:00:00.000Z'
    );
    INSERT INTO leases (
      id, room_id, member_id, session_id, title, intent, branch, base_commit,
      mode, ${schemaVersion === 2 ? "" : "kind, "}status, decision, expires_at,
      created_at, updated_at, changed_paths_json${schemaVersion >= 4 ? ", automatic_phase" : ""}${schemaVersion >= 5 ? ", coordination_state" : ""}
    ) VALUES (
      '${fixturePrefix}-lease', '${fixturePrefix}-room', '${fixturePrefix}-member',
      '${fixturePrefix}-session', 'Historical lease', 'Preserve historical lease',
      'main', 'base-${schemaVersion}', 'write', ${schemaVersion === 2 ? "" : "'automatic', "}
      'active', 'allow', '2099-01-01T00:00:00.000Z',
      '2026-08-20T08:15:00.000Z', '2026-08-20T09:00:00.000Z',
      '["src/historical-${schemaVersion}.ts"]'${schemaVersion >= 4 ? ", 'awaiting_commit'" : ""}${schemaVersion >= 5 ? ", 'awaiting_commit'" : ""}
    );
    INSERT INTO lease_paths (lease_id, path, path_key, risk, risk_reason) VALUES (
      '${fixturePrefix}-lease', 'src/historical-${schemaVersion}.ts',
      'src/historical-${schemaVersion}.ts', 'normal', NULL
    );
    INSERT INTO local_scans (
      id, session_id, room_id, member_id, repository, branch, worktree,
      base_commit, changed_paths_json, rule_files_json, systems_json,
      metadata_json, scanned_at${hasScanFinalizationColumn ? ", finalization_id" : ""}
    ) VALUES (
      '${fixturePrefix}-scan', '${fixturePrefix}-session', '${fixturePrefix}-room',
      '${fixturePrefix}-member', 'C:/historical/repo', 'main', 'C:/historical/repo',
      'base-${schemaVersion}', '["src/historical-${schemaVersion}.ts"]',
      '["AGENTS.md"]', '["historical-system"]', '{"preserved":true}',
      '2026-08-20T09:00:00.000Z'${hasScanFinalizationColumn ? `, '${options.finalizationColumn ? "manual-repair-finalization" : `schema${schemaVersion}-finalization`}'` : ""}
    );
    PRAGMA user_version = ${schemaVersion};
  `);
  legacy.close();
}

function expectHistoricalFixturePreserved(
  database: AgentHubDatabase,
  schemaVersion: HistoricalSchemaVersion,
  expectedFinalizationId: string | null = null,
): void {
  const fixturePrefix = `schema${schemaVersion}`;
  expect(database.connection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
  expect(database.connection.prepare(`
    SELECT id, name, repository FROM rooms WHERE id = ?
  `).get(`${fixturePrefix}-room`)).toEqual({
    id: `${fixturePrefix}-room`,
    name: "Historical room",
    repository: "C:/historical/repo",
  });
  expect(database.connection.prepare(`
    SELECT id, name, last_seen_at FROM members WHERE id = ?
  `).get(`${fixturePrefix}-member`)).toEqual({
    id: `${fixturePrefix}-member`,
    name: "Alice",
    last_seen_at: "2026-08-20T09:00:00.000Z",
  });
  expect(database.connection.prepare(`
    SELECT id, status, metadata_json FROM work_sessions WHERE id = ?
  `).get(`${fixturePrefix}-session`)).toEqual({
    id: `${fixturePrefix}-session`,
    status: "active",
    metadata_json: `{"source":"historical-${schemaVersion}"}`,
  });
  expect(database.connection.prepare(`
    SELECT id, session_id, title, status, changed_paths_json FROM leases WHERE id = ?
  `).get(`${fixturePrefix}-lease`)).toEqual({
    id: `${fixturePrefix}-lease`,
    session_id: `${fixturePrefix}-session`,
    title: "Historical lease",
    status: "active",
    changed_paths_json: `["src/historical-${schemaVersion}.ts"]`,
  });
  expect(database.connection.prepare(`
    SELECT automatic_phase, coordination_state, managed_by, created_via FROM leases WHERE id = ?
  `).get(`${fixturePrefix}-lease`)).toEqual({
    automatic_phase: schemaVersion >= 4 ? "awaiting_commit" : "working",
    coordination_state: schemaVersion >= 4 ? "awaiting_commit" : "working",
    managed_by: schemaVersion === 2 ? "manual" : "agent",
    created_via: "legacy",
  });
  expect(database.connection.prepare(`
    SELECT id, session_id, changed_paths_json, metadata_json, finalization_id
    FROM local_scans WHERE id = ?
  `).get(`${fixturePrefix}-scan`)).toEqual({
    id: `${fixturePrefix}-scan`,
    session_id: `${fixturePrefix}-session`,
    changed_paths_json: `["src/historical-${schemaVersion}.ts"]`,
    metadata_json: '{"preserved":true}',
    finalization_id: expectedFinalizationId ?? (schemaVersion >= 4 ? `schema${schemaVersion}-finalization` : null),
  });
  expect(database.connection.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'scans_finalization_idx'
  `).get()).toEqual({ name: "scans_finalization_idx" });
  expectAgentLeaseSchema(database);
  expect(database.connection.prepare("PRAGMA integrity_check").all()).toEqual([
    { integrity_check: "ok" },
  ]);
  expect(database.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

function expectAgentLeaseSchema(database: AgentHubDatabase): void {
  const columns = database.connection.prepare("PRAGMA table_info(leases)").all() as Array<{ name: string }>;
  expect(columns.filter((column) => column.name === "managed_by")).toHaveLength(1);
  expect(columns.filter((column) => column.name === "created_via")).toHaveLength(1);

  const index = (database.connection.prepare("PRAGMA index_list('leases')").all() as Array<{
    name: string;
    unique: number;
    partial: number;
  }>).find((candidate) => candidate.name === "leases_active_agent_session_idx");
  expect(index).toMatchObject({ unique: 1, partial: 1 });
  expect(database.connection.prepare(`PRAGMA index_info('leases_active_agent_session_idx')`).all())
    .toEqual([
      expect.objectContaining({ name: "room_id" }),
      expect.objectContaining({ name: "member_id" }),
      expect.objectContaining({ name: "session_id" }),
    ]);
  const definition = database.connection.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'leases_active_agent_session_idx'
  `).get() as { sql: string };
  expect(definition.sql.replace(/\s+/g, " ").toLowerCase()).toContain(
    "where status = 'active' and managed_by = 'agent' and session_id is not null",
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Agent Hub database migrations", () => {
  it("rolls nested savepoints back with their outer coordination transaction", () => {
    const database = new AgentHubDatabase({ path: ":memory:" });
    database.connection.exec("CREATE TABLE transaction_probe (value TEXT NOT NULL)");
    expect(() => database.transaction(() => {
      database.connection.prepare("INSERT INTO transaction_probe (value) VALUES ('outer')").run();
      database.transaction(() => {
        database.connection.prepare("INSERT INTO transaction_probe (value) VALUES ('inner')").run();
      });
      throw new Error("rollback outer");
    })).toThrow("rollback outer");
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM transaction_probe").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("refuses to open a database created by a newer schema", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-future-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent-hub.sqlite");
    const future = new DatabaseSync(databasePath);
    future.exec("PRAGMA user_version = 7");
    future.close();
    expect(() => new AgentHubDatabase({ path: databasePath })).toThrow(
      /newer than supported schema 6/,
    );
  });

  it("migrates the released v0.1.0 schema 2 layout without losing records", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-v010-schema2-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent-hub.sqlite");
    createHistoricalDatabaseFixture(databasePath, 2);

    const migrated = new AgentHubDatabase({ path: databasePath });
    expectHistoricalFixturePreserved(migrated, 2);
    expect(migrated.connection.prepare(`
      SELECT kind, automatic_phase FROM leases WHERE id = 'schema2-lease'
    `).get()).toEqual({ kind: "standard", automatic_phase: "working" });
    migrated.close();
  });

  it.each(["v0.2.0", "v0.2.1", "v0.2.2"])(
    "migrates the released %s schema 3 layout without losing records",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "agent-hub-released-schema3-db-"));
      temporaryDirectories.push(directory);
      const databasePath = join(directory, "agent-hub.sqlite");
      createHistoricalDatabaseFixture(databasePath, 3);

      const migrated = new AgentHubDatabase({ path: databasePath });
      expectHistoricalFixturePreserved(migrated, 3);
      expect(migrated.connection.prepare(`
        SELECT kind, automatic_phase FROM leases WHERE id = 'schema3-lease'
      `).get()).toEqual({ kind: "automatic", automatic_phase: "working" });
      migrated.close();
    },
  );

  it("migrates the released v0.2.4 schema 4 layout and preserves its automatic phase", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-released-schema4-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent-hub.sqlite");
    createHistoricalDatabaseFixture(databasePath, 4);

    const migrated = new AgentHubDatabase({ path: databasePath });
    expectHistoricalFixturePreserved(migrated, 4);
    migrated.close();

    const reopened = new AgentHubDatabase({ path: databasePath });
    expectHistoricalFixturePreserved(reopened, 4);
    reopened.close();
  });

  it("migrates the released v0.2.5-v0.2.6 schema 5 layout without losing coordination state", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-released-schema5-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent-hub.sqlite");
    createHistoricalDatabaseFixture(databasePath, 5);

    const migrated = new AgentHubDatabase({ path: databasePath });
    expectHistoricalFixturePreserved(migrated, 5);
    migrated.close();

    const reopened = new AgentHubDatabase({ path: databasePath });
    expectHistoricalFixturePreserved(reopened, 5);
    reopened.close();
  });

  it("only promotes an audited MCP-session claim out of legacy standard leases", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-schema5-lease-source-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent-hub.sqlite");
    createHistoricalDatabaseFixture(databasePath, 5);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE activities (
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
      INSERT INTO work_sessions (
        id, room_id, member_id, status, metadata_json, opened_at, last_seen_at
      ) VALUES
        (
          'proven-mcp-session', 'schema5-room', 'schema5-member', 'active',
          '{"source":"mcp"}', '2026-08-20T09:10:00.000Z', '2026-08-20T09:20:00.000Z'
        ),
        (
          'unproven-mcp-session', 'schema5-room', 'schema5-member', 'active',
          '{"source":"mcp"}', '2026-08-20T09:30:00.000Z', '2026-08-20T09:40:00.000Z'
        ),
        (
          'audited-hook-session', 'schema5-room', 'schema5-member', 'active',
          '{"source":"codex-hook"}', '2026-08-20T09:50:00.000Z', '2026-08-20T10:00:00.000Z'
        );
      INSERT INTO leases (
        id, room_id, member_id, session_id, title, intent, mode, kind, status,
        decision, expires_at, created_at, updated_at
      ) VALUES
        (
          'proven-mcp-lease', 'schema5-room', 'schema5-member', 'proven-mcp-session',
          'Proven MCP claim', '', 'write', 'standard', 'active', 'allow',
          '2099-01-01T00:00:00.000Z', '2026-08-20T09:11:00.000Z', '2026-08-20T09:11:00.000Z'
        ),
        (
          'unproven-mcp-lease', 'schema5-room', 'schema5-member', 'unproven-mcp-session',
          'Unproven MCP claim', '', 'write', 'standard', 'active', 'allow',
          '2099-01-01T00:00:00.000Z', '2026-08-20T09:31:00.000Z', '2026-08-20T09:31:00.000Z'
        ),
        (
          'audited-hook-lease', 'schema5-room', 'schema5-member', 'audited-hook-session',
          'Audited Hook claim', '', 'write', 'standard', 'active', 'allow',
          '2099-01-01T00:00:00.000Z', '2026-08-20T09:51:00.000Z', '2026-08-20T09:51:00.000Z'
        );
      INSERT INTO activities (
        id, room_id, actor_member_id, actor_name, type, entity_type,
        entity_id, summary, metadata_json, created_at
      ) VALUES
        (
          'proven-mcp-audit', 'schema5-room', 'schema5-member', 'Alice',
          'lease.acquired', 'lease', 'proven-mcp-lease', 'Acquired through MCP.',
          '{"kind":"standard"}', '2026-08-20T09:11:00.000Z'
        ),
        (
          'generic-hook-audit', 'schema5-room', 'schema5-member', 'Alice',
          'lease.acquired', 'lease', 'audited-hook-lease', 'Generic lease acquisition.',
          '{"kind":"standard"}', '2026-08-20T09:51:00.000Z'
        );
    `);
    legacy.close();

    const migrated = new AgentHubDatabase({ path: databasePath });
    expect(migrated.connection.prepare(`
      SELECT id, kind, managed_by, created_via
      FROM leases
      WHERE id IN ('proven-mcp-lease', 'unproven-mcp-lease', 'audited-hook-lease')
      ORDER BY id
    `).all()).toEqual([
      { id: "audited-hook-lease", kind: "standard", managed_by: "manual", created_via: "legacy" },
      { id: "proven-mcp-lease", kind: "automatic", managed_by: "agent", created_via: "mcp" },
      { id: "unproven-mcp-lease", kind: "standard", managed_by: "manual", created_via: "legacy" },
    ]);
    expectAgentLeaseSchema(migrated);
    migrated.close();
  });

  it("merges duplicate active Agent leases before enforcing one lease per Hub session", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-schema5-agent-merge-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent-hub.sqlite");
    createHistoricalDatabaseFixture(databasePath, 5);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE release_requests (
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
      UPDATE leases SET
        mode = 'write', decision = 'deny', expires_at = '2099-02-01T00:00:00.000Z',
        automatic_phase = 'awaiting_commit', coordination_state = 'blocked',
        completion_summary = 'Preserve the blocking evidence.'
      WHERE id = 'schema5-lease';
      INSERT INTO leases (
        id, room_id, member_id, session_id, title, intent, mode, kind, status,
        decision, expires_at, created_at, updated_at, automatic_phase, coordination_state
      ) VALUES (
        'schema5-canonical-agent', 'schema5-room', 'schema5-member', 'schema5-session',
        'Earliest Agent lease', '', 'read', 'automatic', 'active', 'allow',
        '2099-01-15T00:00:00.000Z', '2026-08-20T08:00:00.000Z',
        '2026-08-20T08:00:00.000Z', 'working', 'working'
      );
      INSERT INTO lease_paths (lease_id, path, path_key, risk, risk_reason) VALUES
        ('schema5-canonical-agent', 'src/shared.ts', 'src/shared.ts', 'normal', NULL),
        ('schema5-lease', 'src/shared.ts', 'src/shared.ts', 'high', 'Shared path became high risk.');
      INSERT INTO release_requests (
        id, room_id, requester_member_id, requester_session_id, requester_lease_id,
        conflicting_lease_id, request_title, requested_kind, requested_mode,
        requested_paths_json, overlap_paths_json, reason, transfer_key, dedupe_key,
        status, requested_at, last_requested_at
      ) VALUES
        (
          'requester-loser', 'schema5-room', 'schema5-member', 'schema5-session',
          'schema5-lease', 'schema5-canonical-agent', 'Requester loser', 'automatic', 'write',
          '[]', '[]', 'Pending against duplicate.', 'transfer-requester', 'dedupe-requester',
          'pending', '2026-08-20T08:30:00.000Z', '2026-08-20T08:30:00.000Z'
        ),
        (
          'conflicting-loser', 'schema5-room', 'schema5-member', 'schema5-session',
          'schema5-canonical-agent', 'schema5-lease', 'Conflicting loser', 'automatic', 'write',
          '[]', '[]', 'Pending against duplicate.', 'transfer-conflict', 'dedupe-conflict',
          'pending', '2026-08-20T08:31:00.000Z', '2026-08-20T08:31:00.000Z'
        ),
        (
          'unrelated-request', 'schema5-room', 'schema5-member', 'schema5-session',
          'schema5-canonical-agent', 'schema5-canonical-agent', 'Unrelated request', 'automatic', 'write',
          '[]', '[]', 'Must remain pending.', 'transfer-unrelated', 'dedupe-unrelated',
          'pending', '2026-08-20T08:32:00.000Z', '2026-08-20T08:32:00.000Z'
        );
    `);
    legacy.close();

    const migrated = new AgentHubDatabase({ path: databasePath });
    expect(migrated.connection.prepare(`
      SELECT id, mode, decision, status, managed_by, created_via, expires_at,
        automatic_phase, coordination_state, completion_summary
      FROM leases WHERE id = 'schema5-canonical-agent'
    `).get()).toEqual({
      id: "schema5-canonical-agent",
      mode: "write",
      decision: "deny",
      status: "active",
      managed_by: "agent",
      created_via: "legacy",
      expires_at: "2099-02-01T00:00:00.000Z",
      automatic_phase: "awaiting_commit",
      coordination_state: "blocked",
      completion_summary: "Preserve the blocking evidence.",
    });
    expect(migrated.connection.prepare(`
      SELECT id, status, outcome, completion_summary FROM leases WHERE id = 'schema5-lease'
    `).get()).toEqual({
      id: "schema5-lease",
      status: "cancelled",
      outcome: "merged",
      completion_summary: expect.stringContaining("Merged into Agent lease schema5-canonical-agent"),
    });
    expect(migrated.connection.prepare(`
      SELECT path, risk, risk_reason
      FROM lease_paths WHERE lease_id = 'schema5-canonical-agent'
      ORDER BY path_key
    `).all()).toEqual([
      { path: "src/historical-5.ts", risk: "normal", risk_reason: null },
      { path: "src/shared.ts", risk: "high", risk_reason: "Shared path became high risk." },
    ]);
    expect(migrated.connection.prepare(`
      SELECT id, status, resolved_at FROM release_requests ORDER BY id
    `).all()).toEqual([
      { id: "conflicting-loser", status: "cancelled", resolved_at: "2026-08-20T09:00:00.000Z" },
      { id: "requester-loser", status: "cancelled", resolved_at: "2026-08-20T09:00:00.000Z" },
      { id: "unrelated-request", status: "pending", resolved_at: null },
    ]);
    expect(() => migrated.connection.prepare(`
      INSERT INTO leases (
        id, room_id, member_id, session_id, title, intent, mode, kind, managed_by,
        created_via, status, decision, expires_at, created_at, updated_at
      ) VALUES (
        'forbidden-duplicate-agent', 'schema5-room', 'schema5-member', 'schema5-session',
        'Duplicate Agent', '', 'write', 'automatic', 'agent', 'hook', 'active', 'allow',
        '2099-03-01T00:00:00.000Z', '2026-08-20T11:00:00.000Z', '2026-08-20T11:00:00.000Z'
      )
    `).run()).toThrow(/UNIQUE constraint failed/);
    expect(() => migrated.connection.prepare(`
      INSERT INTO leases (
        id, room_id, member_id, title, intent, mode, kind, managed_by,
        created_via, status, decision, expires_at, created_at, updated_at
      ) VALUES (
        'invalid-managed-kind', 'schema5-room', 'schema5-member',
        'Invalid management', '', 'write', 'automatic', 'manual', 'legacy',
        'active', 'allow', '2099-03-01T00:00:00.000Z',
        '2026-08-20T11:00:00.000Z', '2026-08-20T11:00:00.000Z'
      )
    `).run()).toThrow(/lease management must match lease kind/);
    expect(migrated.connection.prepare(`
      INSERT INTO leases (
        id, room_id, member_id, session_id, title, intent, mode, kind, managed_by,
        created_via, status, decision, expires_at, created_at, updated_at
      ) VALUES (
        'parallel-manual-lease', 'schema5-room', 'schema5-member', 'schema5-session',
        'Manual scope', '', 'write', 'standard', 'manual', 'ui', 'active', 'allow',
        '2099-03-01T00:00:00.000Z', '2026-08-20T11:00:00.000Z', '2026-08-20T11:00:00.000Z'
      )
    `).run().changes).toBe(1);
    expectAgentLeaseSchema(migrated);
    expect(migrated.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();

    const reopened = new AgentHubDatabase({ path: databasePath });
    expect(reopened.connection.prepare(`
      SELECT COUNT(*) AS count FROM leases
      WHERE room_id = 'schema5-room' AND member_id = 'schema5-member'
        AND session_id = 'schema5-session' AND status = 'active' AND managed_by = 'agent'
    `).get()).toEqual({ count: 1 });
    reopened.close();
  });

  it("repairs an interrupted schema 5 coordination-state backfill idempotently", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-partial-schema5-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent-hub.sqlite");
    createHistoricalDatabaseFixture(databasePath, 4);
    const partial = new DatabaseSync(databasePath);
    partial.exec(`
      ALTER TABLE leases ADD COLUMN coordination_state TEXT NOT NULL DEFAULT 'working'
        CHECK (coordination_state IN ('working', 'waiting', 'blocked', 'awaiting_commit'));
      PRAGMA user_version = 5;
    `);
    partial.close();

    const repaired = new AgentHubDatabase({ path: databasePath });
    expectHistoricalFixturePreserved(repaired, 4);
    repaired.close();

    const reopened = new AgentHubDatabase({ path: databasePath });
    expectHistoricalFixturePreserved(reopened, 4);
    reopened.close();
  });

  it("resumes an interrupted schema 6 management-source migration idempotently", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-partial-schema6-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent-hub.sqlite");
    createHistoricalDatabaseFixture(databasePath, 5);
    const partial = new DatabaseSync(databasePath);
    partial.exec(`
      ALTER TABLE leases ADD COLUMN managed_by TEXT NOT NULL DEFAULT 'manual'
        CHECK (managed_by IN ('manual', 'agent'));
      UPDATE leases SET managed_by = 'agent' WHERE kind = 'automatic';
      PRAGMA user_version = 5;
    `);
    partial.close();

    const repaired = new AgentHubDatabase({ path: databasePath });
    expectHistoricalFixturePreserved(repaired, 5);
    repaired.close();

    const reopened = new AgentHubDatabase({ path: databasePath });
    expectHistoricalFixturePreserved(reopened, 5);
    reopened.close();
  });

  it("retries a v0.2.3 migration after the failed index transaction rolls back", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-v023-rollback-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent-hub.sqlite");
    createHistoricalDatabaseFixture(databasePath, 3);

    const failedUpgrade = new DatabaseSync(databasePath);
    failedUpgrade.exec("BEGIN IMMEDIATE");
    expect(() => failedUpgrade.exec(`
      CREATE UNIQUE INDEX scans_finalization_idx
      ON local_scans(finalization_id) WHERE finalization_id IS NOT NULL
    `)).toThrow(/no such column: finalization_id/);
    failedUpgrade.exec("ROLLBACK");
    expect(failedUpgrade.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(failedUpgrade.prepare(`
      SELECT COUNT(*) AS count FROM pragma_table_info('local_scans')
      WHERE name = 'finalization_id'
    `).get()).toEqual({ count: 0 });
    expect(failedUpgrade.prepare(`
      SELECT id, metadata_json FROM local_scans WHERE id = 'schema3-scan'
    `).get()).toEqual({ id: "schema3-scan", metadata_json: '{"preserved":true}' });
    failedUpgrade.close();

    const retried = new AgentHubDatabase({ path: databasePath });
    expectHistoricalFixturePreserved(retried, 3);
    retried.close();
  });

  it("finishes schema 3 migration when finalization_id was repaired manually", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-schema3-manual-repair-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent-hub.sqlite");
    createHistoricalDatabaseFixture(databasePath, 3, { finalizationColumn: true });

    const migrated = new AgentHubDatabase({ path: databasePath });
    expectHistoricalFixturePreserved(migrated, 3, "manual-repair-finalization");
    expect(migrated.connection.prepare(`
      SELECT COUNT(*) AS count FROM pragma_table_info('local_scans')
      WHERE name = 'finalization_id'
    `).get()).toEqual({ count: 1 });
    migrated.close();
  });

  it("initializes a new schema 6 database and reopens it idempotently", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-new-schema6-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent-hub.sqlite");

    const created = new AgentHubDatabase({ path: databasePath });
    expect(created.connection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(created.connection.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "ok" },
    ]);
    expect(created.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    created.close();

    const reopened = new AgentHubDatabase({ path: databasePath });
    expect(reopened.connection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(reopened.connection.prepare(`
      SELECT COUNT(*) AS count FROM pragma_table_info('local_scans')
      WHERE name = 'finalization_id'
    `).get()).toEqual({ count: 1 });
    expect(reopened.connection.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'scans_finalization_idx'
    `).get()).toEqual({ name: "scans_finalization_idx" });
    expectAgentLeaseSchema(reopened);
    expect(reopened.connection.prepare("PRAGMA integrity_check").all()).toEqual([
      { integrity_check: "ok" },
    ]);
    expect(reopened.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    reopened.close();
  });

  it("repairs an early schema 6 database that predates decision replacement columns", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-early-schema6-decision-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent-hub.sqlite");
    createHistoricalDatabaseFixture(databasePath, 5);
    const earlySchema6 = new DatabaseSync(databasePath);
    earlySchema6.exec(`
      CREATE TABLE records (
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
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        author_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        decision TEXT NOT NULL,
        rationale TEXT,
        paths_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO decisions (
        id, room_id, author_member_id, title, decision, rationale, paths_json, created_at
      ) VALUES (
        'early-schema6-decision', 'schema5-room', 'schema5-member',
        'Existing decision', 'Keep the existing behavior.', 'Previously confirmed.', '[]',
        '2026-08-20T09:00:00.000Z'
      );
      INSERT INTO records (
        id, room_id, member_id, kind, title, summary, paths_json, status,
        evidence_json, commit_hash, created_at
      ) VALUES (
        'legacy-imported-record', 'schema5-room', 'schema5-member', 'decision',
        'Existing decision', 'Keep the existing behavior.', '[]', 'accepted',
        '["Previously confirmed."]', NULL, '2026-08-20T09:00:00.000Z'
      );
      PRAGMA user_version = 6;
    `);
    earlySchema6.close();

    const repaired = new AgentHubDatabase({ path: databasePath });
    expect(repaired.connection.prepare(`
      SELECT id, status, supersedes_decision_id FROM decisions
      WHERE id = 'early-schema6-decision'
    `).get()).toEqual({
      id: "early-schema6-decision",
      status: "current",
      supersedes_decision_id: null,
    });
    expect(repaired.connection.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'decisions_single_successor_idx'
    `).get()).toEqual({ name: "decisions_single_successor_idx" });
    expect(repaired.connection.prepare(`
      SELECT id, status FROM records WHERE title = 'Existing decision'
    `).get()).toEqual({ id: "early-schema6-decision", status: "current" });
    repaired.connection.prepare(`
      INSERT INTO decisions (
        id, room_id, author_member_id, status, supersedes_decision_id,
        title, decision, rationale, paths_json, created_at
      ) VALUES (?, 'schema5-room', 'schema5-member', 'current',
        'early-schema6-decision', ?, ?, ?, '[]', ?)
    `).run(
      "first-successor",
      "First replacement",
      "Use the first replacement.",
      "Confirmed by the user.",
      "2026-08-20T10:00:00.000Z",
    );
    expect(() => repaired.connection.prepare(`
      INSERT INTO decisions (
        id, room_id, author_member_id, status, supersedes_decision_id,
        title, decision, rationale, paths_json, created_at
      ) VALUES (?, 'schema5-room', 'schema5-member', 'current',
        'early-schema6-decision', ?, ?, ?, '[]', ?)
    `).run(
      "second-successor",
      "Second replacement",
      "This branch must fail.",
      "Conflicting replacement.",
      "2026-08-20T10:01:00.000Z",
    )).toThrow(/UNIQUE constraint failed/);
    repaired.connection.exec(`
      INSERT INTO decisions (
        id, room_id, author_member_id, status, supersedes_decision_id,
        title, decision, rationale, paths_json, created_at
      ) VALUES (
        'split-superseded-decision', 'schema5-room', 'schema5-member',
        'superseded', NULL, 'Historical superseded decision',
        'Keep the old choice only in history.', 'The team later changed it.', '[]',
        '2026-08-20T11:00:00.000Z'
      );
      INSERT INTO records (
        id, room_id, member_id, kind, title, summary, paths_json, status,
        evidence_json, commit_hash, created_at
      ) VALUES (
        'legacy-split-superseded-record', 'schema5-room', 'schema5-member',
        'decision', 'Historical superseded decision',
        'Keep the old choice only in history.', '[]', 'accepted',
        '["The team later changed it."]', NULL, '2026-08-20T11:00:00.000Z'
      );
      INSERT INTO decisions (
        id, room_id, author_member_id, status, supersedes_decision_id,
        title, decision, rationale, paths_json, created_at
      ) VALUES (
        'split-current-successor', 'schema5-room', 'schema5-member', 'current',
        'split-superseded-decision', 'Current successor decision',
        'Use the replacement choice.', 'The replacement was confirmed.', '[]',
        '2026-08-20T12:00:00.000Z'
      );
      INSERT INTO records (
        id, room_id, member_id, kind, title, summary, paths_json, status,
        evidence_json, commit_hash, created_at
      ) VALUES (
        'split-current-successor', 'schema5-room', 'schema5-member', 'decision',
        'Current successor decision', 'Use the replacement choice.', '[]',
        'current', '["The replacement was confirmed."]', NULL,
        '2026-08-20T12:00:00.000Z'
      );
    `);
    expect(repaired.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    repaired.close();

    const statusRepaired = new AgentHubDatabase({ path: databasePath });
    expect(statusRepaired.connection.prepare(`
      SELECT id, status FROM records WHERE title = 'Historical superseded decision'
    `).get()).toEqual({ id: "split-superseded-decision", status: "superseded" });
    expect(statusRepaired.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    statusRepaired.connection.prepare("DELETE FROM rooms WHERE id = 'schema5-room'").run();
    expect(statusRepaired.connection.prepare("SELECT COUNT(*) AS count FROM decisions").get())
      .toEqual({ count: 0 });
    expect(statusRepaired.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    statusRepaired.close();

    const reopened = new AgentHubDatabase({ path: databasePath });
    expect(reopened.connection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(reopened.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    reopened.close();
  });

  it("migrates duplicate Codex sessions from the v0.2.2 schema 3 layout", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-schema3-codex-session-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent-hub.sqlite");
    const memberToken = "ahm_schema3_duplicate_member_token";
    const tokenHash = createHash("sha256")
      .update(memberToken, "utf8")
      .digest("hex");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE rooms (
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
        risk_policy_rules_json TEXT NOT NULL DEFAULT '[]',
        settings_updated_at TEXT,
        settings_updated_by TEXT,
        dissolved_at TEXT
      );
      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('host', 'member')),
        client_name TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        removed_at TEXT,
        client_version TEXT,
        protocol_version INTEGER,
        schema_version INTEGER
      );
      CREATE TABLE work_sessions (
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
      CREATE TABLE leases (
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
      CREATE TABLE lease_paths (
        lease_id TEXT NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        path_key TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('normal', 'high')),
        risk_reason TEXT,
        PRIMARY KEY (lease_id, path_key)
      );
      CREATE TABLE local_scans (
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
      INSERT INTO rooms (
        id, code, name, project_name, repository, default_branch, created_at
      ) VALUES (
        'schema3-room', 'SCHEMA03', 'Schema 3 room', 'Schema 3 project',
        'https://example.invalid/schema3.git', 'main', '2026-08-27T08:00:00.000Z'
      );
      INSERT INTO members (
        id, room_id, name, role, client_name, token_hash, created_at, last_seen_at
      ) VALUES (
        'schema3-member', 'schema3-room', 'Alice', 'host', 'Codex', '${tokenHash}',
        '2026-08-27T08:00:00.000Z', '2026-08-27T10:00:00.000Z'
      );
      INSERT INTO work_sessions (
        id, room_id, member_id, client_name, agent_name, status, metadata_json,
        opened_at, last_seen_at, closed_at
      ) VALUES
        (
          'schema3-session-newer', 'schema3-room', 'schema3-member', 'Codex', 'Codex',
          'active', '{"codexSessionId":"codex-schema3-duplicate"}',
          '2026-08-27T08:30:00.000Z', '2026-08-27T10:00:00.000Z', NULL
        ),
        (
          'schema3-session-older', 'schema3-room', 'schema3-member', 'Codex', 'Codex',
          'active', '{"codexSessionId":"codex-schema3-duplicate"}',
          '2026-08-27T08:00:00.000Z', '2026-08-27T09:00:00.000Z', NULL
        );
      INSERT INTO local_scans (
        id, session_id, room_id, member_id, repository, branch, worktree,
        base_commit, changed_paths_json, rule_files_json, systems_json,
        metadata_json, scanned_at
      ) VALUES (
        'schema3-scan', 'schema3-session-newer', 'schema3-room', 'schema3-member',
        'C:/repo', 'main', 'C:/repo', 'base-commit', '[]', '[]', '[]', '{}',
        '2026-08-27T10:00:00.000Z'
      );
      INSERT INTO leases (
        id, room_id, member_id, session_id, title, intent, mode, kind, status,
        decision, expires_at, created_at, updated_at
      ) VALUES
        (
          'schema3-canonical-auto', 'schema3-room', 'schema3-member', 'schema3-session-newer',
          'Canonical automatic', '', 'write', 'automatic', 'active', 'allow',
          '2026-08-27T12:00:00.000Z', '2026-08-27T08:30:00.000Z', '2026-08-27T08:30:00.000Z'
        ),
        (
          'schema3-loser-auto', 'schema3-room', 'schema3-member', 'schema3-session-older',
          'Loser automatic', '', 'write', 'automatic', 'active', 'allow',
          '2026-08-27T12:00:00.000Z', '2026-08-27T08:00:00.000Z', '2026-08-27T08:00:00.000Z'
        ),
        (
          'schema3-loser-standard', 'schema3-room', 'schema3-member', 'schema3-session-older',
          'Loser standard', '', 'write', 'standard', 'active', 'allow',
          '2026-08-27T13:00:00.000Z', '2026-08-27T08:00:00.000Z', '2026-08-27T08:00:00.000Z'
        ),
        (
          'schema3-loser-exclusive', 'schema3-room', 'schema3-member', 'schema3-session-older',
          'Loser exclusive', '', 'write', 'exclusive', 'active', 'allow',
          '2026-08-27T14:00:00.000Z', '2026-08-27T08:00:00.000Z', '2026-08-27T08:00:00.000Z'
        );
      INSERT INTO lease_paths (lease_id, path, path_key, risk, risk_reason) VALUES (
        'schema3-loser-auto', 'Assets/Scenes/Schema3.unity',
        'assets/scenes/schema3.unity', 'high', 'Unity scene files require exclusive coordination.'
      );
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const migrated = new AgentHubDatabase({ path: databasePath });
    expect(migrated.connection.prepare(`
      SELECT id, codex_session_id, status, closed_at
      FROM work_sessions
      WHERE codex_session_id = 'codex-schema3-duplicate'
      ORDER BY id
    `).all()).toEqual([
      {
        id: "schema3-session-newer",
        codex_session_id: "codex-schema3-duplicate",
        status: "active",
        closed_at: null,
      },
      {
        id: "schema3-session-older",
        codex_session_id: "codex-schema3-duplicate",
        status: "closed",
        closed_at: "2026-08-27T09:00:00.000Z",
      },
    ]);
    expect(migrated.connection.prepare(`
      SELECT id, session_id, kind, status, automatic_phase, coordination_state, expires_at
      FROM leases
      WHERE id LIKE 'schema3-%'
      ORDER BY id
    `).all()).toEqual([
      { id: "schema3-canonical-auto", session_id: "schema3-session-newer", kind: "automatic", status: "active", automatic_phase: "working", coordination_state: "working", expires_at: "2026-08-27T12:00:00.000Z" },
      { id: "schema3-loser-auto", session_id: "schema3-session-older", kind: "automatic", status: "active", automatic_phase: "awaiting_commit", coordination_state: "awaiting_commit", expires_at: "2026-08-27T12:00:00.000Z" },
      { id: "schema3-loser-exclusive", session_id: "schema3-session-older", kind: "exclusive", status: "active", automatic_phase: "working", coordination_state: "working", expires_at: "2026-08-27T14:00:00.000Z" },
      { id: "schema3-loser-standard", session_id: "schema3-session-older", kind: "standard", status: "active", automatic_phase: "working", coordination_state: "working", expires_at: "2026-08-27T13:00:00.000Z" },
    ]);
    expect(migrated.connection.prepare(`
      SELECT COUNT(*) AS count FROM work_sessions
      WHERE room_id = 'schema3-room' AND member_id = 'schema3-member'
        AND codex_session_id = 'codex-schema3-duplicate' AND closed_at IS NULL
    `).get()).toEqual({ count: 1 });
    expect(migrated.connection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(migrated.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(migrated.connection.prepare(`
      SELECT id, finalization_id FROM local_scans WHERE id = 'schema3-scan'
    `).get()).toEqual({ id: "schema3-scan", finalization_id: null });
    expect(migrated.connection.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'scans_finalization_idx'
    `).get()).toEqual({ name: "scans_finalization_idx" });

    let currentTime = new Date("2026-08-27T11:30:00.000Z");
    const service = new AgentHubService(migrated, { now: () => currentTime });
    const joined = service.joinRoom({
      roomToken: "SCHEMA03",
      displayName: "Bob",
    });
    const competingSession = service.openSession({
      memberToken: joined.memberToken,
      codexSessionId: "codex-schema3-competing",
    });
    expect(service.claimLease({
      memberToken: joined.memberToken,
      sessionId: competingSession.id,
      title: "Competing scene edit",
      paths: ["Assets/Scenes/Schema3.unity"],
      kind: "automatic",
    })).toMatchObject({ acquired: false, decision: "deny" });

    currentTime = new Date("2026-08-27T12:00:00.001Z");
    expect(service.claimLease({
      memberToken: joined.memberToken,
      sessionId: competingSession.id,
      title: "Scene edit after migrated TTL",
      paths: ["Assets/Scenes/Schema3.unity"],
      kind: "automatic",
    })).toMatchObject({ acquired: true });
    expect(migrated.connection.prepare(`
      SELECT status, automatic_phase, coordination_state, expires_at FROM leases WHERE id = 'schema3-loser-auto'
    `).get()).toEqual({
      status: "expired",
      automatic_phase: "awaiting_commit",
      coordination_state: "awaiting_commit",
      expires_at: "2026-08-27T12:00:00.000Z",
    });
    migrated.close();
  });

  it("preserves a finalizing generation while canonicalizing active Codex sessions", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-schema4-session-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent-hub.sqlite");
    const memberToken = "ahm_schema4_duplicate_member_token";
    const tokenHash = createHash("sha256").update(memberToken, "utf8").digest("hex");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        project_name TEXT NOT NULL,
        repository TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('host', 'member')),
        client_name TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE work_sessions (
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
        schema_version INTEGER,
        finalization_id TEXT,
        finalizing_at TEXT,
        finalization_error TEXT,
        codex_session_id TEXT,
        current_turn_id TEXT,
        activity_epoch INTEGER NOT NULL DEFAULT 0,
        turn_stopped_at TEXT
      );
      CREATE TABLE leases (
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
        handoff TEXT,
        automatic_phase TEXT NOT NULL DEFAULT 'working' CHECK (automatic_phase IN ('working', 'awaiting_commit'))
      );
      INSERT INTO rooms VALUES (
        'room-1', 'ROOM0001', 'Room', 'Project', 'https://example.invalid/repo.git',
        'main', '2026-08-27T08:00:00.000Z'
      );
      INSERT INTO members VALUES (
        'member-1', 'room-1', 'Alice', 'host', 'Codex', '${tokenHash}',
        '2026-08-27T08:00:00.000Z', '2026-08-27T10:00:00.000Z'
      );
      INSERT INTO work_sessions (
        id, room_id, member_id, status, metadata_json, opened_at, last_seen_at,
        finalization_id, finalizing_at, current_turn_id, activity_epoch, turn_stopped_at
      ) VALUES
        (
          'session-finalizing', 'room-1', 'member-1', 'active',
          '{"codexSessionId":"codex-duplicate"}',
          '2026-08-27T08:00:00.000Z', '2026-08-27T09:00:00.000Z',
          'finalization-1', '2026-08-27T09:00:00.000Z', NULL, 0, NULL
        ),
        (
          'session-newer', 'room-1', 'member-1', 'active',
          '{"codexSessionId":"codex-duplicate"}',
          '2026-08-27T08:30:00.000Z', '2026-08-27T10:00:00.000Z',
          NULL, NULL, 'turn-finalizing-loser', 7, '2026-08-27T10:00:00.000Z'
        ),
        (
          'session-active-newer', 'room-1', 'member-1', 'active',
          '{"codexSessionId":"codex-active"}',
          '2026-08-27T09:00:00.000Z', '2026-08-27T11:00:00.000Z',
          NULL, NULL, NULL, 0, NULL
        ),
        (
          'session-active-older', 'room-1', 'member-1', 'active',
          '{"codexSessionId":"codex-active"}',
          '2026-08-27T08:00:00.000Z', '2026-08-27T08:30:00.000Z',
          NULL, NULL, 'turn-active-loser', 4, '2026-08-27T08:30:00.000Z'
        );
      INSERT INTO leases (
        id, room_id, member_id, session_id, title, intent, mode, kind, status,
        decision, expires_at, created_at, updated_at, automatic_phase
      ) VALUES
        (
          'canonical-auto', 'room-1', 'member-1', 'session-finalizing',
          'Canonical automatic', '', 'write', 'automatic', 'active', 'allow',
          '2026-08-27T12:00:00.000Z', '2026-08-27T08:00:00.000Z', '2026-08-27T08:00:00.000Z',
          'working'
        ),
        (
          'duplicate-auto', 'room-1', 'member-1', 'session-newer',
          'Duplicate automatic', '', 'write', 'automatic', 'active', 'allow',
          '2026-08-27T12:00:00.000Z', '2026-08-27T08:30:00.000Z', '2026-08-27T08:30:00.000Z',
          'working'
        ),
        (
          'duplicate-finalizing-awaiting', 'room-1', 'member-1', 'session-newer',
          'Duplicate pending automatic', '', 'write', 'automatic', 'active', 'allow',
          '2026-08-27T12:00:00.000Z', '2026-08-27T08:30:00.000Z', '2026-08-27T08:30:00.000Z',
          'awaiting_commit'
        ),
        (
          'duplicate-standard', 'room-1', 'member-1', 'session-newer',
          'Duplicate manual', '', 'write', 'standard', 'active', 'allow',
          '2026-08-27T12:00:00.000Z', '2026-08-27T08:30:00.000Z', '2026-08-27T08:30:00.000Z',
          'working'
        ),
        (
          'preserved-active-awaiting', 'room-1', 'member-1', 'session-active-older',
          'Preserved pending automatic', '', 'write', 'automatic', 'active', 'allow',
          '2026-08-27T12:00:00.000Z', '2026-08-27T08:00:00.000Z', '2026-08-27T08:00:00.000Z',
          'awaiting_commit'
        );
      PRAGMA user_version = 4;
    `);
    legacy.close();

    const migrated = new AgentHubDatabase({ path: databasePath });
    expect(migrated.connection.prepare(`
      SELECT id, codex_session_id, status, closed_at, finalizing_at
      FROM work_sessions WHERE codex_session_id = 'codex-duplicate' ORDER BY id
    `).all()).toEqual([
      {
        id: "session-finalizing",
        codex_session_id: "codex-duplicate",
        status: "active",
        closed_at: null,
        finalizing_at: "2026-08-27T09:00:00.000Z",
      },
      {
        id: "session-newer",
        codex_session_id: "codex-duplicate",
        status: "active",
        closed_at: null,
        finalizing_at: null,
      },
    ]);
    expect(migrated.connection.prepare(`
      SELECT id, codex_session_id, status, closed_at, finalizing_at
      FROM work_sessions WHERE codex_session_id = 'codex-active' ORDER BY id
    `).all()).toEqual([
      {
        id: "session-active-newer",
        codex_session_id: "codex-active",
        status: "active",
        closed_at: null,
        finalizing_at: null,
      },
      {
        id: "session-active-older",
        codex_session_id: "codex-active",
        status: "closed",
        closed_at: "2026-08-27T08:30:00.000Z",
        finalizing_at: null,
      },
    ]);
    expect(migrated.connection.prepare(`
      SELECT id, session_id, status, automatic_phase, coordination_state, expires_at FROM leases ORDER BY id
    `).all()).toEqual([
      { id: "canonical-auto", session_id: "session-finalizing", status: "active", automatic_phase: "working", coordination_state: "working", expires_at: "2026-08-27T12:00:00.000Z" },
      { id: "duplicate-auto", session_id: "session-newer", status: "active", automatic_phase: "awaiting_commit", coordination_state: "awaiting_commit", expires_at: "2026-08-27T12:00:00.000Z" },
      { id: "duplicate-finalizing-awaiting", session_id: "session-newer", status: "cancelled", automatic_phase: "awaiting_commit", coordination_state: "awaiting_commit", expires_at: "2026-08-27T12:00:00.000Z" },
      { id: "duplicate-standard", session_id: "session-newer", status: "active", automatic_phase: "working", coordination_state: "working", expires_at: "2026-08-27T12:00:00.000Z" },
      { id: "preserved-active-awaiting", session_id: "session-active-older", status: "active", automatic_phase: "awaiting_commit", coordination_state: "awaiting_commit", expires_at: "2026-08-27T12:00:00.000Z" },
    ]);
    expect(migrated.connection.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_operations'
    `).get()).toEqual({ name: "session_operations" });
    expect(migrated.connection.prepare(`
      SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'sessions_codex_identity_idx'
    `).get()).toMatchObject({
      name: "sessions_codex_identity_idx",
      sql: expect.stringContaining("finalizing_at IS NULL"),
    });
    expect(migrated.connection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(migrated.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();

    const reopened = new AgentHubDatabase({ path: databasePath });
    expect(reopened.connection.prepare(`
      SELECT COUNT(*) AS count FROM work_sessions
      WHERE codex_session_id = 'codex-duplicate' AND closed_at IS NULL
    `).get()).toEqual({ count: 2 });
    expect(reopened.connection.prepare(`
      SELECT COUNT(*) AS count FROM work_sessions
      WHERE codex_session_id = 'codex-duplicate'
        AND closed_at IS NULL AND finalizing_at IS NULL
    `).get()).toEqual({ count: 1 });
    expect(reopened.connection.prepare(`
      SELECT COUNT(*) AS count FROM work_sessions
      WHERE codex_session_id = 'codex-active' AND closed_at IS NULL
    `).get()).toEqual({ count: 1 });
    expect(reopened.connection.prepare(`
      SELECT status FROM leases WHERE id = 'duplicate-standard'
    `).get()).toEqual({ status: "active" });
    expect(reopened.connection.prepare(`
      SELECT session_id, status FROM leases WHERE id = 'preserved-active-awaiting'
    `).get()).toEqual({ session_id: "session-active-older", status: "active" });
    expect(reopened.connection.prepare(`
      SELECT session_id, status, automatic_phase, coordination_state, expires_at
      FROM leases WHERE id = 'duplicate-auto'
    `).get()).toEqual({
      session_id: "session-newer",
      status: "active",
      automatic_phase: "awaiting_commit",
      coordination_state: "awaiting_commit",
      expires_at: "2026-08-27T12:00:00.000Z",
    });

    const service = new AgentHubService(reopened, {
      now: () => new Date("2026-08-27T11:30:00.000Z"),
    });
    expect(service.completeSessionActivity({
      memberToken,
      sessionId: "session-newer",
      operationId: "completion-finalizing-loser",
      turnId: "turn-finalizing-loser",
      activityEpoch: 7,
      outcome: "committed",
      leaseIds: ["duplicate-auto"],
      attributedPaths: ["src/finalizing-loser.ts"],
      baseCommit: "base-finalizing",
      headCommit: "head-finalizing",
    })).toMatchObject({
      result: "released",
      releasedLeaseIds: ["duplicate-auto"],
    });
    expect(service.completeSessionActivity({
      memberToken,
      sessionId: "session-active-older",
      operationId: "completion-active-loser",
      turnId: "turn-active-loser",
      activityEpoch: 4,
      outcome: "committed",
      leaseIds: ["preserved-active-awaiting"],
      attributedPaths: ["src/active-loser.ts"],
      baseCommit: "base-active",
      headCommit: "head-active",
    })).toMatchObject({
      result: "released",
      releasedLeaseIds: ["preserved-active-awaiting"],
    });
    expect(reopened.connection.prepare(`
      SELECT id, status FROM leases
      WHERE id IN ('duplicate-auto', 'duplicate-finalizing-awaiting', 'preserved-active-awaiting')
      ORDER BY id
    `).all()).toEqual([
      { id: "duplicate-auto", status: "cancelled" },
      { id: "duplicate-finalizing-awaiting", status: "cancelled" },
      { id: "preserved-active-awaiting", status: "cancelled" },
    ]);
    reopened.close();
  });

  it("adds lease session ownership to a legacy database without losing data", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-legacy-db-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "agent-hub.sqlite");
    const memberToken = "ahm_legacy_member_token";
    const tokenHash = createHash("sha256").update(memberToken, "utf8").digest("hex");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`PRAGMA foreign_keys = ON`);
    legacy.exec(`
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        project_name TEXT NOT NULL,
        repository TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('host', 'member')),
        client_name TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE leases (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        intent TEXT NOT NULL,
        branch TEXT,
        base_commit TEXT,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        decision TEXT NOT NULL,
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
      CREATE TABLE lease_paths (
        lease_id TEXT NOT NULL REFERENCES leases(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        path_key TEXT NOT NULL,
        risk TEXT NOT NULL CHECK (risk IN ('normal', 'high')),
        risk_reason TEXT,
        PRIMARY KEY (lease_id, path_key)
      );
      INSERT INTO rooms (
        id, code, name, project_name, repository, default_branch, created_at
      ) VALUES (
        'legacy-room', 'LEGACY01', 'Legacy team', 'Legacy project',
        'https://github.com/example/legacy.git', 'main', '2026-08-25T00:00:00.000Z'
      );
    `);
    legacy.prepare(`
      INSERT INTO members (
        id, room_id, name, role, client_name, token_hash, created_at, last_seen_at
      ) VALUES (?, 'legacy-room', 'Alice', 'host', 'Codex', ?, ?, ?)
    `).run(
      "legacy-member",
      tokenHash,
      "2026-08-25T00:00:00.000Z",
      "2026-08-25T00:00:00.000Z",
    );
    legacy.exec(`
      INSERT INTO leases (
        id, room_id, member_id, title, intent, mode, status, decision,
        expires_at, created_at, updated_at
      ) VALUES (
        'legacy-lease', 'legacy-room', 'legacy-member', 'Legacy scene work',
        'Keep the historical lease active', 'write', 'active', 'allow',
        '2099-01-01T00:00:00.000Z', '2026-08-25T00:00:00.000Z',
        '2026-08-25T00:00:00.000Z'
      );
      INSERT INTO lease_paths (lease_id, path, path_key, risk, risk_reason)
      VALUES (
        'legacy-lease', 'Assets/Scenes/Legacy.unity',
        'assets/scenes/legacy.unity', 'high',
        'Unity serialized resources require exclusive access.'
      );
    `);
    legacy.close();

    const database = new AgentHubDatabase({ path: databasePath });
    const columns = database.connection
      .prepare("PRAGMA table_info(leases)")
      .all() as Array<{ name: string }>;
    expect(columns.filter((column) => column.name === "session_id")).toHaveLength(1);
    expect(columns.filter((column) => column.name === "kind")).toHaveLength(1);
    expect(columns.filter((column) => column.name === "automatic_phase")).toHaveLength(1);
    expect(columns.filter((column) => column.name === "coordination_state")).toHaveLength(1);
    expect(columns.filter((column) => column.name === "managed_by")).toHaveLength(1);
    expect(columns.filter((column) => column.name === "created_via")).toHaveLength(1);
    expect(database.connection
      .prepare("SELECT id, session_id, kind, managed_by, created_via FROM leases WHERE id = 'legacy-lease'")
      .get()).toEqual({
        id: "legacy-lease",
        session_id: null,
        kind: "standard",
        managed_by: "manual",
        created_via: "legacy",
      });
    expect(database.connection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
    expect(database.connection.prepare(`
      SELECT blocking_protection_enabled, automatic_lease_ttl_minutes,
        maximum_exclusive_lease_minutes, risk_policy_version
      FROM rooms WHERE id = 'legacy-room'
    `).get()).toEqual({
      blocking_protection_enabled: 1,
      automatic_lease_ttl_minutes: 10,
      maximum_exclusive_lease_minutes: 1440,
      risk_policy_version: 1,
    });
    expect(database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'leases_session_idx'")
      .get()).toEqual({ name: "leases_session_idx" });
    const featureTables = database.connection
      .prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'feature_%'
        ORDER BY name
      `)
      .all() as Array<{ name: string }>;
    expect(featureTables.map((table) => table.name)).toEqual([
      "feature_change_confirmations",
      "feature_memories",
      "feature_revision_events",
      "feature_revision_targets",
      "feature_revisions",
    ]);
    expect(database.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    const service = new AgentHubService(database);
    expect(service.getDashboard(memberToken).leases).toEqual([
      expect.objectContaining({
        id: "legacy-lease",
        sessionId: null,
        kind: "standard",
        paths: [expect.objectContaining({ path: "Assets/Scenes/Legacy.unity", risk: "high" })],
      }),
    ]);
    expect(service.getRoomSettings(memberToken)).toMatchObject({
      blockingProtectionEnabled: true,
      automaticLeaseTtlMinutes: 10,
      maximumExclusiveLeaseMinutes: 1440,
      riskPolicyVersion: 1,
      riskRules: expect.arrayContaining([
        expect.objectContaining({ kind: "category", selector: "luban", level: "warning" }),
      ]),
    });
    const session = service.openSession({
      memberToken,
      clientName: "Agent Hub MCP",
      task: "New session",
      metadata: { source: "mcp" },
    });
    const overlapping = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "New session tries the legacy scene",
      paths: ["Assets/Scenes/Legacy.unity"],
      mode: "write",
    });
    expect(overlapping).toMatchObject({
      acquired: true,
      decision: "warn",
      lease: { sessionId: session.id, kind: "standard" },
    });
    expect(() => service.renewLease({
      memberToken,
      sessionId: session.id,
      leaseId: "legacy-lease",
    })).toThrow(expect.objectContaining({ code: "lease_session_mismatch", status: 409 }));
    expect(() => service.closeLease({
      memberToken,
      sessionId: session.id,
      leaseId: "legacy-lease",
      status: "cancelled",
    })).toThrow(expect.objectContaining({ code: "lease_session_mismatch", status: 409 }));

    expect(service.renewLease({ memberToken, leaseId: "legacy-lease" }).status).toBe("active");
    expect(service.closeLease({
      memberToken,
      leaseId: "legacy-lease",
      status: "completed",
      summary: "Legacy client completed its work.",
    }).lease.status).toBe("completed");
    database.close();

    const reopened = new AgentHubDatabase({ path: databasePath });
    const reopenedColumns = reopened.connection
      .prepare("PRAGMA table_info(leases)")
      .all() as Array<{ name: string }>;
    expect(reopenedColumns.filter((column) => column.name === "session_id")).toHaveLength(1);
    expect(reopened.connection
      .prepare("SELECT id, session_id, status FROM leases WHERE id = 'legacy-lease'")
      .get()).toEqual({ id: "legacy-lease", session_id: null, status: "completed" });
    expect(reopened.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    reopened.close();
  });
});
