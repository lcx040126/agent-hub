import { afterEach, describe, expect, it } from "vitest";
import { AgentHubDatabase } from "./db.js";
import {
  cleanupActivities,
  startActivityRetentionScheduler,
} from "./activity-retention.js";

const databases: AgentHubDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = new AgentHubDatabase({ path: ":memory:" });
  databases.push(database);
  const now = "2026-08-31T00:00:00.000Z";
  for (const room of ["room-a", "room-b"]) {
    database.connection.prepare(`
      INSERT INTO rooms (id, code, name, project_name, repository, default_branch, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(room, room.toUpperCase(), room, "Project", `C:/${room}`, "main", now);
    database.connection.prepare(`
      INSERT INTO members (id, room_id, name, role, token_hash, created_at, last_seen_at)
      VALUES (?, ?, 'Member', 'member', ?, ?, ?)
    `).run(`${room}-member`, room, `${room}-token`, now, now);
  }
  database.connection.prepare(`
    INSERT INTO work_sessions (id, room_id, member_id, status, metadata_json, opened_at, last_seen_at, closed_at)
    VALUES ('active-session', 'room-a', 'room-a-member', 'active', '{"source":"test"}', ?, ?, NULL)
  `).run(now, now);
  database.connection.prepare(`
    INSERT INTO work_sessions (id, room_id, member_id, status, metadata_json, opened_at, last_seen_at, closed_at)
    VALUES ('closed-session', 'room-a', 'room-a-member', 'closed', '{"source":"test"}', ?, ?, ?)
  `).run(now, now, now);
  database.connection.prepare(`
    INSERT INTO leases (
      id, room_id, member_id, session_id, title, intent, mode, kind, managed_by, created_via,
      status, decision, expires_at, created_at, updated_at
    ) VALUES ('ended-lease', 'room-a', 'room-a-member', 'closed-session', 'Ended', 'Test', 'write', 'automatic', 'agent', 'hook', 'completed', 'allow', ?, ?, ?)
  `).run(now, now, now);
  database.connection.prepare(`
    INSERT INTO leases (
      id, room_id, member_id, session_id, title, intent, mode, kind, managed_by, created_via,
      status, decision, expires_at, created_at, updated_at
    ) VALUES ('active-lease', 'room-a', 'room-a-member', 'active-session', 'Active', 'Test', 'write', 'automatic', 'agent', 'hook', 'active', 'allow', ?, ?, ?)
  `).run("2099-01-01T00:00:00.000Z", now, now);
  return { database, now };
}

function activity(
  database: AgentHubDatabase,
  values: { id: string; roomId?: string; type: string; entityType: string; entityId?: string | null; createdAt: string; metadata?: string },
) {
  database.connection.prepare(`
    INSERT INTO activities (id, room_id, actor_member_id, actor_name, type, entity_type, entity_id, summary, metadata_json, created_at)
    VALUES (?, ?, NULL, NULL, ?, ?, ?, 'test', ?, ?)
  `).run(
    values.id,
    values.roomId ?? "room-a",
    values.type,
    values.entityType,
    values.entityId ?? null,
    values.metadata ?? "{}",
    values.createdAt,
  );
}

describe("activity retention", () => {
  it("deletes only expired low-value rows and keeps protected or high-value activity", () => {
    const { database, now } = fixture();
    activity(database, { id: "old-scan", type: "scan.recorded", entityType: "local_scan", createdAt: "2026-07-01T00:00:00.000Z" });
    activity(database, { id: "recent-scan", type: "scan.recorded", entityType: "local_scan", createdAt: "2026-08-10T00:00:00.000Z" });
    activity(database, { id: "active-scan", type: "scan.recorded", entityType: "local_scan", createdAt: "2026-07-01T00:00:00.000Z", metadata: '{"sessionId":"active-session"}' });
    activity(database, { id: "old-empty", type: "lease.scope_observed", entityType: "session", entityId: "closed-session", createdAt: "2026-07-01T00:00:00.000Z" });
    activity(database, { id: "active-empty", type: "lease.scope_observed", entityType: "session", entityId: "active-session", createdAt: "2026-07-01T00:00:00.000Z" });
    activity(database, { id: "ended-scope", type: "lease.scope_expanded", entityType: "lease", entityId: "ended-lease", createdAt: "2026-05-01T00:00:00.000Z" });
    activity(database, { id: "active-scope", type: "lease.scope_expanded", entityType: "lease", entityId: "active-lease", createdAt: "2026-05-01T00:00:00.000Z" });
    activity(database, { id: "old-decision", type: "decision.created", entityType: "decision", createdAt: "2020-01-01T00:00:00.000Z" });
    activity(database, { id: "other-room", roomId: "room-b", type: "scan.recorded", entityType: "local_scan", createdAt: "2026-07-01T00:00:00.000Z" });

    const report = cleanupActivities(database, { now: () => new Date(now), batchSize: 2 });
    expect(report.deleted).toBe(4);
    expect(report.stats).toEqual(expect.arrayContaining([
      expect.objectContaining({ roomId: "room-a", activityType: "scan.recorded", deleted: 1 }),
      expect.objectContaining({ roomId: "room-a", activityType: "lease.scope_observed", deleted: 1 }),
      expect.objectContaining({ roomId: "room-a", activityType: "lease.scope_expanded", deleted: 1 }),
    ]));
    const remaining = database.connection.prepare("SELECT id FROM activities ORDER BY id").all() as Array<{ id: string }>;
    expect(remaining.map((row) => row.id)).toEqual(expect.arrayContaining([
      "recent-scan", "active-scan", "active-empty", "active-scope", "old-decision",
    ]));
    expect(remaining.map((row) => row.id)).not.toContain("other-room");
    expect(remaining.map((row) => row.id)).not.toContain("old-scan");
    expect(cleanupActivities(database, { now: () => new Date(now) }).deleted).toBe(0);
  });

  it("does not delete a scan linked to a pending release request", () => {
    const { database, now } = fixture();
    database.connection.prepare(`
      INSERT INTO release_requests (
        id, room_id, requester_member_id, conflicting_lease_id, request_title, requested_kind,
        requested_mode, requested_paths_json, overlap_paths_json, reason, transfer_key, dedupe_key,
        status, requested_at, last_requested_at
      ) VALUES ('pending-request', 'room-a', 'room-a-member', 'active-lease', 'Request', 'standard',
        'write', '[]', '[]', 'Test', 'transfer', 'dedupe', 'pending', ?, ?)
    `).run(now, now);
    activity(database, { id: "pending-activity", type: "scan.recorded", entityType: "release_request", entityId: "pending-request", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(cleanupActivities(database, { now: () => new Date(now) }).deleted).toBe(0);
  });

  it("runs immediately, prevents overlap, and can be stopped", async () => {
    const { database, now } = fixture();
    activity(database, { id: "scheduler-scan", type: "scan.recorded", entityType: "local_scan", createdAt: "2026-01-01T00:00:00.000Z" });
    const reports: number[] = [];
    const scheduler = startActivityRetentionScheduler({
      database,
      intervalMs: 10,
      now: () => new Date(now),
      onReport: (report) => reports.push(report.deleted),
    });
    await scheduler.runNow();
    expect(reports[0]).toBe(1);
    await scheduler.stop();
    expect(reports.length).toBeGreaterThanOrEqual(1);
  });
});
