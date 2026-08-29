import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const applicationDirectory = path.resolve(
  process.argv[2] ?? path.join(process.cwd(), "release", "win-unpacked"),
);
const executablePath = path.join(applicationDirectory, "Agent Hub.exe");
const serverEntryPath = path.join(
  applicationDirectory,
  "resources",
  "app.asar",
  "dist",
  "server",
  "index.js",
);
const probeRoot = mkdtempSync(path.join(tmpdir(), "agent-hub-packaged-db-"));
const results = [];

try {
  for (const testCase of [
    { name: "schema-2", schemaVersion: 2 },
    { name: "schema-3", schemaVersion: 3 },
    { name: "schema-3-failed-retry", schemaVersion: 3, failedUpgrade: true },
    { name: "schema-3-manual-repair", schemaVersion: 3, repaired: true },
    { name: "schema-4", schemaVersion: 4 },
    { name: "schema-5", schemaVersion: 5, legacyDecision: true },
    { name: "schema-6-pre-decision-supersession", schemaVersion: 6, legacyDecision: true },
  ]) {
    const dataDirectory = path.join(probeRoot, testCase.name);
    const databasePath = path.join(dataDirectory, "agent-hub.sqlite");
    createHistoricalFixture(
      databasePath,
      testCase.schemaVersion,
      testCase.repaired === true,
      testCase.legacyDecision === true,
    );
    if (testCase.failedUpgrade) simulateFailedUpgrade(databasePath);

    // 两次启动分别验证升级和已迁移 schema 6 的幂等重开。
    await startAndStopPackagedService(dataDirectory);
    validateMigratedDatabase(
      databasePath,
      testCase.schemaVersion,
      testCase.repaired === true,
      testCase.legacyDecision === true,
    );
    await startAndStopPackagedService(dataDirectory);
    validateMigratedDatabase(
      databasePath,
      testCase.schemaVersion,
      testCase.repaired === true,
      testCase.legacyDecision === true,
    );
    results.push({ name: testCase.name, status: "ok", reopened: true });
  }

  const newDataDirectory = path.join(probeRoot, "new-schema-6");
  const newDatabasePath = path.join(newDataDirectory, "agent-hub.sqlite");
  await startAndStopPackagedService(newDataDirectory);
  validateNewDatabase(newDatabasePath);
  await startAndStopPackagedService(newDataDirectory);
  validateNewDatabase(newDatabasePath);
  results.push({ name: "new-schema-6", status: "ok", reopened: true });

  process.stdout.write(`${JSON.stringify({ status: "ok", version: "0.2.8", results })}\n`);
} finally {
  rmSync(probeRoot, { recursive: true, force: true });
}

