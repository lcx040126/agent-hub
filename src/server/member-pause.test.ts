import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentHubApp } from "./app.js";
import { AgentHubDatabase } from "./db.js";
import { AgentHubService } from "./service.js";

const databases: AgentHubDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("member integration pause", () => {
  it("closes all work visible on first handling using the server clock", async () => {
    let currentTime = Date.parse("2026-08-27T10:00:00.000Z");
    const database = new AgentHubDatabase({ path: ":memory:" });
    databases.push(database);
    const service = new AgentHubService(database, { now: () => new Date(currentTime) });
    const app = createAgentHubApp({ database, service });
    const room = service.createRoom({
      name: "Pause test room",
      projectName: "Pause test",
      repository: "https://github.com/example/pause.git",
      hostName: "Alice",
    });
    const bob = service.joinRoom({ roomToken: room.roomToken, displayName: "Bob" });

    const oldSession = service.openSession({
      memberToken: room.memberToken,
      agentName: "Codex",
      task: "Old work",
    });
    const oldLease = service.claimLease({
      memberToken: room.memberToken,
      sessionId: oldSession.id,
      title: "Old scene work",
      paths: ["Assets/Scenes/Old.unity"],
      mode: "write",
    });
    expect(oldLease.acquired).toBe(true);
    const confirmationId = randomUUID();
    database.connection.prepare(`
      INSERT INTO feature_change_confirmations (
        id, room_id, session_id, member_id, proposal_hash, impacts_json, status,
        reason, created_at, resolved_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)
    `).run(
      confirmationId,
      room.room.id,
      oldSession.id,
      room.member.id,
      "pause-test-proposal",
      "[]",
      cutoffTimestamp(currentTime),
      cutoffTimestamp(currentTime + 86_400_000),
    );

    const alreadyClosedSession = service.openSession({
      memberToken: room.memberToken,
      agentName: "Codex",
      task: "Already closed work",
    });
    service.closeSession({
      memberToken: room.memberToken,
      sessionId: alreadyClosedSession.id,
      summary: "Closed before the pause request.",
    });
    const closedConfirmationId = randomUUID();
    database.connection.prepare(`
      INSERT INTO feature_change_confirmations (
        id, room_id, session_id, member_id, proposal_hash, impacts_json, status,
        reason, created_at, resolved_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)
    `).run(
      closedConfirmationId,
      room.room.id,
      alreadyClosedSession.id,
      room.member.id,
      "pause-test-closed-proposal",
      "[]",
      cutoffTimestamp(currentTime),
      cutoffTimestamp(currentTime + 86_400_000),
    );

    const blocked = service.claimLease({
      memberToken: bob.memberToken,
      title: "Needs Alice's scene",
      paths: ["Assets/Scenes/Old.unity"],
      mode: "write",
      autoClaim: true,
      createdVia: "legacy",
    });
    expect(blocked.acquired).toBe(false);
    if (blocked.acquired) throw new Error("Expected a blocking release request.");
    expect(blocked.releaseRequests).toHaveLength(1);

    const cutoffAt = cutoffTimestamp(currentTime);
    currentTime += 500;
    const orphanLease = service.claimLease({
      memberToken: room.memberToken,
      sessionId: oldSession.id,
      title: "Lease created after cutoff on an old session",
      paths: ["Assets/Scenes/Old-aux.unity"],
      mode: "write",
    });
    expect(orphanLease.acquired).toBe(true);
    const orphanBlocked = service.claimLease({
      memberToken: bob.memberToken,
      title: "Needs the old auxiliary scene",
      paths: ["Assets/Scenes/Old-aux.unity"],
      mode: "write",
      autoClaim: true,
      createdVia: "legacy",
    });
    expect(orphanBlocked.acquired).toBe(false);
    if (orphanBlocked.acquired) throw new Error("Expected an orphan lease release request.");
    expect(orphanBlocked.releaseRequests).toHaveLength(1);
    currentTime += 1_000;
    const newSession = service.openSession({
      memberToken: room.memberToken,
      agentName: "Codex",
      task: "New work after reconnect",
    });
    const newLease = service.claimLease({
      memberToken: room.memberToken,
      sessionId: newSession.id,
      title: "New source work",
      paths: ["src/new-work.ts"],
      mode: "write",
    });
    expect(newLease.acquired).toBe(true);
    const newerCriticalLease = service.claimLease({
      memberToken: room.memberToken,
      sessionId: newSession.id,
      title: "New scene work",
      paths: ["Assets/Scenes/New.unity"],
      mode: "write",
    });
    expect(newerCriticalLease.acquired).toBe(true);
    const newerBlocked = service.claimLease({
      memberToken: bob.memberToken,
      title: "Needs the new scene",
      paths: ["Assets/Scenes/New.unity"],
      mode: "write",
      autoClaim: true,
      createdVia: "legacy",
    });
    expect(newerBlocked.acquired).toBe(false);
    if (newerBlocked.acquired) throw new Error("Expected a newer blocking release request.");
    expect(newerBlocked.releaseRequests).toHaveLength(1);

    const serverCutoffAt = cutoffTimestamp(currentTime);
    const paused = await request(app)
      .post("/api/member/pause")
      .set("Authorization", `Bearer ${room.memberToken}`)
      .send({ reason: "Agent Hub was closed", cutoffAt, requestId: "pause-1" });
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({
      requestId: "pause-1",
      roomId: room.room.id,
      memberId: room.member.id,
      memberRole: "host",
      reason: "Agent Hub was closed",
      cutoffAt: serverCutoffAt,
      appliedAt: serverCutoffAt,
      alreadyApplied: false,
      closedSessionIds: expect.arrayContaining([oldSession.id, newSession.id]),
      releasedLeaseIds: expect.arrayContaining([
        oldLease.acquired ? oldLease.lease.id : "",
        orphanLease.acquired ? orphanLease.lease.id : "",
        newLease.acquired ? newLease.lease.id : "",
        newerCriticalLease.acquired ? newerCriticalLease.lease.id : "",
      ]),
      cancelledReleaseRequestIds: expect.arrayContaining([
        blocked.releaseRequests[0].id,
        orphanBlocked.releaseRequests[0].id,
        newerBlocked.releaseRequests[0].id,
      ]),
      closedSessionCount: 2,
      releasedLeaseCount: 4,
      cancelledReleaseRequestCount: 3,
    });
    expect(paused.body.expiredConfirmationIds).toEqual(
      expect.arrayContaining([confirmationId, closedConfirmationId]),
    );
    expect(paused.body.expiredConfirmationCount).toBe(2);

    const sessions = service.listRoomSessions(room.memberToken).sessions;
    expect(sessions.find((session) => session.id === oldSession.id)?.status).toBe("closed");
    expect(sessions.find((session) => session.id === newSession.id)?.status).toBe("closed");
    expect(service.getDashboard(room.memberToken).leases).toEqual([]);
    const requestsAfterPause = service.listReleaseRequests({ memberToken: bob.memberToken, status: "all" });
    expect(requestsAfterPause.find((item) => item.id === blocked.releaseRequests[0].id)?.status).toBe("cancelled");
    expect(requestsAfterPause.find((item) => item.id === orphanBlocked.releaseRequests[0].id)?.status).toBe("cancelled");
    expect(requestsAfterPause.find((item) => item.id === newerBlocked.releaseRequests[0].id)?.status).toBe("cancelled");

    service.transferOwnership({ memberToken: room.memberToken, targetMemberId: bob.member.id });
    expect(service.getDashboard(room.memberToken).currentMember.role).toBe("member");

    const retried = await request(app)
      .post("/api/member/pause")
      .set("Authorization", `Bearer ${room.memberToken}`)
      .send({ reason: "Agent Hub was closed", cutoffAt, requestId: "pause-1" });
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual({ ...paused.body, alreadyApplied: true });
    expect(service.getDashboard(room.memberToken).leases).toEqual([]);

    const reused = await request(app)
      .post("/api/member/pause")
      .set("Authorization", `Bearer ${room.memberToken}`)
      .send({ reason: "A different reason", cutoffAt, requestId: "pause-1" });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe("pause_request_conflict");

    // The member token and room history remain usable after a pause.
    const dashboard = await request(app)
      .get("/api/dashboard")
      .set("Authorization", `Bearer ${room.memberToken}`);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.activity.some((item: { type: string }) => item.type === "member.paused")).toBe(true);
  });

  it("rejects unauthenticated and malformed pause requests, and applies the server clock", async () => {
    let currentTime = Date.parse("2026-08-27T10:00:00.000Z");
    const database = new AgentHubDatabase({ path: ":memory:" });
    databases.push(database);
    const service = new AgentHubService(database, { now: () => new Date(currentTime) });
    const app = createAgentHubApp({ database, service });
    const room = service.createRoom({
      name: "Pause validation room",
      repository: "https://github.com/example/pause.git",
      hostName: "Alice",
    });

    const unauthorized = await request(app).post("/api/member/pause").send({});
    expect(unauthorized.status).toBe(401);

    const malformed = await request(app)
      .post("/api/member/pause")
      .set("Authorization", `Bearer ${room.memberToken}`)
      .send({ reason: "close", cutoffAt: "not-a-date", requestId: "pause-invalid" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe("invalid_pause_cutoff");

    currentTime += 1_000;
    const future = await request(app)
      .post("/api/member/pause")
      .set("Authorization", `Bearer ${room.memberToken}`)
      .send({
        reason: "close",
        cutoffAt: cutoffTimestamp(currentTime + 60_000),
        requestId: "pause-future",
      });
    expect(future.status).toBe(200);
    expect(future.body).toMatchObject({
      requestId: "pause-future",
      memberRole: "host",
      cutoffAt: cutoffTimestamp(currentTime),
      alreadyApplied: false,
    });
  });

  it.each([
    {
      clockPosition: "far behind",
      clientCutoffAt: "2020-01-01T00:00:00.000Z",
    },
    {
      clockPosition: "far ahead",
      clientCutoffAt: "2035-01-01T00:00:00.000Z",
    },
  ])(
    "uses the server clock and remains idempotent when the client clock is $clockPosition",
    async ({ clientCutoffAt }) => {
      let currentTime = Date.parse("2026-08-27T10:00:00.000Z");
      const database = new AgentHubDatabase({ path: ":memory:" });
      databases.push(database);
      const service = new AgentHubService(database, { now: () => new Date(currentTime) });
      const app = createAgentHubApp({ database, service });
      const room = service.createRoom({
        name: "Pause clock room",
        repository: "https://github.com/example/pause-clock.git",
        hostName: "Alice",
      });
      const session = service.openSession({
        memberToken: room.memberToken,
        agentName: "Codex",
        task: "Work visible before pause handling",
      });
      const lease = service.claimLease({
        memberToken: room.memberToken,
        sessionId: session.id,
        title: "Work visible before pause handling",
        paths: ["src/pre-pause.ts"],
        mode: "write",
      });
      expect(lease.acquired).toBe(true);

      const serverCutoffAt = cutoffTimestamp(currentTime);
      const first = await request(app)
        .post("/api/member/pause")
        .set("Authorization", `Bearer ${room.memberToken}`)
        .send({
          reason: "Agent Hub was closed",
          cutoffAt: clientCutoffAt,
          requestId: "pause-clock-skew",
        });

      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        requestId: "pause-clock-skew",
        cutoffAt: serverCutoffAt,
        appliedAt: serverCutoffAt,
        alreadyApplied: false,
        closedSessionIds: [session.id],
        releasedLeaseIds: [lease.acquired ? lease.lease.id : ""],
        closedSessionCount: 1,
        releasedLeaseCount: 1,
      });
      expect(service.listRoomSessions(room.memberToken).sessions
        .find((item) => item.id === session.id)?.status).toBe("closed");
      expect(service.getDashboard(room.memberToken).leases).toEqual([]);

      currentTime += 60_000;
      const sessionAfterPause = service.openSession({
        memberToken: room.memberToken,
        agentName: "Codex",
        task: "Work created after pause handling",
      });
      const leaseAfterPause = service.claimLease({
        memberToken: room.memberToken,
        sessionId: sessionAfterPause.id,
        title: "Work created after pause handling",
        paths: ["src/post-pause.ts"],
        mode: "write",
      });
      expect(leaseAfterPause.acquired).toBe(true);

      const retried = await request(app)
        .post("/api/member/pause")
        .set("Authorization", `Bearer ${room.memberToken}`)
        .send({
          reason: "Agent Hub was closed",
          cutoffAt: clientCutoffAt,
          requestId: "pause-clock-skew",
        });

      expect(retried.status).toBe(200);
      expect(retried.body).toEqual({ ...first.body, alreadyApplied: true });
      expect(service.listRoomSessions(room.memberToken).sessions
        .find((item) => item.id === sessionAfterPause.id)?.status).toBe("active");
      expect(service.getDashboard(room.memberToken).leases.map((item) => item.id)).toEqual([
        leaseAfterPause.acquired ? leaseAfterPause.lease.id : "",
      ]);
    },
  );

  it("returns the role authenticated inside the pause operation after ownership transfer", async () => {
    const database = new AgentHubDatabase({ path: ":memory:" });
    databases.push(database);
    const service = new AgentHubService(database, {
      now: () => new Date("2026-08-27T10:00:00.000Z"),
    });
    const app = createAgentHubApp({ database, service });
    const room = service.createRoom({
      name: "Pause role room",
      repository: "https://github.com/example/pause-role.git",
      hostName: "Alice",
    });
    const bob = service.joinRoom({ roomToken: room.roomToken, displayName: "Bob" });
    service.transferOwnership({ memberToken: room.memberToken, targetMemberId: bob.member.id });

    const paused = await request(app)
      .post("/api/member/pause")
      .set("Authorization", `Bearer ${room.memberToken}`)
      .send({
        reason: "leave-room",
        cutoffAt: "2026-08-27T10:00:00.000Z",
        requestId: "pause-after-transfer",
      });

    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({
      requestId: "pause-after-transfer",
      memberId: room.member.id,
      memberRole: "member",
      alreadyApplied: false,
    });
  });
});

function cutoffTimestamp(value: number): string {
  return new Date(value).toISOString();
}
