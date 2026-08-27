import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHubDatabase } from "./db.js";
import { AgentHubService } from "./service.js";

const temporaryDirectories: string[] = [];

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
    future.exec("PRAGMA user_version = 5");
    future.close();
    expect(() => new AgentHubDatabase({ path: databasePath })).toThrow(
      /newer than supported schema 4/,
    );
  });

  it("backfills and canonicalizes duplicate Codex sessions in an older schema 4 database", () => {
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
        status: "closed",
        closed_at: "2026-08-27T10:00:00.000Z",
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
      SELECT id, session_id, status, automatic_phase, expires_at FROM leases ORDER BY id
    `).all()).toEqual([
      { id: "canonical-auto", session_id: "session-finalizing", status: "active", automatic_phase: "working", expires_at: "2026-08-27T12:00:00.000Z" },
      { id: "duplicate-auto", session_id: "session-newer", status: "cancelled", automatic_phase: "working", expires_at: "2026-08-27T12:00:00.000Z" },
      { id: "duplicate-finalizing-awaiting", session_id: "session-newer", status: "active", automatic_phase: "awaiting_commit", expires_at: "2026-08-27T12:00:00.000Z" },
      { id: "duplicate-standard", session_id: "session-newer", status: "active", automatic_phase: "working", expires_at: "2026-08-27T12:00:00.000Z" },
      { id: "preserved-active-awaiting", session_id: "session-active-older", status: "active", automatic_phase: "awaiting_commit", expires_at: "2026-08-27T12:00:00.000Z" },
    ]);
    expect(migrated.connection.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_operations'
    `).get()).toEqual({ name: "session_operations" });
    expect(migrated.connection.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'sessions_codex_identity_idx'
    `).get()).toEqual({ name: "sessions_codex_identity_idx" });
    expect(migrated.connection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(migrated.connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();

    const reopened = new AgentHubDatabase({ path: databasePath });
    expect(reopened.connection.prepare(`
      SELECT COUNT(*) AS count FROM work_sessions
      WHERE codex_session_id = 'codex-duplicate' AND closed_at IS NULL
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
      SELECT session_id, status, automatic_phase, expires_at
      FROM leases WHERE id = 'duplicate-finalizing-awaiting'
    `).get()).toEqual({
      session_id: "session-newer",
      status: "active",
      automatic_phase: "awaiting_commit",
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
      leaseIds: ["duplicate-finalizing-awaiting"],
      attributedPaths: ["src/finalizing-loser.ts"],
      baseCommit: "base-finalizing",
      headCommit: "head-finalizing",
    })).toMatchObject({
      result: "released",
      releasedLeaseIds: ["duplicate-finalizing-awaiting"],
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
      WHERE id IN ('duplicate-finalizing-awaiting', 'preserved-active-awaiting')
      ORDER BY id
    `).all()).toEqual([
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
    expect(database.connection
      .prepare("SELECT id, session_id, kind FROM leases WHERE id = 'legacy-lease'")
      .get()).toEqual({ id: "legacy-lease", session_id: null, kind: "standard" });
    expect(database.connection.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
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