function createHistoricalFixture(databasePath, schemaVersion, repaired, legacyDecision) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  const prefix = `schema${schemaVersion}`;
  const roomColumns = schemaVersion === 2 ? "" : `,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dissolved')),
    auto_lock_after_auto_claim INTEGER NOT NULL DEFAULT 1,
    blocking_protection_enabled INTEGER NOT NULL DEFAULT 1,
    automatic_lease_ttl_minutes INTEGER NOT NULL DEFAULT 10,
    maximum_exclusive_lease_minutes INTEGER NOT NULL DEFAULT 1440,
    risk_policy_version INTEGER NOT NULL DEFAULT 1,
    risk_policy_rules_json TEXT NOT NULL DEFAULT '[]',
    settings_updated_at TEXT, settings_updated_by TEXT, dissolved_at TEXT`;
  const memberColumns = schemaVersion === 2 ? "" : `,
    is_admin INTEGER NOT NULL DEFAULT 0, removed_at TEXT,
    client_version TEXT, protocol_version INTEGER, schema_version INTEGER`;
  const sessionColumns = schemaVersion === 2 ? "" : `,
    branch_epoch INTEGER NOT NULL DEFAULT 1, frozen_reason TEXT`;
  const sessionCompatibilityColumns = schemaVersion === 2 ? "" : `,
    client_version TEXT, protocol_version INTEGER, schema_version INTEGER`;
  const leaseKindColumn = schemaVersion === 2 ? "" : `,
    kind TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('automatic', 'standard', 'exclusive'))`;
  const automaticPhaseColumn = schemaVersion >= 4 ? `,
    automatic_phase TEXT NOT NULL DEFAULT 'working' CHECK (automatic_phase IN ('working', 'awaiting_commit'))` : "";
  const coordinationStateColumn = schemaVersion >= 5 ? `,
    coordination_state TEXT NOT NULL DEFAULT 'working' CHECK (coordination_state IN ('working', 'waiting', 'blocked', 'awaiting_commit'))` : "";
  const sessionLifecycleColumns = schemaVersion >= 4 ? `,
    finalization_id TEXT, finalizing_at TEXT, finalization_error TEXT,
    codex_session_id TEXT, current_turn_id TEXT,
    activity_epoch INTEGER NOT NULL DEFAULT 0, turn_stopped_at TEXT` : "";
  const hasFinalizationColumn = schemaVersion >= 4 || repaired;
  const finalizationColumn = hasFinalizationColumn ? ", finalization_id TEXT" : "";
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL, project_name TEXT NOT NULL, repository TEXT NOT NULL,
      default_branch TEXT NOT NULL, created_at TEXT NOT NULL${roomColumns}
    );
    CREATE TABLE members (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('host', 'member')),
      client_name TEXT, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL${memberColumns}
    );
    CREATE TABLE work_sessions (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      client_name TEXT, agent_name TEXT, repository TEXT, branch TEXT, worktree TEXT,
      base_commit TEXT, task TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', ${schemaVersion === 2 ? "" : "'frozen', "}'closed'))${sessionColumns},
      metadata_json TEXT NOT NULL, opened_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      closed_at TEXT${sessionCompatibilityColumns}${sessionLifecycleColumns}
    );
    CREATE TABLE leases (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES work_sessions(id) ON DELETE SET NULL,
      title TEXT NOT NULL, intent TEXT NOT NULL, branch TEXT, base_commit TEXT,
      mode TEXT NOT NULL CHECK (mode IN ('read', 'write'))${leaseKindColumn},
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled', 'expired')),
      decision TEXT NOT NULL CHECK (decision IN ('allow', 'warn', 'deny')),
      override_reason TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, completed_at TEXT, completion_summary TEXT, outcome TEXT,
      changed_paths_json TEXT NOT NULL DEFAULT '[]', commit_hash TEXT,
      validations_json TEXT NOT NULL DEFAULT '[]', remaining_risks_json TEXT NOT NULL DEFAULT '[]',
      handoff TEXT${automaticPhaseColumn}${coordinationStateColumn}
    );
    CREATE TABLE local_scans (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      repository TEXT, branch TEXT, worktree TEXT, base_commit TEXT,
      changed_paths_json TEXT NOT NULL, rule_files_json TEXT NOT NULL,
      systems_json TEXT NOT NULL, metadata_json TEXT NOT NULL,
      scanned_at TEXT NOT NULL${finalizationColumn}
    );
    ${legacyDecision ? `
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      author_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      title TEXT NOT NULL, decision TEXT NOT NULL, rationale TEXT,
      paths_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE records (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('decision', 'validation', 'handoff', 'risk')),
      title TEXT NOT NULL, summary TEXT NOT NULL, paths_json TEXT NOT NULL,
      status TEXT NOT NULL, evidence_json TEXT NOT NULL, commit_hash TEXT,
      created_at TEXT NOT NULL
    );` : ""}
    INSERT INTO rooms (id, code, name, project_name, repository, default_branch, created_at)
    VALUES ('${prefix}-room', 'PACKAGED${schemaVersion}', 'Packaged room', 'Packaged project',
      'C:/packaged/repo', 'main', '2026-08-20T08:00:00.000Z');
    INSERT INTO members (id, room_id, name, role, client_name, token_hash, created_at, last_seen_at)
    VALUES ('${prefix}-member', '${prefix}-room', 'Alice', 'host', 'Codex',
      'packaged-token-${schemaVersion}', '2026-08-20T08:00:00.000Z', '2026-08-20T09:00:00.000Z');
    ${legacyDecision ? `
    INSERT INTO decisions (
      id, room_id, author_member_id, title, decision, rationale, paths_json, created_at
    ) VALUES (
      '${prefix}-decision', '${prefix}-room', '${prefix}-member',
      'Preserve packaged decision', 'Keep the historical packaged behavior.',
      'This decision predates decision supersession.', '["src/packaged.ts"]',
      '2026-08-20T08:05:00.000Z'
    );
    INSERT INTO records (
      id, room_id, member_id, kind, title, summary, paths_json, status,
      evidence_json, commit_hash, created_at
    ) VALUES (
      '${prefix}-decision-record', '${prefix}-room', '${prefix}-member', 'decision',
      'Preserve packaged decision', 'Keep the historical packaged behavior.',
      '["src/packaged.ts"]', 'accepted',
      '["This decision predates decision supersession."]', NULL,
      '2026-08-20T08:05:00.000Z'
    );` : ""}
    INSERT INTO work_sessions (
      id, room_id, member_id, client_name, agent_name, repository, branch, worktree,
      base_commit, task, status, metadata_json, opened_at, last_seen_at
    ) VALUES ('${prefix}-session', '${prefix}-room', '${prefix}-member', 'Codex', 'Codex',
      'C:/packaged/repo', 'main', 'C:/packaged/repo', 'base-${schemaVersion}',
      'Preserve packaged fixture', 'active', '{"source":"packaged-${schemaVersion}"}',
      '2026-08-20T08:10:00.000Z', '2026-08-20T09:00:00.000Z');
    ${schemaVersion === 4 ? `
    UPDATE work_sessions SET
      metadata_json = '{"source":"packaged-schema4-finalizing","codexSessionId":"packaged-schema4-reopened"}',
      finalization_id = 'packaged-schema4-finalization',
      finalizing_at = '2026-08-20T09:00:00.000Z',
      codex_session_id = 'packaged-schema4-reopened',
      current_turn_id = 'packaged-schema4-old-turn',
      activity_epoch = 3
    WHERE id = 'schema4-session';
    INSERT INTO work_sessions (
      id, room_id, member_id, client_name, agent_name, repository, branch, worktree,
      base_commit, task, status, metadata_json, opened_at, last_seen_at,
      codex_session_id, current_turn_id, activity_epoch
    ) VALUES (
      'schema4-session-reopened', 'schema4-room', 'schema4-member', 'Codex', 'Codex',
      'C:/packaged/repo', 'main', 'C:/packaged/repo', 'base-4-reopened',
      'Preserve reopened packaged generation', 'active',
      '{"source":"packaged-schema4-reopened","codexSessionId":"packaged-schema4-reopened"}',
      '2026-08-20T09:01:00.000Z', '2026-08-20T09:02:00.000Z',
      'packaged-schema4-reopened', 'packaged-schema4-new-turn', 0
    );` : ""}
    INSERT INTO leases (
      id, room_id, member_id, session_id, title, intent, branch, base_commit, mode,
      ${schemaVersion === 2 ? "" : "kind, "}status, decision, expires_at, created_at, updated_at,
      changed_paths_json${schemaVersion >= 4 ? ", automatic_phase" : ""}${schemaVersion >= 5 ? ", coordination_state" : ""}
    ) VALUES ('${prefix}-lease', '${prefix}-room', '${prefix}-member', '${prefix}-session',
      'Packaged lease', 'Preserve packaged lease', 'main', 'base-${schemaVersion}', 'write',
      ${schemaVersion === 2 ? "" : "'automatic', "}'active', 'allow', '2099-01-01T00:00:00.000Z',
      '2026-08-20T08:15:00.000Z', '2026-08-20T09:00:00.000Z', '["src/packaged.ts"]'
      ${schemaVersion >= 4 ? ", 'awaiting_commit'" : ""}${schemaVersion >= 5 ? ", 'awaiting_commit'" : ""});
    INSERT INTO local_scans (
      id, session_id, room_id, member_id, repository, branch, worktree, base_commit,
      changed_paths_json, rule_files_json, systems_json, metadata_json, scanned_at
      ${hasFinalizationColumn ? ", finalization_id" : ""}
    ) VALUES ('${prefix}-scan', '${prefix}-session', '${prefix}-room', '${prefix}-member',
      'C:/packaged/repo', 'main', 'C:/packaged/repo', 'base-${schemaVersion}',
      '["src/packaged.ts"]', '[]', '["packaged-system"]', '{"preserved":true}',
      '2026-08-20T09:00:00.000Z'${hasFinalizationColumn ? `, '${repaired ? "packaged-manual-repair" : `packaged-schema${schemaVersion}`}'` : ""});
    PRAGMA user_version = ${schemaVersion};
  `);
  database.close();
}

function simulateFailedUpgrade(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`CREATE UNIQUE INDEX scans_finalization_idx
      ON local_scans(finalization_id) WHERE finalization_id IS NOT NULL`);
    throw new Error("The historical v0.2.3 index statement unexpectedly succeeded.");
  } catch (error) {
    if (!String(error).includes("no such column: finalization_id")) throw error;
    database.exec("ROLLBACK");
  }
  database.close();
}

async function startAndStopPackagedService(dataDirectory) {
  const port = await reservePort();
  let output = "";
  const child = spawn(executablePath, [serverEntryPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      AGENT_HUB_DATA_DIR: dataDirectory,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Packaged service exited early: ${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        const health = await response.json();
        if (
          response.ok
          && health.status === "ok"
          && health.version === "0.2.8"
          && health.schemaVersion === 6
          && health.database?.status === "ok"
        ) return;
      } catch {
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Packaged service health timed out: ${output}`);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
}

