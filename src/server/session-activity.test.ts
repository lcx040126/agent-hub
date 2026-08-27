import { describe, expect, it } from "vitest";
import { AgentHubDatabase } from "./db.js";
import { AgentHubService } from "./service.js";

describe("Codex turn activity fencing", () => {
  it("reuses the Codex session and makes retries and stale completions harmless", () => {
    const { database, service, memberToken } = testService();
    const session = service.openSession({
      memberToken,
      codexSessionId: "codex-session-1",
      turnId: "turn-0",
      activityEpoch: 0,
      branch: "main",
      baseCommit: "base-0",
    });
    const reused = service.openSession({
      memberToken,
      codexSessionId: "codex-session-1",
      turnId: "turn-0",
      activityEpoch: 0,
      metadata: { source: "SessionStart-resume" },
    });
    expect(reused).toMatchObject({
      id: session.id,
      codexSessionId: "codex-session-1",
      currentTurnId: "turn-0",
      activityEpoch: 0,
    });

    const automatic = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Automatic source edit",
      paths: ["src/automatic.ts"],
      kind: "automatic",
    });
    const standard = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Manual standard scope",
      paths: ["src/manual-standard.ts"],
      kind: "standard",
    });
    const exclusive = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Manual exclusive scope",
      paths: ["src/manual-exclusive.ts"],
      kind: "exclusive",
      ttlMinutes: 30,
    });
    if (!automatic.acquired || !standard.acquired || !exclusive.acquired) {
      throw new Error("Test leases were not acquired.");
    }
    const manualBefore = new Map(
      [standard.lease, exclusive.lease].map((lease) => [lease.id, lease.expiresAt]),
    );

    const stopped = service.stopSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "stop-0",
      turnId: "turn-0",
      activityEpoch: 0,
    });
    expect(stopped).toMatchObject({
      result: "awaiting_commit",
      session: { currentTurnId: "turn-0", activityEpoch: 0 },
    });
    expect(stopped.session.turnStoppedAt).not.toBeNull();
    expect(service.getDashboard(memberToken).leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: automatic.lease.id, phase: "awaiting_commit" }),
      expect.objectContaining({ id: standard.lease.id, status: "active", phase: undefined }),
      expect.objectContaining({ id: exclusive.lease.id, status: "active", phase: undefined }),
    ]));
    const reusedWhileStopped = service.openSession({
      memberToken,
      codexSessionId: "codex-session-1",
      turnId: "turn-0",
      activityEpoch: 0,
    });
    expect(reusedWhileStopped.turnStoppedAt).toBe(stopped.session.turnStoppedAt);
    expect(service.getDashboard(memberToken).leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: automatic.lease.id, phase: "awaiting_commit" }),
    ]));

    expect(service.stopSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "stop-0",
      turnId: "turn-0",
      activityEpoch: 0,
    })).toMatchObject({
      result: "already_applied",
      previousResult: "awaiting_commit",
    });

    const resumed = service.resumeSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "resume-1",
      turnId: "turn-1",
      activityEpoch: 1,
    });
    expect(resumed).toMatchObject({
      result: "resumed",
      session: { currentTurnId: "turn-1", activityEpoch: 1, turnStoppedAt: null },
    });
    expect(service.completeSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "stop-0",
      turnId: "turn-0",
      activityEpoch: 0,
      outcome: "committed",
      baseCommit: "base-0",
      headCommit: "commit-0",
    })).toMatchObject({ result: "superseded", releasedLeaseIds: [] });
    expect(service.getDashboard(memberToken).leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: automatic.lease.id, phase: "working", status: "active" }),
    ]));

    service.stopSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "turn-operation-1",
      turnId: "turn-1",
      activityEpoch: 1,
    });
    const completed = service.completeSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "turn-operation-1",
      turnId: "turn-1",
      activityEpoch: 1,
      outcome: "committed",
      leaseIds: [automatic.lease.id, standard.lease.id, exclusive.lease.id],
      attributedPaths: ["src/automatic.ts"],
      baseCommit: "base-0",
      headCommit: "commit-1",
    });
    expect(completed).toMatchObject({
      result: "released",
      releasedLeaseIds: [automatic.lease.id],
    });
    expect(service.completeSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "turn-operation-1",
      turnId: "turn-1",
      activityEpoch: 1,
      outcome: "committed",
      leaseIds: [automatic.lease.id, standard.lease.id, exclusive.lease.id],
      attributedPaths: ["src/automatic.ts"],
      baseCommit: "base-0",
      headCommit: "commit-1",
    })).toMatchObject({
      result: "already_applied",
      previousResult: "released",
      releasedLeaseIds: [automatic.lease.id],
    });

    const remaining = service.getDashboard(memberToken).leases;
    expect(remaining.map((lease) => lease.id)).not.toContain(automatic.lease.id);
    for (const lease of [standard.lease, exclusive.lease]) {
      expect(remaining).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: lease.id,
          status: "active",
          expiresAt: manualBefore.get(lease.id),
        }),
      ]));
    }
    expect(() => service.completeSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "turn-operation-1",
      turnId: "turn-1",
      activityEpoch: 1,
      outcome: "reverted",
    })).toThrow(expect.objectContaining({ code: "operation_id_conflict", status: 409 }));
    database.close();
  });

  it("keeps awaiting automatic work when Stop succeeds but its response is lost", () => {
    const { database, service, memberToken } = testService();
    const session = service.openSession({
      memberToken,
      codexSessionId: "codex-session-finalizing",
      turnId: "turn-final",
      activityEpoch: 7,
    });
    const automatic = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Pending Git check",
      paths: ["src/pending.ts"],
      kind: "automatic",
    });
    const standard = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Manual work survives",
      paths: ["src/manual.ts"],
      kind: "standard",
    });
    if (!automatic.acquired || !standard.acquired) throw new Error("Test leases were not acquired.");
    const automaticExpiry = automatic.lease.expiresAt;
    const standardExpiry = standard.lease.expiresAt;

    service.stopSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "stop-final",
      turnId: "turn-final",
      activityEpoch: 7,
    });
    service.startSessionFinalization({
      memberToken,
      sessionId: session.id,
      finalizationId: "finalization-after-stop",
    });
    const closed = service.completeSessionFinalization({
      memberToken,
      sessionId: session.id,
      finalizationId: "finalization-after-stop",
    });
    expect(closed.status).toBe("closed");
    expect(database.connection.prepare(`
      SELECT id, status, automatic_phase, expires_at FROM leases WHERE id IN (?, ?) ORDER BY id
    `).all(automatic.lease.id, standard.lease.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: automatic.lease.id,
        status: "active",
        automatic_phase: "awaiting_commit",
        expires_at: automaticExpiry,
      }),
      expect.objectContaining({
        id: standard.lease.id,
        status: "active",
        automatic_phase: "working",
        expires_at: standardExpiry,
      }),
    ]));

    expect(service.stopSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "stop-final",
      turnId: "turn-final",
      activityEpoch: 7,
    })).toMatchObject({
      result: "already_applied",
      previousResult: "awaiting_commit",
      session: { status: "closed" },
    });

    expect(service.completeSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "completion-after-close",
      turnId: "turn-final",
      activityEpoch: 7,
      outcome: "reverted",
      attributedPaths: ["src/pending.ts"],
    })).toMatchObject({
      result: "released",
      session: { status: "closed" },
      releasedLeaseIds: [automatic.lease.id],
    });
    expect(database.connection.prepare(
      "SELECT status FROM leases WHERE id = ?",
    ).get(automatic.lease.id)).toEqual({ status: "cancelled" });
    expect(database.connection.prepare(
      "SELECT status, expires_at FROM leases WHERE id = ?",
    ).get(standard.lease.id)).toEqual({ status: "active", expires_at: standardExpiry });
    database.close();
  });

  it("accepts Stop and completion after SessionEnd when Stop did not arrive beforehand", () => {
    const { database, service, memberToken } = testService();
    const session = service.openSession({
      memberToken,
      codexSessionId: "codex-session-late-stop",
      turnId: "turn-late-stop",
      activityEpoch: 11,
    });
    const automatic = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Automatic work awaiting a delayed Stop",
      paths: ["src/late-stop.ts"],
      kind: "automatic",
    });
    const standard = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Manual standard survives delayed Stop",
      paths: ["src/manual-standard-late-stop.ts"],
      kind: "standard",
    });
    const exclusive = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Manual exclusive survives delayed Stop",
      paths: ["src/manual-exclusive-late-stop.ts"],
      kind: "exclusive",
      ttlMinutes: 30,
    });
    if (!automatic.acquired || !standard.acquired || !exclusive.acquired) {
      throw new Error("Test leases were not acquired.");
    }
    const originalExpiries = new Map(
      [automatic.lease, standard.lease, exclusive.lease].map((lease) => [lease.id, lease.expiresAt]),
    );

    service.startSessionFinalization({
      memberToken,
      sessionId: session.id,
      finalizationId: "finalization-before-stop",
    });
    service.completeSessionFinalization({
      memberToken,
      sessionId: session.id,
      finalizationId: "finalization-before-stop",
    });
    expect(database.connection.prepare(`
      SELECT status, automatic_phase, expires_at FROM leases WHERE id = ?
    `).get(automatic.lease.id)).toEqual({
      status: "active",
      automatic_phase: "working",
      expires_at: originalExpiries.get(automatic.lease.id),
    });

    expect(service.stopSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "late-stop-operation",
      turnId: "turn-late-stop",
      activityEpoch: 11,
    })).toMatchObject({
      result: "awaiting_commit",
      session: {
        status: "closed",
        currentTurnId: "turn-late-stop",
        activityEpoch: 11,
      },
    });
    expect(database.connection.prepare(`
      SELECT status, automatic_phase, expires_at FROM leases WHERE id = ?
    `).get(automatic.lease.id)).toEqual({
      status: "active",
      automatic_phase: "awaiting_commit",
      expires_at: originalExpiries.get(automatic.lease.id),
    });

    expect(service.completeSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "late-stop-operation",
      turnId: "turn-late-stop",
      activityEpoch: 11,
      outcome: "reverted",
      leaseIds: [automatic.lease.id, standard.lease.id, exclusive.lease.id],
      attributedPaths: ["src/late-stop.ts"],
    })).toMatchObject({
      result: "released",
      releasedLeaseIds: [automatic.lease.id],
      session: { status: "closed" },
    });
    for (const lease of [standard.lease, exclusive.lease]) {
      expect(database.connection.prepare(
        "SELECT status, expires_at FROM leases WHERE id = ?",
      ).get(lease.id)).toEqual({
        status: "active",
        expires_at: originalExpiries.get(lease.id),
      });
    }
    database.close();
  });

  it("lets automatic work expire by TTL when Stop never reaches the server", () => {
    let currentTime = new Date("2026-08-27T12:00:00.000Z");
    const { database, service, memberToken } = testService(() => currentTime);
    const session = service.openSession({
      memberToken,
      codexSessionId: "codex-session-missing-stop",
      turnId: "turn-missing-stop",
      activityEpoch: 13,
    });
    const automatic = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Automatic work with no delivered Stop",
      paths: ["src/missing-stop.ts"],
      kind: "automatic",
    });
    if (!automatic.acquired) throw new Error("Test lease was not acquired.");

    service.startSessionFinalization({
      memberToken,
      sessionId: session.id,
      finalizationId: "finalization-without-stop",
    });
    service.completeSessionFinalization({
      memberToken,
      sessionId: session.id,
      finalizationId: "finalization-without-stop",
    });
    expect(database.connection.prepare(
      "SELECT status, automatic_phase, expires_at FROM leases WHERE id = ?",
    ).get(automatic.lease.id)).toEqual({
      status: "active",
      automatic_phase: "working",
      expires_at: automatic.lease.expiresAt,
    });

    currentTime = new Date(new Date(automatic.lease.expiresAt).getTime() + 1);
    expect(service.getDashboard(memberToken).leases.map((lease) => lease.id))
      .not.toContain(automatic.lease.id);
    expect(database.connection.prepare(
      "SELECT status FROM leases WHERE id = ?",
    ).get(automatic.lease.id)).toEqual({ status: "expired" });
    database.close();
  });

  it("does not heartbeat-renew an awaiting automatic lease", () => {
    let currentTime = new Date("2026-08-27T12:00:00.000Z");
    const { database, service, memberToken } = testService(() => currentTime);
    const session = service.openSession({
      memberToken,
      codexSessionId: "codex-heartbeat-fence",
      turnId: "turn-heartbeat",
      activityEpoch: 3,
    });
    const automatic = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Awaiting automatic",
      paths: ["src/awaiting-heartbeat.ts"],
      kind: "automatic",
    });
    const standard = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Heartbeat manual standard",
      paths: ["src/standard-heartbeat.ts"],
      kind: "standard",
    });
    if (!automatic.acquired || !standard.acquired) throw new Error("Test leases were not acquired.");
    service.stopSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "stop-heartbeat",
      turnId: "turn-heartbeat",
      activityEpoch: 3,
    });
    database.connection.prepare(
      "UPDATE work_sessions SET turn_stopped_at = NULL WHERE id = ?",
    ).run(session.id);

    currentTime = new Date("2026-08-27T12:01:00.000Z");
    const heartbeat = service.heartbeatSession({
      memberToken,
      sessionId: session.id,
      turnId: "turn-heartbeat",
      activityEpoch: 3,
    });
    expect(heartbeat.renewedLeases.map((lease) => lease.id)).toEqual([standard.lease.id]);
    expect(database.connection.prepare(`
      SELECT id, automatic_phase, expires_at FROM leases WHERE id IN (?, ?) ORDER BY id
    `).all(automatic.lease.id, standard.lease.id)).toEqual(expect.arrayContaining([
      {
        id: automatic.lease.id,
        automatic_phase: "awaiting_commit",
        expires_at: automatic.lease.expiresAt,
      },
      {
        id: standard.lease.id,
        automatic_phase: "working",
        expires_at: "2026-08-27T12:11:00.000Z",
      },
    ]));
    database.close();
  });
});

function testService(now: () => Date = () => new Date("2026-08-27T12:00:00.000Z")) {
  const database = new AgentHubDatabase({ path: ":memory:" });
  const service = new AgentHubService(database, { now });
  const room = service.createRoom({
    name: "Activity test room",
    projectName: "Activity test",
    repository: "https://example.invalid/activity.git",
    hostName: "Alice",
  });
  return { database, service, memberToken: room.memberToken };
}
