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