function validateMigratedDatabase(databasePath, sourceSchemaVersion, repaired, legacyDecision) {
  const prefix = `schema${sourceSchemaVersion}`;
  const database = new DatabaseSync(databasePath);
  assertEqual(database.prepare("PRAGMA user_version").get().user_version, 6, "user_version");
  assertEqual(
    database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('local_scans') WHERE name = 'finalization_id'").get().count,
    1,
    "finalization_id column count",
  );
  assertEqual(
    database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'scans_finalization_idx'").get().count,
    1,
    "scans_finalization_idx count",
  );
  assertEqual(
    database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('leases') WHERE name = 'coordination_state'").get().count,
    1,
    "coordination_state column count",
  );
  assertEqual(
    database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('leases') WHERE name = 'managed_by'").get().count,
    1,
    "managed_by column count",
  );
  assertEqual(
    database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('leases') WHERE name = 'created_via'").get().count,
    1,
    "created_via column count",
  );
  for (const [table, id] of [
    ["rooms", `${prefix}-room`],
    ["members", `${prefix}-member`],
    ["work_sessions", `${prefix}-session`],
    ["leases", `${prefix}-lease`],
  ]) {
    assertEqual(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE id = ?`).get(id).count, 1, `${table} count`);
  }
  const scan = database.prepare("SELECT metadata_json, finalization_id FROM local_scans WHERE id = ?").get(`${prefix}-scan`);
  assertEqual(scan.metadata_json, '{"preserved":true}', "scan metadata");
  assertEqual(
    scan.finalization_id,
    repaired ? "packaged-manual-repair" : sourceSchemaVersion >= 4 ? `packaged-schema${sourceSchemaVersion}` : null,
    "scan finalization_id",
  );
  const lease = database.prepare("SELECT automatic_phase, coordination_state, managed_by, created_via FROM leases WHERE id = ?").get(`${prefix}-lease`);
  assertEqual(lease.automatic_phase, sourceSchemaVersion >= 4 ? "awaiting_commit" : "working", "automatic_phase");
  assertEqual(lease.coordination_state, sourceSchemaVersion >= 4 ? "awaiting_commit" : "working", "coordination_state");
  assertEqual(lease.managed_by, sourceSchemaVersion === 2 ? "manual" : "agent", "managed_by");
  assertEqual(lease.created_via, "legacy", "created_via");
  assertAgentLeaseIndex(database);
  assertCodexIdentityIndex(database);
  assertDecisionSupersessionSchema(database);
  if (legacyDecision) {
    const decision = database.prepare(`
      SELECT title, decision, rationale, paths_json, status, supersedes_decision_id
      FROM decisions WHERE id = ?
    `).get(`${prefix}-decision`);
    assertEqual(
      JSON.stringify(decision),
      JSON.stringify({
        title: "Preserve packaged decision",
        decision: "Keep the historical packaged behavior.",
        rationale: "This decision predates decision supersession.",
        paths_json: '["src/packaged.ts"]',
        status: "current",
        supersedes_decision_id: null,
      }),
      "legacy decision migration",
    );
    const record = database.prepare(`
      SELECT id, status FROM records
      WHERE room_id = ? AND kind = 'decision' AND title = 'Preserve packaged decision'
    `).get(`${prefix}-room`);
    assertEqual(
      JSON.stringify(record),
      JSON.stringify({ id: `${prefix}-decision`, status: "current" }),
      "legacy decision record projection migration",
    );
  }
  if (sourceSchemaVersion === 4) {
    const generations = database.prepare(`
      SELECT id, status, closed_at, finalizing_at, finalization_id, current_turn_id
      FROM work_sessions
      WHERE room_id = 'schema4-room' AND member_id = 'schema4-member'
        AND codex_session_id = 'packaged-schema4-reopened'
      ORDER BY opened_at, id
    `).all();
    assertEqual(generations.length, 2, "schema 4 reopened generation count");
    assertEqual(
      JSON.stringify(generations),
      JSON.stringify([
        {
          id: "schema4-session",
          status: "active",
          closed_at: null,
          finalizing_at: "2026-08-20T09:00:00.000Z",
          finalization_id: "packaged-schema4-finalization",
          current_turn_id: "packaged-schema4-old-turn",
        },
        {
          id: "schema4-session-reopened",
          status: "active",
          closed_at: null,
          finalizing_at: null,
          finalization_id: null,
          current_turn_id: "packaged-schema4-new-turn",
        },
      ]),
      "schema 4 reopened generations",
    );
    assertEqual(
      database.prepare(`
        SELECT COUNT(*) AS count FROM work_sessions
        WHERE room_id = 'schema4-room' AND member_id = 'schema4-member'
          AND codex_session_id = 'packaged-schema4-reopened'
          AND closed_at IS NULL AND finalizing_at IS NULL
      `).get().count,
      1,
      "schema 4 active generation count",
    );
  }
  assertEqual(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok", "integrity_check");
  assertEqual(database.prepare("PRAGMA foreign_key_check").all().length, 0, "foreign_key_check");
  database.close();
}

function validateNewDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  assertEqual(database.prepare("PRAGMA user_version").get().user_version, 6, "new user_version");
  assertCodexIdentityIndex(database);
  assertAgentLeaseIndex(database);
  assertDecisionSupersessionSchema(database);
  assertEqual(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok", "new integrity_check");
  assertEqual(database.prepare("PRAGMA foreign_key_check").all().length, 0, "new foreign_key_check");
  database.close();
}

function assertCodexIdentityIndex(database) {
  const indexName = "sessions_codex_identity_idx";
  const index = database.prepare("PRAGMA index_list('work_sessions')").all()
    .find((candidate) => candidate.name === indexName);
  assertEqual(index?.unique, 1, `${indexName} unique flag`);
  assertEqual(index?.partial, 1, `${indexName} partial flag`);
  const columns = database.prepare(`PRAGMA index_info('${indexName}')`).all()
    .map((column) => column.name)
    .join(",");
  assertEqual(columns, "room_id,member_id,codex_session_id", `${indexName} columns`);

  const definition = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?
  `).get(indexName)?.sql;
  const predicate = typeof definition === "string"
    ? definition.split(/\bWHERE\b/i).slice(1).join(" WHERE ").replace(/\s+/g, " ").trim().toLowerCase()
    : "";
  assertEqual(
    predicate,
    "codex_session_id is not null and closed_at is null and finalizing_at is null",
    `${indexName} predicate`,
  );
}

function assertAgentLeaseIndex(database) {
  const indexName = "leases_active_agent_session_idx";
  const index = database.prepare("PRAGMA index_list('leases')").all()
    .find((candidate) => candidate.name === indexName);
  assertEqual(index?.unique, 1, `${indexName} unique flag`);
  assertEqual(index?.partial, 1, `${indexName} partial flag`);
  const columns = database.prepare(`PRAGMA index_info('${indexName}')`).all()
    .map((column) => column.name)
    .join(",");
  assertEqual(columns, "room_id,member_id,session_id", `${indexName} columns`);
  const definition = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?
  `).get(indexName)?.sql;
  const predicate = typeof definition === "string"
    ? definition.split(/\bWHERE\b/i).slice(1).join(" WHERE ").replace(/\s+/g, " ").trim().toLowerCase()
    : "";
  assertEqual(
    predicate,
    "status = 'active' and managed_by = 'agent' and session_id is not null",
    `${indexName} predicate`,
  );
}

function assertDecisionSupersessionSchema(database) {
  const tableColumns = database.prepare("PRAGMA table_info('decisions')").all();
  const statusColumn = tableColumns.find((column) => column.name === "status");
  assertEqual(statusColumn?.type, "TEXT", "decision status column type");
  assertEqual(statusColumn?.notnull, 1, "decision status not-null flag");
  assertEqual(statusColumn?.dflt_value, "'current'", "decision status default");
  const supersedesColumn = tableColumns.find(
    (column) => column.name === "supersedes_decision_id",
  );
  assertEqual(
    supersedesColumn?.type,
    "TEXT",
    "decision supersedes_decision_id column type",
  );

  const indexName = "decisions_single_successor_idx";
  const index = database.prepare("PRAGMA index_list('decisions')").all()
    .find((candidate) => candidate.name === indexName);
  assertEqual(index?.unique, 1, `${indexName} unique flag`);
  assertEqual(index?.partial, 1, `${indexName} partial flag`);
  const columns = database.prepare(`PRAGMA index_info('${indexName}')`).all()
    .map((column) => column.name)
    .join(",");
  assertEqual(columns, "supersedes_decision_id", `${indexName} columns`);
  const definition = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?
  `).get(indexName)?.sql;
  const predicate = typeof definition === "string"
    ? definition.split(/\bWHERE\b/i).slice(1).join(" WHERE ").replace(/\s+/g, " ").trim().toLowerCase()
    : "";
  assertEqual(
    predicate,
    "supersedes_decision_id is not null",
    `${indexName} predicate`,
  );
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not reserve a local probe port.");
  return port;
}
