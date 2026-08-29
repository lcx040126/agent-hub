import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentHubApp } from "./app.js";
import { AgentHubDatabase } from "./db.js";
import { AgentHubService } from "./service.js";
import {
  AGENT_HUB_PROTOCOL_VERSION,
  AGENT_HUB_SCHEMA_VERSION,
  AGENT_HUB_VERSION,
} from "../shared/version.js";

const databases: AgentHubDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Agent Hub REST API", () => {
  it("reports matching service compatibility only after the migrated database is readable", async () => {
    const { app } = testApp();
    const health = await request(app).get("/api/health");

    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      status: "ok",
      service: "agent-hub",
      version: AGENT_HUB_VERSION,
      protocolVersion: AGENT_HUB_PROTOCOL_VERSION,
      schemaVersion: AGENT_HUB_SCHEMA_VERSION,
      database: { status: "ok", schemaVersion: AGENT_HUB_SCHEMA_VERSION },
    });
  });

  it("keeps complete session identities out of anonymous diagnostics and room context exports", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const codexSessionId = "codex-private-export-1234567890";
    const currentTurnId = "turn-private-export-1234567890";
    const activityEpoch = 987_654_321;
    const finalizationId = "finalization-private-export-1234567890";
    const opened = await auth(request(app).post("/api/sessions").send({
      codexSessionId,
      turnId: currentTurnId,
      activityEpoch,
      task: "Private identity export boundary",
    }), owner.body.token);
    const hubSessionId = opened.body.session.id as string;

    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: hubSessionId,
        codexSessionId,
        currentTurnId,
        activityEpoch,
      }),
    ]));

    await auth(request(app).post("/api/records").send({
      kind: "risk",
      title: "Private session identifiers",
      summary: `Hub ${hubSessionId}; Codex ${codexSessionId}; Turn ${currentTurnId}.`,
      evidence: [`Finalization ${finalizationId}`],
    }), owner.body.token);
    await auth(request(app)
      .post(`/api/sessions/${hubSessionId}/finalize/start`)
      .send({ finalizationId }), owner.body.token);
    await auth(request(app)
      .post(`/api/sessions/${hubSessionId}/finalize/complete`)
      .send({ finalizationId, evidenceError: "Local Git evidence remained unavailable." }), owner.body.token);

    const anonymousHealth = await request(app).get("/api/health");
    const anonymousExport = await request(app).get("/api/room/context/export");
    const contextExport = await auth(
      request(app).get("/api/room/context/export"),
      owner.body.token,
    );

    expect(anonymousExport.status).toBe(401);
    expect(contextExport.status).toBe(200);
    expect(contextExport.body).not.toHaveProperty("sessions");
    expect(contextExport.body).not.toHaveProperty("leases");
    for (const payload of [anonymousHealth.body, anonymousExport.body, contextExport.body]) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(codexSessionId);
      expect(serialized).not.toContain(currentTurnId);
      expect(serialized).not.toContain(hubSessionId);
      expect(serialized).not.toContain(finalizationId);
      for (const privateField of [
        "codexSessionId",
        "codex_session_id",
        "currentTurnId",
        "current_turn_id",
        "activityEpoch",
        "activity_epoch",
        "sessionId",
        "session_id",
        "finalizationId",
        "finalization_id",
      ]) {
        expect(serialized).not.toContain(privateField);
      }
    }
  });

  it("fixes the UI-facing manual lease route to manual UI provenance", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");

    const standard = await auth(request(app).post("/api/leases").send({
      title: "Manual standard scope",
      paths: ["src/manual-standard.ts"],
      kind: "standard",
      managedBy: "agent",
      createdVia: "mcp",
    }), owner.body.token);
    const exclusive = await auth(request(app).post("/api/leases").send({
      title: "Manual exclusive scope",
      paths: ["ProjectSettings"],
      kind: "exclusive",
      ttlMinutes: 60,
      managedBy: "agent",
      createdVia: "hook",
    }), owner.body.token);
    const automatic = await auth(request(app).post("/api/leases").send({
      title: "Spoofed automatic UI scope",
      paths: ["src/spoofed-automatic.ts"],
      kind: "automatic",
      managedBy: "agent",
      createdVia: "mcp",
    }), owner.body.token);

    expect(standard.status).toBe(201);
    expect(standard.body.lease).toMatchObject({
      kind: "standard",
      managedBy: "manual",
      createdVia: "ui",
    });
    expect(exclusive.status).toBe(201);
    expect(exclusive.body.lease).toMatchObject({
      kind: "exclusive",
      managedBy: "manual",
      createdVia: "ui",
    });
    expect(automatic.status).toBe(400);
    expect(automatic.body).toMatchObject({ error: "invalid_lease_management" });

    const opened = await auth(request(app).post("/api/sessions").send({
      codexSessionId: "codex-manual-coverage",
      turnId: "turn-manual-coverage",
      activityEpoch: 1,
    }), owner.body.token);
    const covered = await auth(request(app).post("/api/edits/prepare").send({
      sessionId: opened.body.session.id,
      title: "Agent call covered by manual scope",
      paths: ["src/manual-standard.ts"],
      invocationId: "manual-coverage-invocation",
      toolName: "apply_patch",
      stage: "pre",
      turnId: "turn-manual-coverage",
      activityEpoch: 1,
    }), owner.body.token);
    expect(covered.body.claim).toMatchObject({
      acquired: true,
      lease: { id: standard.body.lease.id, managedBy: "manual" },
      coverage: [{
        leaseId: standard.body.lease.id,
        managedBy: "manual",
        paths: ["src/manual-standard.ts"],
        action: "covered",
      }],
    });

    const scopeEvents = await auth(
      request(app).get(`/api/leases/${standard.body.lease.id}/scope-events`),
      bob.body.token,
    );
    expect(scopeEvents.status).toBe(200);
    expect(scopeEvents.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "lease.scope_covered",
        metadata: expect.objectContaining({
          invocationId: "manual-coverage-invocation",
          source: "hook",
          stage: "pre",
          turnId: "turn-manual-coverage",
          coveredPaths: ["src/manual-standard.ts"],
        }),
      }),
    ]));
  });

  it("projects managed session identities and pages member-only scope history", async () => {
    let currentTime = new Date("2026-08-29T03:00:00.000Z");
    const { app } = testApp(() => currentTime);
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");
    const opened = await auth(request(app).post("/api/sessions").send({
      codexSessionId: "codex-rest-scope",
      turnId: "turn-rest-0",
      activityEpoch: 4,
      repository: "C:/project",
      branch: "main",
      baseCommit: "rest-base",
    }), owner.body.token);
    const sessionId = opened.body.session.id as string;

    const first = await auth(request(app).post("/api/edits/prepare").send({
      sessionId,
      title: "REST managed scope",
      branch: "main",
      baseCommit: "rest-base",
      paths: ["src/rest-first.ts"],
      invocationId: "rest-invocation-1",
      toolName: "apply_patch",
      stage: "pre",
      turnId: "turn-rest-0",
      activityEpoch: 4,
    }), owner.body.token);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      claim: {
        acquired: true,
        lease: { managedBy: "agent", createdVia: "hook", sessionId },
      },
      managedLease: { managedBy: "agent", sessionId },
    });
    const leaseId = first.body.managedLease.id as string;
    currentTime = new Date("2026-08-29T03:00:01.000Z");

    await auth(request(app).post("/api/edits/prepare").send({
      sessionId,
      title: "REST managed scope",
      branch: "main",
      baseCommit: "rest-base",
      paths: ["src/rest-second.ts"],
      invocationId: "rest-invocation-2",
      toolName: "Bash",
      stage: "post",
      actualPaths: ["src/rest-second.ts"],
      turnId: "turn-rest-0",
      activityEpoch: 4,
    }), owner.body.token);

    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: leaseId, sessionId, managedBy: "agent", createdVia: "hook" }),
    ]));
    expect(dashboard.body.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: sessionId,
        codexSessionId: "codex-rest-scope",
        currentTurnId: "turn-rest-0",
        activityEpoch: 4,
      }),
    ]));

    expect((await request(app).get(`/api/leases/${leaseId}/scope-events`)).status).toBe(401);
    const pageOne = await auth(request(app)
      .get(`/api/leases/${leaseId}/scope-events?limit=1`), bob.body.token);
    expect(pageOne.status).toBe(200);
    expect(pageOne.body).toMatchObject({
      items: [{ metadata: { invocationId: "rest-invocation-2", stage: "post" } }],
    });
    expect(typeof pageOne.body.nextBefore).toBe("string");
    const pageTwo = await auth(request(app)
      .get(`/api/leases/${leaseId}/scope-events?limit=1&before=${encodeURIComponent(pageOne.body.nextBefore)}`), bob.body.token);
    expect(pageTwo.body).toMatchObject({
      items: [{ metadata: { invocationId: "rest-invocation-1", stage: "pre" } }],
    });
  });

  it("records empty Hook audits without inventing a path and denies an unprovable protected target", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const opened = await auth(request(app).post("/api/sessions").send({
      turnId: "turn-empty-audit",
      activityEpoch: 1,
      branch: "main",
      baseCommit: "empty-audit-base",
    }), owner.body.token);
    const sessionId = opened.body.session.id as string;
    const claimed = await auth(request(app).post("/api/edits/prepare").send({
      sessionId,
      title: "Empty Hook audit",
      branch: "main",
      baseCommit: "empty-audit-base",
      paths: ["src/owned.ts"],
      invocationId: "empty-audit-claim",
      toolName: "apply_patch",
      stage: "pre",
      turnId: "turn-empty-audit",
      activityEpoch: 1,
    }), owner.body.token);
    const leaseId = claimed.body.managedLease.id as string;

    const ignoredPre = await auth(request(app).post("/api/edits/prepare").send({
      sessionId,
      title: "Ignored temporary log",
      branch: "main",
      baseCommit: "empty-audit-base",
      paths: [],
      ignoredPaths: [".tmp/agent-hub.log"],
      invocationId: "empty-audit-ignored",
      toolName: "Bash",
      stage: "pre",
      turnId: "turn-empty-audit",
      activityEpoch: 1,
    }), owner.body.token);
    expect(ignoredPre.status, JSON.stringify(ignoredPre.body)).toBe(200);
    expect(ignoredPre.body).toMatchObject({
      check: { allowed: true, blockers: [], coveredPaths: [], uncoveredPaths: [] },
      managedLease: { id: leaseId, paths: ["src/owned.ts"] },
    });
    expect(ignoredPre.body.claim).toBeUndefined();

    const emptyPost = await auth(request(app).post("/api/edits/prepare").send({
      sessionId,
      title: "No observed Git change",
      branch: "main",
      baseCommit: "empty-audit-base",
      paths: [],
      actualPaths: [],
      invocationId: "empty-audit-post",
      toolName: "Bash",
      stage: "post",
      turnId: "turn-empty-audit",
      activityEpoch: 1,
    }), owner.body.token);
    expect(emptyPost.status, JSON.stringify(emptyPost.body)).toBe(200);
    expect(emptyPost.body.check).toMatchObject({ allowed: true, blockers: [], uncoveredPaths: [] });

    const dynamicPre = await auth(request(app).post("/api/edits/prepare").send({
      sessionId,
      title: "Unprovable dynamic target",
      branch: "main",
      baseCommit: "empty-audit-base",
      paths: [],
      pathDiagnostics: ["A dynamic path could not be statically proven."],
      invocationId: "empty-audit-dynamic",
      toolName: "Bash",
      stage: "pre",
      turnId: "turn-empty-audit",
      activityEpoch: 1,
    }), owner.body.token);
    expect(dynamicPre.status, JSON.stringify(dynamicPre.body)).toBe(200);
    expect(dynamicPre.body.check).toMatchObject({
      allowed: false,
      blockers: [expect.objectContaining({ code: "uncovered_path", path: "." })],
      uncoveredPaths: ["."],
    });

    const scopeEvents = await auth(request(app).get(`/api/leases/${leaseId}/scope-events`), owner.body.token);
    expect(scopeEvents.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ metadata: expect.objectContaining({ invocationId: "empty-audit-ignored", stage: "pre" }) }),
      expect.objectContaining({ metadata: expect.objectContaining({ invocationId: "empty-audit-post", stage: "post" }) }),
      expect.objectContaining({ metadata: expect.objectContaining({ invocationId: "empty-audit-dynamic", stage: "pre" }) }),
    ]));
    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases.find((lease: { id: string }) => lease.id === leaseId).paths).toEqual(["src/owned.ts"]);
  });

  it("finalizes sessions idempotently while rejecting normal work in the background phase", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const opened = await auth(request(app).post("/api/sessions").send({
      agentName: "Codex",
      codexSessionId: "codex-finalizing-visible",
      turnId: "turn-finalizing-visible",
      activityEpoch: 12,
      repository: "C:/project",
      branch: "main",
      baseCommit: "0123456789abcdef",
    }), owner.body.token);
    const sessionId = opened.body.session.id as string;
    const finalizationId = "finalization_test_001";
    const lease = await auth(request(app).post("/api/leases").send({
      sessionId,
      title: "Finalizing work",
      paths: ["src/finalizing.ts"],
      autoClaim: true,
    }), owner.body.token);
    expect(lease.body.acquired).toBe(true);

    const stopped = await auth(request(app)
      .post(`/api/sessions/${sessionId}/stop`)
      .send({
        operationId: "stop-finalizing-visible",
        turnId: "turn-finalizing-visible",
        activityEpoch: 12,
      }), owner.body.token);
    expect(stopped.body.result).toBe("awaiting_commit");

    const started = await auth(request(app)
      .post(`/api/sessions/${sessionId}/finalize/start`)
      .send({ finalizationId }), owner.body.token);
    expect(started.status).toBe(200);
    expect(started.body.session.status).toBe("finalizing");
    const repeatedStart = await auth(request(app)
      .post(`/api/sessions/${sessionId}/finalize/start`)
      .send({ finalizationId }), owner.body.token);
    expect(repeatedStart.body.session.status).toBe("finalizing");

    expect((await auth(request(app)
      .post(`/api/sessions/${sessionId}/heartbeat`).send({}), owner.body.token)).status).toBe(409);
    expect((await auth(request(app).post("/api/leases").send({
      sessionId,
      title: "Late write",
      paths: ["src/late.ts"],
      autoClaim: true,
    }), owner.body.token)).status).toBe(409);
    expect((await auth(request(app)
      .post(`/api/sessions/${sessionId}/scan`)
      .send({ changedPaths: ["src/finalizing.ts"] }), owner.body.token)).status).toBe(409);

    const firstScan = await auth(request(app)
      .post(`/api/sessions/${sessionId}/scan`)
      .send({ finalizationId, changedPaths: ["src/finalizing.ts"] }), owner.body.token);
    const repeatedScan = await auth(request(app)
      .post(`/api/sessions/${sessionId}/scan`)
      .send({ finalizationId, changedPaths: ["src/finalizing.ts"] }), owner.body.token);
    expect(firstScan.status, JSON.stringify(firstScan.body)).toBe(201);
    expect(repeatedScan.body.scan.id).toBe(firstScan.body.scan.id);
    expect((await auth(request(app).post("/api/features/query").send({
      sessionId,
      level: "cards",
    }), owner.body.token)).status).toBe(409);
    expect((await auth(request(app).post("/api/features/query").send({
      sessionId,
      finalizationId,
      level: "cards",
    }), owner.body.token)).status).toBe(200);

    const completed = await auth(request(app)
      .post(`/api/sessions/${sessionId}/finalize/complete`)
      .send({ finalizationId, evidenceError: "Local Git evidence remained unavailable." }), owner.body.token);
    expect(completed.body.session.status).toBe("closed");
    const repeatedComplete = await auth(request(app)
      .post(`/api/sessions/${sessionId}/finalize/complete`)
      .send({ finalizationId }), owner.body.token);
    expect(repeatedComplete.body.session.status).toBe("closed");
    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: lease.body.lease.id,
        status: "active",
        phase: "awaiting_commit",
        expiresAt: lease.body.lease.expiresAt,
      }),
    ]));
    expect(dashboard.body.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: sessionId,
        status: "closed",
        codexSessionId: "codex-finalizing-visible",
        currentTurnId: "turn-finalizing-visible",
        activityEpoch: 12,
      }),
    ]));
    expect(dashboard.body.records.filter(
      (record: { title: string }) => record.title === "会话结束证据未完整生成",
    )).toHaveLength(1);
  });

  it("opens a new active generation while the previous Codex session is finalizing", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const first = await auth(request(app).post("/api/sessions").send({
      codexSessionId: "codex-reopened-task",
      turnId: "turn-before-end",
      activityEpoch: 0,
      repository: "C:/project",
      branch: "main",
    }), owner.body.token);
    const firstSessionId = first.body.session.id as string;
    const finalizationId = "finalization_reopened_task_001";

    const finalizing = await auth(request(app)
      .post(`/api/sessions/${firstSessionId}/finalize/start`)
      .send({ finalizationId }), owner.body.token);
    expect(finalizing.body.session.status).toBe("finalizing");

    const reopened = await auth(request(app).post("/api/sessions").send({
      codexSessionId: "codex-reopened-task",
      turnId: "turn-after-reopen",
      activityEpoch: 0,
      repository: "C:/project",
      branch: "main",
    }), owner.body.token);
    expect(reopened.status).toBe(201);
    expect(reopened.body.session).toMatchObject({
      status: "active",
      reused: false,
      codexSessionId: "codex-reopened-task",
      currentTurnId: "turn-after-reopen",
    });
    expect(reopened.body.session.id).not.toBe(firstSessionId);

    const sessions = await auth(request(app).get("/api/sessions"), owner.body.token);
    expect(sessions.body.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstSessionId, status: "finalizing" }),
      expect.objectContaining({ id: reopened.body.session.id, status: "active" }),
    ]));
    expect((await auth(request(app)
      .post(`/api/sessions/${firstSessionId}/heartbeat`).send({}), owner.body.token)).status).toBe(409);
    expect((await auth(request(app)
      .post(`/api/sessions/${reopened.body.session.id}/heartbeat`).send({}), owner.body.token)).status).toBe(200);
  });

  it("keeps finalization capabilities isolated when two sessions reuse one id", async () => {
    const { app, database } = testApp();
    const owner = await createRoom(app);
    const openSession = (codexSessionId: string) => auth(request(app).post("/api/sessions").send({
      codexSessionId,
      repository: "C:/project",
      branch: "main",
    }), owner.body.token);
    const first = await openSession("codex-finalization-owner");
    const second = await openSession("codex-finalization-contender");
    const finalizationId = "shared-finalization-capability";

    expect((await auth(request(app)
      .post(`/api/sessions/${first.body.session.id}/finalize/start`)
      .send({ finalizationId }), owner.body.token)).status).toBe(200);
    const firstScan = await auth(request(app)
      .post(`/api/sessions/${first.body.session.id}/scan`)
      .send({ finalizationId, changedPaths: ["src/first.ts"] }), owner.body.token);
    expect(firstScan.status).toBe(201);

    const conflictingStart = await auth(request(app)
      .post(`/api/sessions/${second.body.session.id}/finalize/start`)
      .send({ finalizationId }), owner.body.token);
    expect(conflictingStart.status).toBe(409);
    expect(conflictingStart.body.error).toBe("finalization_conflict");

    // 防御旧版或手工修改过的数据库：即使出现重复能力，也不能跨会话返回扫描证据。
    database.connection.prepare(`
      UPDATE work_sessions
      SET finalization_id = ?, finalizing_at = last_seen_at
      WHERE id = ?
    `).run(finalizationId, second.body.session.id);
    const conflictingScan = await auth(request(app)
      .post(`/api/sessions/${second.body.session.id}/scan`)
      .send({ finalizationId, changedPaths: ["src/second.ts"] }), owner.body.token);
    expect(conflictingScan.status).toBe(409);
    expect(conflictingScan.body.error).toBe("finalization_conflict");
    expect(conflictingScan.body.scan).toBeUndefined();
    expect(firstScan.body.scan.sessionId).toBe(first.body.session.id);
  });

  it("lets a reopened Codex task continue its automatic path while different tasks still wait", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    await auth(request(app).post("/api/room/settings").send({
      riskRules: [{ kind: "extension", selector: ".ts", level: "blocking" }],
    }), owner.body.token);
    const openSession = (codexSessionId: string, turnId: string) => auth(
      request(app).post("/api/sessions").send({
        codexSessionId,
        turnId,
        activityEpoch: 0,
        repository: "C:/project",
        branch: "main",
      }),
      owner.body.token,
    );
    const first = await openSession("codex-same-logical-task", "turn-before-end");
    const firstLease = await auth(request(app).post("/api/leases").send({
      sessionId: first.body.session.id,
      title: "Critical path before reopen",
      autoClaim: true,
      paths: ["src/critical.ts"],
    }), owner.body.token);
    expect(firstLease.body.acquired).toBe(true);

    await auth(request(app)
      .post(`/api/sessions/${first.body.session.id}/finalize/start`)
      .send({ finalizationId: "finalization_same_logical_task" }), owner.body.token);
    const reopened = await openSession("codex-same-logical-task", "turn-after-reopen");
    expect(reopened.body.session.id).not.toBe(first.body.session.id);
    const continued = await auth(request(app).post("/api/leases").send({
      sessionId: reopened.body.session.id,
      title: "Continue critical path after reopen",
      autoClaim: true,
      paths: ["src/critical.ts"],
    }), owner.body.token);
    expect(continued.body).toMatchObject({ acquired: true, decision: "allow", conflicts: [] });

    const independent = await openSession("codex-independent-task", "turn-independent");
    const waiting = await auth(request(app).post("/api/leases").send({
      sessionId: independent.body.session.id,
      title: "Independent critical path",
      autoClaim: true,
      paths: ["src/critical.ts"],
    }), owner.body.token);
    expect(waiting.body).toMatchObject({
      acquired: false,
      decision: "wait",
      conflicts: [],
      releaseRequests: [],
      waitingFor: { paths: ["src/critical.ts"] },
    });
  });

  it("exposes commit-gated automatic release with retry and activity-epoch fencing", async () => {
    const { app } = testApp(() => new Date("2026-08-27T12:00:00.000Z"));
    const owner = await createRoom(app);
    const opened = await auth(request(app).post("/api/sessions").send({
      codexSessionId: "codex-rest-session",
      turnId: "turn-0",
      activityEpoch: 0,
      branch: "main",
      baseCommit: "base-0",
    }), owner.body.token);
    const reused = await auth(request(app).post("/api/sessions").send({
      codexSessionId: "codex-rest-session",
      turnId: "turn-0",
      activityEpoch: 0,
    }), owner.body.token);
    expect(reused.body.session).toMatchObject({
      id: opened.body.session.id,
      codexSessionId: "codex-rest-session",
      currentTurnId: "turn-0",
      activityEpoch: 0,
    });
    const sessionId = opened.body.session.id as string;
    const automatic = await auth(request(app).post("/api/leases").send({
      sessionId,
      title: "Automatic REST edit",
      paths: ["src/rest-auto.ts"],
      autoClaim: true,
    }), owner.body.token);
    const standard = await auth(request(app).post("/api/leases").send({
      sessionId,
      title: "Manual REST edit",
      paths: ["src/rest-manual.ts"],
      kind: "standard",
    }), owner.body.token);
    const manualExpiry = standard.body.lease.expiresAt as string;

    const stopped = await auth(request(app)
      .post(`/api/sessions/${sessionId}/stop`)
      .send({ operationId: "stop-rest-0", turnId: "turn-0", activityEpoch: 0 }), owner.body.token);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({
      result: "awaiting_commit",
      session: { currentTurnId: "turn-0", activityEpoch: 0 },
    });
    expect(stopped.body.session.turnStoppedAt).toBeTruthy();
    const duplicateStop = await auth(request(app)
      .post(`/api/sessions/${sessionId}/stop`)
      .send({ operationId: "stop-rest-0", turnId: "turn-0", activityEpoch: 0 }), owner.body.token);
    expect(duplicateStop.body).toMatchObject({
      result: "already_applied",
      previousResult: "awaiting_commit",
    });

    const resumed = await auth(request(app)
      .post(`/api/sessions/${sessionId}/resume`)
      .send({ operationId: "resume-rest-1", turnId: "turn-1", activityEpoch: 1 }), owner.body.token);
    expect(resumed.body).toMatchObject({
      result: "resumed",
      session: { currentTurnId: "turn-1", activityEpoch: 1, turnStoppedAt: null },
    });
    expect((await auth(request(app)
      .post(`/api/sessions/${sessionId}/heartbeat`)
      .send({ turnId: "turn-0", activityEpoch: 0 }), owner.body.token)).status).toBe(409);
    expect((await auth(request(app)
      .post(`/api/sessions/${sessionId}/heartbeat`)
      .send({ turnId: "turn-1", activityEpoch: 1 }), owner.body.token)).status).toBe(200);
    expect((await auth(request(app).post("/api/edits/prepare").send({
      sessionId,
      title: "Stale prepare",
      branch: "main",
      baseCommit: "base-0",
      paths: ["src/rest-auto.ts"],
      turnId: "turn-0",
      activityEpoch: 0,
    }), owner.body.token)).status).toBe(409);
    const stale = await auth(request(app)
      .post(`/api/sessions/${sessionId}/completion/check`)
      .send({
        operationId: "stop-rest-0",
        turnId: "turn-0",
        activityEpoch: 0,
        outcome: "committed",
        baseCommit: "base-0",
        headCommit: "commit-0",
      }), owner.body.token);
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ result: "superseded", releasedLeaseIds: [] });

    await auth(request(app)
      .post(`/api/sessions/${sessionId}/stop`)
      .send({ operationId: "turn-rest-operation-1", turnId: "turn-1", activityEpoch: 1 }), owner.body.token);
    const unchangedHead = await auth(request(app)
      .post(`/api/sessions/${sessionId}/completion/check`)
      .send({
        operationId: "completion-rest-no-commit",
        turnId: "turn-1",
        activityEpoch: 1,
        outcome: "committed",
        baseCommit: "base-0",
        headCommit: "base-0",
      }), owner.body.token);
    expect(unchangedHead.body).toMatchObject({ result: "awaiting_commit", releasedLeaseIds: [] });
    const beforeCommit = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(beforeCommit.body.leases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: automatic.body.lease.id,
        status: "active",
        phase: "awaiting_commit",
      }),
    ]));

    const completed = await auth(request(app)
      .post(`/api/sessions/${sessionId}/completion/check`)
      .send({
        operationId: "turn-rest-operation-1",
        turnId: "turn-1",
        activityEpoch: 1,
        outcome: "committed",
        leaseIds: [automatic.body.lease.id, standard.body.lease.id],
        attributedPaths: ["src/rest-auto.ts"],
        baseCommit: "base-0",
        headCommit: "commit-1",
      }), owner.body.token);
    expect(completed.body).toMatchObject({
      result: "released",
      releasedLeaseIds: [automatic.body.lease.id],
    });
    const afterCommit = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(afterCommit.body.leases.map((lease: { id: string }) => lease.id))
      .not.toContain(automatic.body.lease.id);
    expect(afterCommit.body.leases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: standard.body.lease.id,
        status: "active",
        expiresAt: manualExpiry,
      }),
    ]));
  });

  it("supports owner transfer, administrator management, room settings, and removal", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");
    const carol = await joinRoom(app, owner.body.inviteCode, "Carol");
    const granted = await auth(request(app).post(`/api/room/members/${bob.body.member.id}/role`).send({ isAdmin: true }), owner.body.token);
    expect(granted.status).toBe(200);
    const forbiddenSettings = await auth(request(app).post("/api/room/settings").send({ blockingProtectionEnabled: false }), bob.body.token);
    expect(forbiddenSettings.status).toBe(403);
    const settings = await auth(request(app).post("/api/room/settings").send({ blockingProtectionEnabled: false }), owner.body.token);
    expect(settings.status).toBe(200);
    const transferred = await auth(request(app).post("/api/room/transfer").send({ targetMemberId: bob.body.member.id }), owner.body.token);
    expect(transferred.status).toBe(200);
    const denied = await auth(request(app).post(`/api/room/members/${carol.body.member.id}/role`).send({ isAdmin: true }), bob.body.token);
    expect(denied.status).toBe(200);
    const removed = await auth(request(app).post(`/api/room/members/${carol.body.member.id}/remove`).send({}), bob.body.token);
    expect(removed.status).toBe(204);
    const kicked = await auth(request(app).get("/api/dashboard"), carol.body.token);
    expect(kicked.status).toBe(401);
  });

  it("requires protocol 2 presence before enabling monitor-only mode and rejects later legacy clients", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const legacy = await request(app).post("/api/rooms/join").send({
      inviteCode: owner.body.inviteCode,
      memberName: "Legacy Bob",
      clientVersion: "0.2.5",
      protocolVersion: 1,
      schemaVersion: AGENT_HUB_SCHEMA_VERSION,
    });
    expect(legacy.status).toBe(201);

    const blockedToggle = await auth(request(app).post("/api/room/settings").send({
      blockingProtectionEnabled: false,
    }), owner.body.token);
    expect(blockedToggle.status).toBe(409);
    expect(blockedToggle.body).toMatchObject({
      error: "monitor_mode_upgrade_required",
      details: {
        requiredProtocolVersion: AGENT_HUB_PROTOCOL_VERSION,
        members: [expect.objectContaining({
          id: legacy.body.member.id,
          displayName: "Legacy Bob",
          protocolVersion: 1,
        })],
      },
    });

    const upgraded = await auth(request(app).post("/api/sessions").send({
      clientVersion: AGENT_HUB_VERSION,
      protocolVersion: AGENT_HUB_PROTOCOL_VERSION,
      schemaVersion: AGENT_HUB_SCHEMA_VERSION,
      task: "Report upgraded presence",
    }), legacy.body.token);
    expect(upgraded.status).toBe(201);
    expect((await auth(request(app).post("/api/room/settings").send({
      blockingProtectionEnabled: false,
    }), owner.body.token)).status).toBe(200);

    const rejectedJoin = await request(app).post("/api/rooms/join").send({
      inviteCode: owner.body.inviteCode,
      memberName: "Legacy Carol",
      clientVersion: "0.2.5",
      protocolVersion: 1,
      schemaVersion: AGENT_HUB_SCHEMA_VERSION,
    });
    expect(rejectedJoin.status).toBe(409);
    expect(rejectedJoin.body.error).toBe("monitor_mode_upgrade_required");

    const rejectedOpen = await auth(request(app).post("/api/sessions").send({
      clientVersion: "0.2.5",
      protocolVersion: 1,
      schemaVersion: AGENT_HUB_SCHEMA_VERSION,
    }), owner.body.token);
    expect(rejectedOpen.status).toBe(409);
    expect(rejectedOpen.body.error).toBe("monitor_mode_upgrade_required");
    const rejectedHeartbeat = await auth(request(app)
      .post(`/api/sessions/${upgraded.body.session.id}/heartbeat`)
      .send({ clientVersion: "0.2.5", protocolVersion: 1 }), legacy.body.token);
    expect(rejectedHeartbeat.status).toBe(409);
    expect(rejectedHeartbeat.body.error).toBe("monitor_mode_upgrade_required");
  });

  it("keeps critical overlaps red but allows every non-exclusive write in monitor-only mode", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");
    await auth(request(app).post("/api/room/settings").send({
      blockingProtectionEnabled: false,
      riskRules: [{ kind: "extension", selector: ".ts", level: "blocking" }],
    }), owner.body.token);

    await auth(request(app).post("/api/leases").send({
      title: "Owner critical work",
      kind: "standard",
      paths: ["src/shared.ts"],
    }), owner.body.token);
    const criticalWarning = await auth(request(app).post("/api/leases").send({
      title: "Bob critical work",
      autoClaim: true,
      paths: ["src/shared.ts"],
    }), bob.body.token);
    expect(criticalWarning.body).toMatchObject({
      acquired: true,
      decision: "warn",
      conflicts: [expect.objectContaining({ severity: "critical", decision: "warn" })],
      releaseRequests: [],
    });

    await auth(request(app).post("/api/leases").send({
      title: "Owner ordinary notes",
      kind: "standard",
      paths: ["docs/notes.md"],
    }), owner.body.token);
    const ordinaryWarning = await auth(request(app).post("/api/leases").send({
      title: "Bob ordinary notes",
      autoClaim: true,
      paths: ["docs/notes.md"],
    }), bob.body.token);
    expect(ordinaryWarning.body.conflicts[0]).toMatchObject({
      severity: "warning",
      decision: "warn",
    });

    const exclusive = await auth(request(app).post("/api/leases").send({
      title: "Owner manual exclusive",
      kind: "exclusive",
      ttlMinutes: 60,
      paths: ["src/locked"],
    }), owner.body.token);
    expect(exclusive.body.acquired).toBe(true);
    const ownExclusiveWarning = await auth(request(app).post("/api/leases").send({
      title: "Owner Agent inside own exclusive",
      autoClaim: true,
      paths: ["src/locked/file.ts"],
    }), owner.body.token);
    expect(ownExclusiveWarning.body).toMatchObject({
      acquired: true,
      decision: "allow",
      lease: { id: exclusive.body.lease.id, managedBy: "manual" },
      conflicts: [],
      coverage: [{
        leaseId: exclusive.body.lease.id,
        managedBy: "manual",
        paths: ["src/locked/file.ts"],
        action: "covered",
      }],
    });
    const otherMemberDenied = await auth(request(app).post("/api/leases").send({
      title: "Bob inside owner exclusive",
      autoClaim: true,
      paths: ["src/locked/file.ts"],
    }), bob.body.token);
    expect(otherMemberDenied.body).toMatchObject({ acquired: false, decision: "deny" });

    const exclusiveClaimDenied = await auth(request(app).post("/api/leases").send({
      title: "Bob requests exclusive over active work",
      kind: "exclusive",
      ttlMinutes: 60,
      paths: ["src/shared.ts"],
    }), bob.body.token);
    expect(exclusiveClaimDenied.body).toMatchObject({ acquired: false, decision: "deny" });

    const uncovered = await auth(request(app).post("/api/edits/check").send({
      paths: ["src/uncovered-only.ts"],
    }), bob.body.token);
    expect(uncovered.body).toMatchObject({
      allowed: true,
      blockers: [],
      warnings: [expect.objectContaining({ code: "uncovered_path" })],
    });

    const bobSession = await auth(request(app).post("/api/sessions").send({
      task: "Large monitor-only path set",
    }), bob.body.token);
    const manyPaths = Array.from({ length: 101 }, (_, index) => `src/bulk/file-${index}.ts`);
    const bulkPrepared = await auth(request(app).post("/api/edits/prepare").send({
      sessionId: bobSession.body.session.id,
      title: "Large monitor-only path set",
      paths: manyPaths,
    }), bob.body.token);
    expect(bulkPrepared.status, JSON.stringify(bulkPrepared.body)).toBe(200);
    expect(bulkPrepared.body).toMatchObject({
      check: { allowed: true, blockers: [] },
      claim: { acquired: true },
    });

    const unknownPath = await auth(request(app).post("/api/edits/check").send({
      paths: ["C:/outside/repository.ts"],
    }), bob.body.token);
    expect(unknownPath.body).toMatchObject({
      allowed: true,
      blockers: [],
      warnings: [expect.objectContaining({ code: "coordination_warning" })],
    });
    const mixedExclusive = await auth(request(app).post("/api/edits/check").send({
      paths: ["C:/outside/repository.ts", "src/locked/file.ts"],
    }), bob.body.token);
    expect(mixedExclusive.body.allowed).toBe(false);
    expect(mixedExclusive.body.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "lease_conflict",
        conflict: expect.objectContaining({ decision: "deny", existingLeaseKind: "exclusive" }),
      }),
    ]));
    expect(mixedExclusive.body.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "coordination_warning" }),
    ]));
  });

  it("allows critical automatic overlap without downgrading its severity when protection is disabled", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");
    await createLease(app, owner.body.token, { title: "Scene work", paths: ["Assets/Scenes/Raid.unity"] });
    const denied = await auth(request(app).post("/api/leases").send({ title: "Automatic work", paths: ["Assets/Scenes/Raid.unity"], mode: "write", branch: "main", autoClaim: true }), bob.body.token);
    expect(denied.body).toMatchObject({ acquired: false, decision: "deny" });
    expect(denied.body.releaseRequests).toHaveLength(1);
    await auth(request(app).post("/api/room/settings").send({ blockingProtectionEnabled: false }), owner.body.token);
    const warning = await auth(request(app).post("/api/leases").send({ title: "Automatic work", paths: ["Assets/Scenes/Raid.unity"], mode: "write", branch: "main", autoClaim: true }), bob.body.token);
    expect(warning.body).toMatchObject({
      acquired: true,
      decision: "warn",
      lease: { kind: "automatic" },
      conflicts: [expect.objectContaining({ severity: "critical", decision: "warn" })],
    });
  });

  it("freezes a session and cancels only its Agent-managed leases when the branch changes", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const session = await auth(request(app).post("/api/sessions").send({ branch: "feature/a", baseCommit: "aaaa1111" }), owner.body.token);
    const agentLease = await auth(request(app).post("/api/leases").send({ title: "Agent work", paths: ["src/a.ts"], branch: "feature/a", baseCommit: "aaaa1111", sessionId: session.body.session.id, autoClaim: true }), owner.body.token);
    const manualLease = await auth(request(app).post("/api/leases").send({ title: "Manual work", paths: ["src/manual.ts"], branch: "feature/a", baseCommit: "aaaa1111", sessionId: session.body.session.id, kind: "standard" }), owner.body.token);
    expect(agentLease.body.acquired).toBe(true);
    expect(manualLease.body.acquired).toBe(true);
    const changed = await auth(request(app).post(`/api/sessions/${session.body.session.id}/sync`).send({ branch: "feature/b", baseCommit: "bbbb2222" }), owner.body.token);
    expect(changed.status).toBe(409);
    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases).toEqual([
      expect.objectContaining({ id: manualLease.body.lease.id, managedBy: "manual" }),
    ]);
    expect(dashboard.body.leases.map((lease: { id: string }) => lease.id)).not.toContain(agentLease.body.lease.id);
    expect(dashboard.body.sessions[0].status).toBe("frozen");
  });
  it("creates a room, stores only a token hash, joins a member, and protects the dashboard", async () => {
    const { app, database } = testApp();
    const created = await createRoom(app);

    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^ahm_/);
    expect(created.body.room.code).toBe(created.body.inviteCode);
    expect(created.body.room.projectName).toBe("Project Vanguard");

    const tokenRow = database.connection
      .prepare("SELECT token_hash FROM members WHERE id = ?")
      .get(created.body.member.id) as { token_hash: string };
    expect(tokenRow.token_hash).not.toBe(created.body.token);
    expect(tokenRow.token_hash).toMatch(/^[a-f0-9]{64}$/);

    const joined = await request(app).post("/api/rooms/join").send({
      inviteCode: created.body.inviteCode.toLowerCase(),
      memberName: "Bob",
      clientName: "Codex",
    });
    expect(joined.status).toBe(201);
    expect(joined.body.member).toMatchObject({ name: "Bob", role: "member" });

    const unauthorized = await request(app).get("/api/dashboard");
    expect(unauthorized.status).toBe(401);

    const dashboard = await auth(request(app).get("/api/dashboard"), joined.body.token);
    expect(dashboard.status).toBe(200);
    expect(Date.parse(dashboard.body.generatedAt)).not.toBeNaN();
    expect(dashboard.body.members.map((member: { name: string }) => member.name)).toEqual([
      "Alice",
      "Bob",
    ]);
    expect(dashboard.body.server.mcpUrl).toMatch(/\/mcp$/);
  });

  it("acquires ordinary and Luban warning overlaps while denying critical project resources", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const joined = await joinRoom(app, owner.body.inviteCode, "Bob");

    const first = await createLease(app, owner.body.token, {
      title: "Inventory transaction",
      paths: ["Assets/Vanguard/Inventory/InventoryService.cs"],
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ acquired: true, decision: "allow" });

    const warning = await createLease(app, joined.body.token, {
      title: "Equipment integration",
      paths: ["Assets/Vanguard/Inventory"],
    });
    expect(warning.status).toBe(201);
    expect(warning.body).toMatchObject({ acquired: true, decision: "warn" });
    expect(warning.body.conflicts[0]).toMatchObject({
      severity: "warning",
      requestedPath: "Assets/Vanguard/Inventory",
      memberName: "Alice",
    });

    const sceneLease = await createLease(app, owner.body.token, {
      title: "Raid scene setup",
      paths: ["Assets/Scenes/Raid.unity"],
    });
    expect(sceneLease.body.acquired).toBe(true);

    const deniedScene = await createLease(app, joined.body.token, {
      title: "Spawn point setup",
      paths: ["Assets/Scenes/Raid.unity"],
      overrideReason: "Try to force access",
    });
    expect(deniedScene.status).toBe(200);
    expect(deniedScene.body).toMatchObject({ acquired: false, decision: "deny" });
    expect(deniedScene.body.conflicts[0]).toMatchObject({ severity: "critical", decision: "deny" });

    const configLease = await createLease(app, owner.body.token, {
      title: "Luban weapon table",
      paths: ["Config/Luban/Weapon.xlsx"],
    });
    expect(configLease.body.acquired).toBe(true);
    const deniedConfig = await createLease(app, joined.body.token, {
      title: "Weapon balancing",
      paths: ["Config/Luban"],
      overrideReason: "Coordinate after editing",
    });
    expect(deniedConfig.body).toMatchObject({ acquired: true, decision: "warn" });
  });

  it("renews and expires leases, then records validation, risks, and handoff on close", async () => {
    let currentTime = Date.parse("2026-08-25T10:00:00.000Z");
    const { app } = testApp(() => new Date(currentTime));
    const owner = await createRoom(app);
    await auth(request(app).post("/api/room/settings").send({ automaticLeaseTtlMinutes: 5 }), owner.body.token);
    const lease = await createLease(app, owner.body.token, {
      title: "Weapon durability",
      paths: ["Assets/Vanguard/Combat/WeaponDurability.cs"],
      ttlMinutes: 1,
    });

    currentTime += 50_000;
    const renewed = await auth(
      request(app)
        .post(`/api/leases/${lease.body.lease.id}/renew`)
        .send({ ttlMinutes: 2 }),
      owner.body.token,
    );
    expect(renewed.status).toBe(200);

    currentTime += 20_000;
    let dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases).toHaveLength(1);

    const closed = await auth(
      request(app)
        .post(`/api/leases/${lease.body.lease.id}/close`)
        .send({
          outcome: "Durability is integrated without changing existing fire behavior.",
          changedPaths: ["Assets/Vanguard/Combat/WeaponDurability.cs"],
          commitHash: "abc1234",
          validations: ["EditMode durability tests passed"],
          remainingRisks: ["Unity Play Mode verification remains"],
          handoff: "Combat owner should verify zero-durability behavior.",
        }),
      owner.body.token,
    );
    expect(closed.status).toBe(200);
    expect(closed.body.lease.status).toBe("completed");
    expect(closed.body.records.map((record: { kind: string }) => record.kind).sort()).toEqual([
      "handoff",
      "risk",
      "validation",
    ]);

    dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases).toHaveLength(0);
    expect(dashboard.body.records).toHaveLength(3);

    const expiring = await createLease(app, owner.body.token, {
      title: "Temporary work",
      paths: ["Assets/Vanguard/UI/Hud.cs"],
      ttlMinutes: 1,
    });
    expect(expiring.body.acquired).toBe(true);
    currentTime += 301_000;
    dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases).toHaveLength(0);
    expect(dashboard.body.activity.some((item: { type: string }) => item.type === "lease.expired")).toBe(true);
  });

  it("refreshes the real expiry when a non-exclusive lease is reused", async () => {
    let currentTime = Date.parse("2026-08-25T10:00:00.000Z");
    const { app } = testApp(() => new Date(currentTime));
    const owner = await createRoom(app);
    await auth(request(app).post("/api/room/settings").send({ automaticLeaseTtlMinutes: 5 }), owner.body.token);
    const session = await auth(request(app).post("/api/sessions").send({ task: "Reuse lease" }), owner.body.token);
    const claim = () => auth(request(app).post("/api/leases").send({
      sessionId: session.body.session.id,
      title: "Reusable automatic scope",
      autoClaim: true,
      paths: ["src/reused.ts"],
    }), owner.body.token);
    const first = await claim();
    expect(first.body.lease.expiresAt).toBe("2026-08-25T10:05:00.000Z");

    currentTime += 4 * 60_000;
    const reused = await claim();
    expect(reused.body).toMatchObject({ acquired: true, lease: { id: first.body.lease.id } });
    expect(reused.body.lease.expiresAt).toBe("2026-08-25T10:09:00.000Z");

    currentTime += 2 * 60_000;
    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases.map((lease: { id: string }) => lease.id)).toContain(first.body.lease.id);
  });

  it("keeps same-member automatic sessions in one deterministic write lane", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const openSession = (codexSessionId: string) => auth(request(app).post("/api/sessions").send({
      codexSessionId,
      turnId: `${codexSessionId}-turn-0`,
      activityEpoch: 0,
    }), owner.body.token);
    const firstSession = await openSession("codex-lane-first");
    const secondSession = await openSession("codex-lane-second");
    const thirdSession = await openSession("codex-lane-third");

    const first = await auth(request(app).post("/api/leases").send({
      sessionId: firstSession.body.session.id,
      title: "First lane",
      autoClaim: true,
      paths: ["src/x"],
    }), owner.body.token);
    const second = await auth(request(app).post("/api/leases").send({
      sessionId: secondSession.body.session.id,
      title: "Second independent lane",
      autoClaim: true,
      paths: ["src/y"],
    }), owner.body.token);
    expect(first.body.acquired).toBe(true);
    expect(second.body.acquired).toBe(true);

    const waiting = await auth(request(app).post("/api/leases").send({
      sessionId: thirdSession.body.session.id,
      title: "Broad overlapping lane",
      autoClaim: true,
      paths: ["src"],
    }), owner.body.token);
    expect(waiting.body).toMatchObject({
      acquired: false,
      decision: "wait",
      conflicts: [],
      releaseRequests: [],
      waitingFor: { leaseId: first.body.lease.id, sessionId: firstSession.body.session.id },
    });

    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases.map((lease: { id: string }) => lease.id)).toEqual(
      expect.arrayContaining([first.body.lease.id, second.body.lease.id]),
    );
    expect(dashboard.body.leases).toHaveLength(2);
  });

  it("does not rewrite pre-existing same-member overlaps without local Git evidence", async () => {
    const { app, database } = testApp();
    const owner = await createRoom(app);
    const openSession = (codexSessionId: string) => auth(request(app).post("/api/sessions").send({
      codexSessionId,
      turnId: `${codexSessionId}-turn-0`,
      activityEpoch: 0,
    }), owner.body.token);
    const firstSession = await openSession("codex-existing-overlap-first");
    const secondSession = await openSession("codex-existing-overlap-second");
    const unrelatedSession = await openSession("codex-existing-overlap-unrelated");
    const waitingSession = await openSession("codex-existing-overlap-waiting");

    const first = await auth(request(app).post("/api/leases").send({
      sessionId: firstSession.body.session.id,
      title: "Existing broad scope",
      autoClaim: true,
      paths: ["src/shared"],
    }), owner.body.token);
    const second = await auth(request(app).post("/api/leases").send({
      sessionId: secondSession.body.session.id,
      title: "Legacy overlapping scope",
      autoClaim: true,
      paths: ["src/independent.ts"],
    }), owner.body.token);
    expect(first.body.acquired).toBe(true);
    expect(second.body.acquired).toBe(true);

    // Simulate an overlap persisted by an older version. The server has no Git
    // evidence proving either existing task is clean, so a later claim must not
    // arbitrate between them by creation time.
    database.connection.prepare(`
      UPDATE lease_paths SET path = 'src/shared/legacy.ts', path_key = 'src/shared/legacy.ts'
      WHERE lease_id = ?
    `).run(second.body.lease.id);

    const unrelated = await auth(request(app).post("/api/leases").send({
      sessionId: unrelatedSession.body.session.id,
      title: "Unrelated new scope",
      autoClaim: true,
      paths: ["docs/release.md"],
    }), owner.body.token);
    expect(unrelated.body.acquired).toBe(true);

    const waiting = await auth(request(app).post("/api/leases").send({
      sessionId: waitingSession.body.session.id,
      title: "Later overlapping scope",
      autoClaim: true,
      paths: ["src/shared/new.ts"],
    }), owner.body.token);
    expect(waiting.body).toMatchObject({
      acquired: false,
      decision: "wait",
      waitingFor: { leaseId: first.body.lease.id },
    });

    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases.map((lease: { id: string }) => lease.id)).toEqual(
      expect.arrayContaining([first.body.lease.id, second.body.lease.id, unrelated.body.lease.id]),
    );
    expect(dashboard.body.leases).toHaveLength(3);
  });

  it("keeps dirty passively blocked leases fenced across a new turn", async () => {
    let currentTime = Date.parse("2026-08-25T10:00:00.000Z");
    const { app } = testApp(() => new Date(currentTime));
    const owner = await createRoom(app);
    const firstSession = await auth(request(app).post("/api/sessions").send({
      codexSessionId: "codex-block-holder",
      turnId: "holder-turn-0",
      activityEpoch: 0,
    }), owner.body.token);
    const blockedSession = await auth(request(app).post("/api/sessions").send({
      codexSessionId: "codex-blocked-session",
      turnId: "blocked-turn-0",
      activityEpoch: 0,
    }), owner.body.token);
    const holder = await auth(request(app).post("/api/leases").send({
      sessionId: firstSession.body.session.id,
      title: "Holder",
      autoClaim: true,
      paths: ["src/holder.ts"],
    }), owner.body.token);
    const owned = await auth(request(app).post("/api/leases").send({
      sessionId: blockedSession.body.session.id,
      title: "Dirty task scope",
      autoClaim: true,
      paths: ["src/dirty.ts"],
    }), owner.body.token);
    expect(holder.body.acquired).toBe(true);
    expect(owned.body.acquired).toBe(true);
    const originalExpiry = owned.body.lease.expiresAt;

    const blocked = await auth(request(app)
      .post(`/api/sessions/${blockedSession.body.session.id}/write-blocked`)
      .send({ dirty: true, paths: ["src/holder.ts"], reason: "Waiting for the active holder." }), owner.body.token);
    expect(blocked.body).toEqual({ releasedLeaseIds: [], blockedLeaseIds: [owned.body.lease.id] });
    const repeated = await auth(request(app)
      .post(`/api/sessions/${blockedSession.body.session.id}/write-blocked`)
      .send({ dirty: true, paths: ["src/holder.ts"], reason: "Waiting for the active holder." }), owner.body.token);
    expect(repeated.body).toEqual(blocked.body);

    currentTime += 60_000;
    const advanced = await auth(request(app).post("/api/sessions").send({
      codexSessionId: "codex-blocked-session",
      turnId: "blocked-turn-1",
      activityEpoch: 1,
    }), owner.body.token);
    expect(advanced.body.session).toMatchObject({ currentTurnId: "blocked-turn-1", activityEpoch: 1 });
    const heartbeat = await auth(request(app)
      .post(`/api/sessions/${blockedSession.body.session.id}/heartbeat`)
      .send({}), owner.body.token);
    expect(heartbeat.body.renewedLeases.map((lease: { id: string }) => lease.id)).not.toContain(owned.body.lease.id);

    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases.find((lease: { id: string }) => lease.id === owned.body.lease.id)).toMatchObject({
      phase: "blocked",
      expiresAt: originalExpiry,
    });
    const denied = await auth(request(app).post("/api/leases").send({
      sessionId: blockedSession.body.session.id,
      title: "Bypass attempt",
      autoClaim: true,
      paths: ["src/new.ts"],
    }), owner.body.token);
    expect(denied.status).toBe(409);
    expect(denied.body.error).toBe("session_write_blocked");

    currentTime = Date.parse(originalExpiry) + 1;
    const expiredSync = await auth(request(app)
      .post(`/api/sessions/${blockedSession.body.session.id}/write-blocked`)
      .send({ dirty: true, paths: ["src/new.ts"], reason: "Recheck after the blocked lease TTL." }), owner.body.token);
    expect(expiredSync.body).toEqual({ releasedLeaseIds: [], blockedLeaseIds: [] });
  });

  it("clears legacy non-exclusive fences while preserving finalization and exclusive requests", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");
    const session = await auth(request(app).post("/api/sessions").send({
      codexSessionId: "codex-monitor-transition",
      turnId: "turn-current",
      activityEpoch: 3,
      branch: "feature/original",
    }), owner.body.token);
    const automatic = await auth(request(app).post("/api/leases").send({
      sessionId: session.body.session.id,
      title: "Dirty automatic work",
      autoClaim: true,
      paths: ["src/dirty.ts"],
    }), owner.body.token);
    await auth(request(app)
      .post(`/api/sessions/${session.body.session.id}/write-blocked`)
      .send({ dirty: true, paths: ["src/dirty.ts"], reason: "Legacy passive fence." }), owner.body.token);

    await auth(request(app).post("/api/leases").send({
      title: "Critical standard holder",
      kind: "standard",
      paths: ["Assets/Scenes/Shared.unity"],
    }), owner.body.token);
    const ordinaryDenied = await auth(request(app).post("/api/leases").send({
      title: "Ordinary blocked request",
      autoClaim: true,
      paths: ["Assets/Scenes/Shared.unity"],
    }), bob.body.token);
    expect(ordinaryDenied.body.conflicts[0]).toMatchObject({
      severity: "critical",
      decision: "deny",
      existingLeaseKind: "standard",
    });
    expect(ordinaryDenied.body.releaseRequests[0]).toMatchObject({ conflictingLeaseKind: "standard" });
    const exclusiveClaimDenied = await auth(request(app).post("/api/leases").send({
      title: "Manual exclusive request over ordinary work",
      kind: "exclusive",
      ttlMinutes: 60,
      paths: ["Assets/Scenes/Shared.unity"],
    }), bob.body.token);
    expect(exclusiveClaimDenied.body).toMatchObject({ acquired: false, decision: "deny" });
    expect(exclusiveClaimDenied.body.releaseRequests[0]).toMatchObject({
      requestedKind: "exclusive",
      conflictingLeaseKind: "standard",
    });
    const secondExclusiveClaimDenied = await auth(request(app).post("/api/leases").send({
      title: "Second manual exclusive request over ordinary work",
      kind: "exclusive",
      ttlMinutes: 30,
      paths: ["Assets/Scenes/Shared.unity"],
    }), bob.body.token);
    expect(secondExclusiveClaimDenied.body).toMatchObject({ acquired: false, decision: "deny" });
    expect(secondExclusiveClaimDenied.body.releaseRequests[0].id)
      .not.toBe(exclusiveClaimDenied.body.releaseRequests[0].id);

    await auth(request(app).post("/api/leases").send({
      title: "Manual exclusive holder",
      kind: "exclusive",
      ttlMinutes: 60,
      paths: ["src/exclusive"],
    }), owner.body.token);
    const exclusiveDenied = await auth(request(app).post("/api/leases").send({
      title: "Exclusive blocked request",
      autoClaim: true,
      paths: ["src/exclusive/file.ts"],
    }), bob.body.token);
    expect(exclusiveDenied.body.conflicts[0]).toMatchObject({
      severity: "critical",
      decision: "deny",
      existingLeaseKind: "exclusive",
    });
    expect(exclusiveDenied.body.releaseRequests[0]).toMatchObject({ conflictingLeaseKind: "exclusive" });

    const finalizationId = "monitor_transition_finalize";
    expect((await auth(request(app)
      .post(`/api/sessions/${session.body.session.id}/finalize/start`)
      .send({ finalizationId }), owner.body.token)).body.session.status).toBe("finalizing");
    expect((await auth(request(app).post("/api/room/settings").send({
      blockingProtectionEnabled: false,
    }), owner.body.token)).status).toBe(200);

    let dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.sessions.find(
      (item: { id: string }) => item.id === session.body.session.id,
    )).toMatchObject({ status: "finalizing" });
    expect(dashboard.body.leases.find(
      (item: { id: string }) => item.id === automatic.body.lease.id,
    )).toMatchObject({ phase: "awaiting_commit", decision: "warn" });
    expect(dashboard.body.conflicts.find(
      (item: { id: string }) => item.id === ordinaryDenied.body.conflicts[0].id,
    )).toMatchObject({
      severity: "critical",
      decision: "warn",
      existingLeaseKind: "standard",
    });
    expect(dashboard.body.conflicts.find(
      (item: { id: string }) => item.id === exclusiveClaimDenied.body.conflicts[0].id,
    )).toMatchObject({
      severity: "critical",
      decision: "deny",
      existingLeaseKind: "standard",
    });
    expect(dashboard.body.conflicts.find(
      (item: { id: string }) => item.id === secondExclusiveClaimDenied.body.conflicts[0].id,
    )).toMatchObject({
      severity: "critical",
      decision: "deny",
      existingLeaseKind: "standard",
    });
    expect(dashboard.body.conflicts.find(
      (item: { id: string }) => item.id === exclusiveDenied.body.conflicts[0].id,
    )).toMatchObject({
      severity: "critical",
      decision: "deny",
      existingLeaseKind: "exclusive",
    });

    const allRequests = await auth(request(app).get("/api/release-requests?status=all"), owner.body.token);
    expect(allRequests.body.releaseRequests.find(
      (item: { id: string }) => item.id === ordinaryDenied.body.releaseRequests[0].id,
    )).toMatchObject({ status: "cancelled", conflictingLeaseKind: "standard" });
    expect(allRequests.body.releaseRequests.find(
      (item: { id: string }) => item.id === exclusiveClaimDenied.body.releaseRequests[0].id,
    )).toMatchObject({
      status: "pending",
      requestedKind: "exclusive",
      conflictingLeaseKind: "standard",
    });
    expect(allRequests.body.releaseRequests.find(
      (item: { id: string }) => item.id === secondExclusiveClaimDenied.body.releaseRequests[0].id,
    )).toMatchObject({ status: "pending", requestedKind: "exclusive" });
    expect(allRequests.body.releaseRequests.find(
      (item: { id: string }) => item.id === exclusiveDenied.body.releaseRequests[0].id,
    )).toMatchObject({ status: "pending", conflictingLeaseKind: "exclusive" });

    const prepared = await auth(request(app).post("/api/edits/prepare").send({
      sessionId: session.body.session.id,
      title: "Continue finalizing generation in monitor mode",
      branch: "feature/observed",
      baseCommit: "bbbb2222",
      paths: ["src/dirty.ts"],
      turnId: "turn-stale",
      activityEpoch: 1,
    }), owner.body.token);
    expect(prepared.status).toBe(200);
    expect(prepared.body.check).toMatchObject({ allowed: true, blockers: [] });
    expect(prepared.body.check.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "coordination_warning" }),
    ]));
    expect((await auth(request(app)
      .post(`/api/sessions/${session.body.session.id}/write-blocked`)
      .send({ dirty: true, paths: ["src/dirty.ts"] }), owner.body.token)).body).toEqual({
      releasedLeaseIds: [],
      blockedLeaseIds: [],
    });

    dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.sessions.find(
      (item: { id: string }) => item.id === session.body.session.id,
    )).toMatchObject({ status: "finalizing", branch: "feature/observed" });

    expect((await auth(request(app).post("/api/room/settings").send({
      blockingProtectionEnabled: true,
    }), owner.body.token)).status).toBe(200);
    dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.conflicts.find(
      (item: { id: string }) => item.id === ordinaryDenied.body.conflicts[0].id,
    )).toBeUndefined();
    expect(dashboard.body.conflicts.find(
      (item: { id: string }) => item.id === exclusiveClaimDenied.body.conflicts[0].id,
    )).toMatchObject({ severity: "critical", decision: "deny" });
    expect(dashboard.body.conflicts.find(
      (item: { id: string }) => item.id === secondExclusiveClaimDenied.body.conflicts[0].id,
    )).toMatchObject({ severity: "critical", decision: "deny" });

    const deniedAgain = await auth(request(app).post("/api/leases").send({
      title: "Ordinary blocked request",
      autoClaim: true,
      paths: ["Assets/Scenes/Shared.unity"],
    }), bob.body.token);
    expect(deniedAgain.body).toMatchObject({ acquired: false, decision: "deny" });
    expect(deniedAgain.body.releaseRequests[0]).toMatchObject({ status: "pending" });
    expect(deniedAgain.body.releaseRequests[0].id).not.toBe(ordinaryDenied.body.releaseRequests[0].id);
    dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.releaseRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: deniedAgain.body.releaseRequests[0].id, status: "pending" }),
    ]));
  });

  it("keeps dashboard scan polling compact regardless of stored scan evidence", async () => {
    const { app, database } = testApp();
    const owner = await createRoom(app);
    const opened = await auth(request(app).post("/api/sessions").send({ task: "Large scan history" }), owner.body.token);
    const insert = database.connection.prepare(`
      INSERT INTO local_scans (
        id, session_id, room_id, member_id, repository, branch, worktree, base_commit,
        changed_paths_json, rule_files_json, systems_json, metadata_json, scanned_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, '[]', '[]', '[]', ?, ?)
    `);
    for (let index = 0; index < 65; index += 1) {
      insert.run(
        `large-scan-${String(index).padStart(2, "0")}`,
        opened.body.session.id,
        owner.body.room.id,
        owner.body.member.id,
        JSON.stringify({ evidence: "x".repeat(20_000) }),
        new Date(Date.parse("2026-08-25T10:00:00.000Z") + index).toISOString(),
      );
    }

    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.localScans).toEqual([{
      id: "large-scan-64",
      sessionId: opened.body.session.id,
      memberId: owner.body.member.id,
      scannedAt: "2026-08-25T10:00:00.064Z",
    }]);
    expect(Buffer.byteLength(JSON.stringify(dashboard.body), "utf8")).toBeLessThan(128 * 1024);
  });

  it("keeps non-scan dashboard history below the desktop proxy response limit", async () => {
    const { app, database } = testApp();
    const owner = await createRoom(app);
    const riskRules = Array.from({ length: 100 }, (_, index) => ({
      kind: "directory",
      selector: `src/rule-${index}-${"r".repeat(1_000)}`,
      level: "warning",
    }));
    const settings = await auth(request(app).post("/api/room/settings").send({ riskRules }), owner.body.token);
    expect(settings.status).toBe(200);
    const opened = await auth(request(app).post("/api/sessions").send({
      task: "Large dashboard history",
      metadata: { evidence: "s".repeat(31_000) },
    }), owner.body.token);
    expect(opened.status).toBe(201);

    const insert = database.connection.prepare(`
      INSERT INTO records (
        id, room_id, member_id, kind, title, summary, paths_json, status,
        evidence_json, commit_hash, created_at
      ) VALUES (?, ?, ?, 'risk', ?, ?, '["src/large.ts"]', 'open', ?, NULL, ?)
    `);
    const evidence = JSON.stringify(Array.from({ length: 100 }, () => "测".repeat(1_200)));
    for (let index = 0; index < 4; index += 1) {
      insert.run(
        `large-record-${index}`,
        owner.body.room.id,
        owner.body.member.id,
        `Large record ${index}`,
        "s".repeat(12_000),
        evidence,
        new Date(Date.parse("2026-08-25T10:00:00.000Z") + index).toISOString(),
      );
    }

    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.status).toBe(200);
    expect(Buffer.byteLength(dashboard.text, "utf8")).toBeLessThan(768 * 1024);
    expect(dashboard.body.partialSections).toContain("records");
    expect(dashboard.body.sectionTotals.records).toBe(4);
    expect(dashboard.body.records.length).toBeGreaterThan(0);
    expect(dashboard.body.records.length).toBeLessThan(4);
    expect(dashboard.body.settings.riskRules).toHaveLength(riskRules.length);
    expect(dashboard.body.settings.riskRules.at(-1)).toMatchObject(riskRules.at(-1)!);
    expect(dashboard.body.sessions[0]).not.toHaveProperty("metadata");
    expect(dashboard.body.sessions[0]).not.toHaveProperty("repository");
    expect(dashboard.body.activity[0]).not.toHaveProperty("metadata");

    const saved = await auth(request(app).post("/api/room/settings").send({
      automaticLeaseTtlMinutes: 30,
      riskRules: dashboard.body.settings.riskRules,
    }), owner.body.token);
    expect(saved.status).toBe(200);
    const persisted = await auth(request(app).get("/api/room/settings"), owner.body.token);
    expect(persisted.body.settings.automaticLeaseTtlMinutes).toBe(30);
    expect(persisted.body.settings.riskRules).toHaveLength(riskRules.length);
    expect(persisted.body.settings.riskRules.at(-1)).toMatchObject(riskRules.at(-1)!);
  });

  it("reports real dashboard totals and marks SQL display windows as partial", async () => {
    const { app, database } = testApp();
    const owner = await createRoom(app);
    const insertRecord = database.connection.prepare(`
      INSERT INTO records (
        id, room_id, member_id, kind, title, summary, paths_json, status,
        evidence_json, commit_hash, created_at
      ) VALUES (?, ?, ?, 'risk', ?, 'summary', '[]', 'open', '[]', NULL, ?)
    `);
    const insertSession = database.connection.prepare(`
      INSERT INTO work_sessions (
        id, room_id, member_id, status, branch_epoch, metadata_json,
        opened_at, last_seen_at, activity_epoch
      ) VALUES (?, ?, ?, 'active', 1, '{}', ?, ?, 0)
    `);
    const insertActivity = database.connection.prepare(`
      INSERT INTO activities (
        id, room_id, actor_member_id, actor_name, type, entity_type,
        entity_id, summary, metadata_json, created_at
      ) VALUES (?, ?, ?, 'Alice', 'test.activity', 'test', NULL, 'summary', '{}', ?)
    `);
    database.transaction(() => {
      for (let index = 0; index < 501; index += 1) {
        const timestamp = new Date(Date.parse("2026-08-25T10:00:00.000Z") + index).toISOString();
        insertRecord.run(
          `window-record-${String(index).padStart(3, "0")}`,
          owner.body.room.id,
          owner.body.member.id,
          `Record ${index}`,
          timestamp,
        );
        insertSession.run(
          `window-session-${String(index).padStart(3, "0")}`,
          owner.body.room.id,
          owner.body.member.id,
          timestamp,
          timestamp,
        );
      }
      for (let index = 0; index < 101; index += 1) {
        insertActivity.run(
          `window-activity-${String(index).padStart(3, "0")}`,
          owner.body.room.id,
          owner.body.member.id,
          new Date(Date.parse("2026-08-25T11:00:00.000Z") + index).toISOString(),
        );
      }
    });

    const expected = database.connection.prepare(`
      SELECT
        (SELECT COUNT(*) FROM records WHERE room_id = ?) AS records,
        (SELECT COUNT(*) FROM work_sessions WHERE room_id = ? AND status <> 'closed') AS sessions,
        (SELECT COUNT(*) FROM activities WHERE room_id = ?) AS activity
    `).get(owner.body.room.id, owner.body.room.id, owner.body.room.id) as {
      records: number;
      sessions: number;
      activity: number;
    };
    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.sectionTotals).toMatchObject(expected);
    expect(dashboard.body.records).toHaveLength(500);
    expect(dashboard.body.sessions).toHaveLength(500);
    expect(dashboard.body.activity).toHaveLength(100);
    expect(dashboard.body.partialSections).toEqual(expect.arrayContaining([
      "records",
      "sessions",
      "activity",
    ]));
  });

  it("filters pending handover requests by holder before applying the dashboard limit", async () => {
    const { app, database } = testApp();
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");
    const carol = await joinRoom(app, owner.body.inviteCode, "Carol");
    const ownerLease = await auth(request(app).post("/api/leases").send({
      title: "Owner holder",
      kind: "standard",
      paths: ["src/owner.ts"],
    }), owner.body.token);
    const bobLease = await auth(request(app).post("/api/leases").send({
      title: "Bob holder",
      kind: "standard",
      paths: ["src/bob.ts"],
    }), bob.body.token);
    const insertRequest = database.connection.prepare(`
      INSERT INTO release_requests (
        id, room_id, requester_member_id, requester_session_id, requester_lease_id,
        conflicting_lease_id, request_title, request_objective, requested_kind,
        requested_mode, requested_branch, requested_base_commit, requested_ttl_minutes,
        requested_paths_json, overlap_paths_json, reason, transfer_key, dedupe_key,
        status, requested_at, last_requested_at
      ) VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, 'automatic', 'write', NULL, NULL, 15,
        ?, ?, 'test request', ?, ?, 'pending', ?, ?)
    `);
    const insertForHolder = (
      id: string,
      leaseId: string,
      path: string,
      timestamp: string,
    ) => insertRequest.run(
      id,
      owner.body.room.id,
      carol.body.member.id,
      leaseId,
      id,
      JSON.stringify([path]),
      JSON.stringify([{ requestedPath: path, existingPath: path }]),
      `transfer-${id}`,
      `dedupe-${id}`,
      timestamp,
      timestamp,
    );
    database.transaction(() => {
      insertForHolder("older-owner-request", ownerLease.body.lease.id, "src/owner.ts", "2026-08-25T09:00:00.000Z");
      for (let index = 0; index < 500; index += 1) {
        insertForHolder(
          `newer-bob-request-${String(index).padStart(3, "0")}`,
          bobLease.body.lease.id,
          "src/bob.ts",
          new Date(Date.parse("2026-08-25T10:00:00.000Z") + index).toISOString(),
        );
      }
    });

    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.releaseRequests).toEqual([
      expect.objectContaining({ id: "older-owner-request", holderMemberId: owner.body.member.id }),
    ]);
    expect(dashboard.body.sectionTotals.releaseRequests).toBe(1);
  });

  it("keeps the newest holder handover actionable before large lease scopes consume the dashboard budget", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");
    await auth(request(app).post("/api/leases").send({
      title: "Scene holder",
      kind: "standard",
      paths: ["Assets/Scenes"],
    }), owner.body.token);

    for (let leaseIndex = 0; leaseIndex < 8; leaseIndex += 1) {
      const paths = Array.from({ length: 100 }, (_, pathIndex) =>
        `bulk-${leaseIndex}/scope-${pathIndex}-${"x".repeat(960)}.cs`);
      const largeLease = await auth(request(app).post("/api/leases").send({
        title: `Large valid lease ${leaseIndex}`,
        kind: "standard",
        paths,
      }), owner.body.token);
      expect(largeLease.status).toBe(201);
    }

    const requestedPaths = Array.from({ length: 100 }, (_, pathIndex) =>
      `Assets/Scenes/request-${pathIndex}-${"y".repeat(900)}.unity`);
    const blocked = await auth(request(app).post("/api/leases").send({
      title: "Large scene handover",
      autoClaim: true,
      paths: requestedPaths,
    }), bob.body.token);
    expect(blocked.body).toMatchObject({ acquired: false, decision: "deny" });
    const requestId = blocked.body.releaseRequests[0].id;

    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.status).toBe(200);
    expect(Buffer.byteLength(dashboard.text, "utf8")).toBeLessThan(768 * 1024);
    expect(dashboard.body.partialSections).toEqual(expect.arrayContaining(["leases", "conflicts"]));
    expect(dashboard.body.releaseRequests).toEqual([
      expect.objectContaining({
        id: requestId,
        holderMemberId: owner.body.member.id,
        requestedPaths,
        overlapPaths: [],
      }),
    ]);

    const fullRequests = await auth(request(app).get("/api/release-requests?status=pending"), owner.body.token);
    const fullRequest = fullRequests.body.releaseRequests.find(
      (releaseRequest: { id: string }) => releaseRequest.id === requestId,
    );
    expect(fullRequest.requestedPaths).toEqual(requestedPaths);
    expect(fullRequest.overlapPaths).toHaveLength(requestedPaths.length);

    const rejected = await auth(request(app)
      .post(`/api/release-requests/${requestId}/resolve`)
      .send({ decision: "reject", reason: "Owner is still working in this scene." }), owner.body.token);
    expect(rejected.status).toBe(200);
    expect(rejected.body.releaseRequest).toMatchObject({ id: requestId, status: "rejected" });
  });

  it("returns a compact capacity error when corrupted core dashboard data exceeds its budget", async () => {
    const { app, database } = testApp();
    const owner = await createRoom(app);
    database.connection.prepare("UPDATE rooms SET repository = ? WHERE id = ?")
      .run("测".repeat(400_000), owner.body.room.id);

    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.status).toBe(507);
    expect(dashboard.body).toEqual({
      error: "dashboard_capacity_exceeded",
      message: "The dashboard core state exceeds the safe desktop response budget.",
    });
    expect(Buffer.byteLength(JSON.stringify(dashboard.body), "utf8")).toBeLessThan(1024);
  });

  it("deduplicates release requests and atomically transfers only conflicting standard paths", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");
    await auth(request(app).post("/api/room/settings").send({
      riskRules: [{ kind: "extension", selector: ".cs", level: "blocking" }],
    }), owner.body.token);
    const holder = await auth(request(app).post("/api/leases").send({
      title: "Two independent paths",
      kind: "standard",
      paths: ["src/critical.cs", "src/unrelated.cs"],
    }), owner.body.token);

    const firstBlocked = await auth(request(app).post("/api/leases").send({
      title: "Critical change",
      autoClaim: true,
      paths: ["src/critical.cs"],
    }), bob.body.token);
    const repeated = await auth(request(app).post("/api/leases").send({
      title: "Critical change",
      autoClaim: true,
      paths: ["src/critical.cs"],
    }), bob.body.token);
    expect(firstBlocked.body).toMatchObject({ acquired: false, decision: "deny" });
    expect(repeated.body.releaseRequests[0].id).toBe(firstBlocked.body.releaseRequests[0].id);
    expect(repeated.body.releaseRequests[0].occurrenceCount).toBe(2);

    const holderDashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    const requesterDashboard = await auth(request(app).get("/api/dashboard"), bob.body.token);
    expect(holderDashboard.body.releaseRequests).toEqual([
      expect.objectContaining({ id: firstBlocked.body.releaseRequests[0].id }),
    ]);
    expect(requesterDashboard.body.releaseRequests).toEqual([]);

    const forbidden = await auth(request(app)
      .post(`/api/release-requests/${firstBlocked.body.releaseRequests[0].id}/resolve`)
      .send({ decision: "approve" }), bob.body.token);
    expect(forbidden.status).toBe(403);
    const approved = await auth(request(app)
      .post(`/api/release-requests/${firstBlocked.body.releaseRequests[0].id}/resolve`)
      .send({ decision: "approve" }), owner.body.token);
    expect(approved.body.releaseRequest).toMatchObject({
      status: "approved",
      transferredLeaseId: expect.any(String),
    });

    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    const original = dashboard.body.leases.find((lease: { id: string }) => lease.id === holder.body.lease.id);
    expect(original.paths).toEqual(["src/unrelated.cs"]);
    const transferred = dashboard.body.leases.find(
      (lease: { id: string }) => lease.id === approved.body.releaseRequest.transferredLeaseId,
    );
    expect(transferred).toMatchObject({ memberName: "Bob", kind: "automatic", paths: ["src/critical.cs"] });
    const retried = await auth(request(app).post("/api/leases").send({
      title: "Critical change",
      autoClaim: true,
      paths: ["src/critical.cs"],
    }), bob.body.token);
    expect(retried.body).toMatchObject({
      acquired: true,
      lease: { id: approved.body.releaseRequest.transferredLeaseId },
    });
    const mixedLegacyRetry = await auth(request(app).post("/api/leases").send({
      title: "Legacy retry with a new path",
      autoClaim: true,
      paths: ["src/critical.cs", "src/new.cs"],
    }), bob.body.token);
    expect(mixedLegacyRetry.body).toMatchObject({
      acquired: true,
      lease: { managedBy: "agent", createdVia: "legacy" },
    });
    expect(mixedLegacyRetry.body.lease.id).not.toBe(approved.body.releaseRequest.transferredLeaseId);
    const afterMixedRetry = await auth(request(app).get("/api/dashboard"), bob.body.token);
    expect(afterMixedRetry.body.leases.find(
      (lease: { id: string }) => lease.id === approved.body.releaseRequest.transferredLeaseId,
    ).paths).toEqual(["src/critical.cs"]);
  });

  it("keeps a broad holder scope while carving out an approved child path for the requester", async () => {
    const { app, database } = testApp();
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");
    const carol = await joinRoom(app, owner.body.inviteCode, "Carol");
    await auth(request(app).post("/api/room/settings").send({
      riskRules: [{ kind: "extension", selector: ".ts", level: "blocking" }],
    }), owner.body.token);
    const bobSession = await auth(request(app).post("/api/sessions").send({ task: "Edit child path" }), bob.body.token);
    const ownerSession = await auth(request(app).post("/api/sessions").send({ task: "Continue broad work" }), owner.body.token);
    const holder = await auth(request(app).post("/api/leases").send({
      title: "Broad source work",
      kind: "standard",
      paths: ["src"],
    }), owner.body.token);
    const blocked = await auth(request(app).post("/api/leases").send({
      sessionId: bobSession.body.session.id,
      title: "Precise source change",
      autoClaim: true,
      paths: ["src/a.ts"],
    }), bob.body.token);
    expect(blocked.body).toMatchObject({ acquired: false, decision: "deny" });
    const carolPending = await auth(request(app).post("/api/leases").send({
      title: "Concurrent precise source change",
      autoClaim: true,
      paths: ["src/a.ts"],
    }), carol.body.token);
    expect(carolPending.body).toMatchObject({ acquired: false, decision: "deny" });

    const approved = await auth(request(app)
      .post(`/api/release-requests/${blocked.body.releaseRequests[0].id}/resolve`)
      .send({ decision: "approve" }), owner.body.token);
    const transferredLeaseId = approved.body.releaseRequest.transferredLeaseId as string;
    const afterTransfer = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(afterTransfer.body.leases.find(
      (lease: { id: string }) => lease.id === holder.body.lease.id,
    )).toMatchObject({ paths: ["src"] });
    expect(afterTransfer.body.leases.find(
      (lease: { id: string }) => lease.id === transferredLeaseId,
    )).toMatchObject({ memberName: "Bob", paths: ["src/a.ts"] });
    const resolvedConflicts = database.connection.prepare(`
      SELECT COUNT(*) AS count FROM conflicts
      WHERE requester_member_id = ? AND existing_lease_id = ?
        AND requested_path = ? AND existing_path = ?
    `).get(bob.body.member.id, holder.body.lease.id, "src/a.ts", "src") as { count: number };
    expect(resolvedConflicts.count).toBe(0);

    const requesterRetry = await auth(request(app).post("/api/leases").send({
      sessionId: bobSession.body.session.id,
      title: "Precise source change",
      autoClaim: true,
      paths: ["src/a.ts"],
    }), bob.body.token);
    expect(requesterRetry.body).toMatchObject({ acquired: true, lease: { id: transferredLeaseId } });
    const staleApproval = await auth(request(app)
      .post(`/api/release-requests/${carolPending.body.releaseRequests[0].id}/resolve`)
      .send({ decision: "approve" }), owner.body.token);
    expect(staleApproval.status).toBe(409);
    expect(staleApproval.body.error).toBe("release_request_conflict_changed");
    const pendingAfterRace = await auth(request(app).get("/api/release-requests"), owner.body.token);
    expect(pendingAfterRace.body.releaseRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: carolPending.body.releaseRequests[0].id, status: "pending" }),
    ]));
    const siblingRetry = await auth(request(app).post("/api/leases").send({
      sessionId: bobSession.body.session.id,
      title: "Attempt sibling source path",
      autoClaim: true,
      paths: ["src/b.ts"],
    }), bob.body.token);
    expect(siblingRetry.body).toMatchObject({ acquired: false, decision: "deny" });

    const formerHolder = await auth(request(app).post("/api/leases").send({
      sessionId: ownerSession.body.session.id,
      title: "Attempt transferred child",
      autoClaim: true,
      paths: ["src/a.ts"],
    }), owner.body.token);
    const thirdParty = await auth(request(app).post("/api/leases").send({
      title: "Third-party child edit",
      autoClaim: true,
      paths: ["src/a.ts"],
    }), carol.body.token);
    expect(formerHolder.body).toMatchObject({ acquired: false, decision: "deny" });
    expect(thirdParty.body).toMatchObject({ acquired: false, decision: "deny" });
    expect(formerHolder.body.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ leaseId: transferredLeaseId, decision: "deny" }),
    ]));
  });

  it("attributes Agent work to and heartbeat-renews a member's sessionless manual standard lease", async () => {
    let currentTime = Date.parse("2026-08-25T10:00:00.000Z");
    const { app } = testApp(() => new Date(currentTime));
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");
    await auth(request(app).post("/api/room/settings").send({ automaticLeaseTtlMinutes: 5 }), owner.body.token);
    const manual = await auth(request(app).post("/api/leases").send({
      title: "Shared manual scene range",
      kind: "standard",
      paths: ["Assets/Scenes/Main.unity"],
    }), owner.body.token);
    const session = await auth(request(app).post("/api/sessions").send({ task: "Scene Agent work" }), owner.body.token);
    const agentLease = await auth(request(app).post("/api/leases").send({
      sessionId: session.body.session.id,
      title: "Agent scene work",
      autoClaim: true,
      paths: ["Assets/Scenes/Main.unity"],
    }), owner.body.token);
    expect(agentLease.body).toMatchObject({
      acquired: true,
      decision: "allow",
      lease: { id: manual.body.lease.id, managedBy: "manual" },
      coverage: [{
        leaseId: manual.body.lease.id,
        managedBy: "manual",
        paths: ["Assets/Scenes/Main.unity"],
        action: "covered",
      }],
    });

    const otherMember = await auth(request(app).post("/api/leases").send({
      title: "Other member scene work",
      autoClaim: true,
      paths: ["Assets/Scenes/Main.unity"],
    }), bob.body.token);
    expect(otherMember.body).toMatchObject({ acquired: false, decision: "deny" });

    currentTime += 4 * 60_000;
    const heartbeat = await auth(request(app)
      .post(`/api/sessions/${session.body.session.id}/heartbeat`)
      .send({}), owner.body.token);
    const renewedIds = heartbeat.body.renewedLeases.map((lease: { id: string }) => lease.id);
    expect(renewedIds).toContain(manual.body.lease.id);
    currentTime += 2 * 60_000;
    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases.map((lease: { id: string }) => lease.id)).toEqual([manual.body.lease.id]);
  });

  it("transactionally cancels a removed member's leases and pending release requests", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");
    const carol = await joinRoom(app, owner.body.inviteCode, "Carol");
    await auth(request(app).post("/api/room/settings").send({
      riskRules: [{ kind: "extension", selector: ".ts", level: "blocking" }],
    }), owner.body.token);
    const ownerLease = await auth(request(app).post("/api/leases").send({
      title: "Owner scope",
      kind: "standard",
      paths: ["src/owner.ts"],
    }), owner.body.token);
    const bobLease = await auth(request(app).post("/api/leases").send({
      title: "Bob scope",
      kind: "standard",
      paths: ["src/bob.ts"],
    }), bob.body.token);
    const bobAsRequester = await auth(request(app).post("/api/leases").send({
      title: "Bob requests owner scope",
      autoClaim: true,
      paths: ["src/owner.ts"],
    }), bob.body.token);
    const bobAsHolder = await auth(request(app).post("/api/leases").send({
      title: "Carol requests Bob scope",
      autoClaim: true,
      paths: ["src/bob.ts"],
    }), carol.body.token);
    const pendingIds = [
      bobAsRequester.body.releaseRequests[0].id,
      bobAsHolder.body.releaseRequests[0].id,
    ];

    const removed = await auth(request(app)
      .post(`/api/room/members/${bob.body.member.id}/remove`)
      .send({}), owner.body.token);
    expect(removed.status).toBe(204);
    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases.map((lease: { id: string }) => lease.id)).toContain(ownerLease.body.lease.id);
    expect(dashboard.body.leases.map((lease: { id: string }) => lease.id)).not.toContain(bobLease.body.lease.id);
    const requests = await auth(request(app).get("/api/release-requests?status=all"), owner.body.token);
    expect(requests.body.releaseRequests.filter(
      (releaseRequest: { id: string }) => pendingIds.includes(releaseRequest.id),
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pendingIds[0], status: "cancelled" }),
      expect.objectContaining({ id: pendingIds[1], status: "cancelled" }),
    ]));
    const activity = await auth(request(app).get("/api/activity"), owner.body.token);
    expect(activity.body.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "member.removed",
        metadata: expect.objectContaining({
          cancelledLeaseCount: 1,
          cancelledReleaseRequestCount: 2,
        }),
      }),
    ]));
  });

  it("includes current room settings and pending release requests in the room snapshot", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");
    await auth(request(app).post("/api/room/settings").send({
      automaticLeaseTtlMinutes: 15,
      riskRules: [{ kind: "extension", selector: ".ts", level: "blocking" }],
    }), owner.body.token);
    await auth(request(app).post("/api/leases").send({
      title: "Snapshot holder",
      kind: "standard",
      paths: ["src/snapshot.ts"],
    }), owner.body.token);
    const blocked = await auth(request(app).post("/api/leases").send({
      title: "Snapshot requester",
      autoClaim: true,
      paths: ["src/snapshot.ts"],
    }), bob.body.token);

    const snapshot = await auth(request(app).get("/api/snapshot"), owner.body.token);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.settings).toMatchObject({
      automaticLeaseTtlMinutes: 15,
      blockingProtectionEnabled: true,
      riskPolicyVersion: 2,
    });
    expect(snapshot.body.settings.riskRules).toEqual([
      expect.objectContaining({ kind: "extension", selector: ".ts", level: "blocking" }),
    ]);
    expect(snapshot.body.releaseRequests).toEqual([
      expect.objectContaining({ id: blocked.body.releaseRequests[0].id, status: "pending" }),
    ]);
  });

  it("keeps exclusive leases blocking when protection is off and never heartbeat-renews them", async () => {
    let currentTime = Date.parse("2026-08-25T10:00:00.000Z");
    const { app } = testApp(() => new Date(currentTime));
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");
    await auth(request(app).post("/api/room/settings").send({
      blockingProtectionEnabled: false,
      automaticLeaseTtlMinutes: 5,
      maximumExclusiveLeaseMinutes: 60,
    }), owner.body.token);
    const session = await auth(request(app).post("/api/sessions").send({
      clientVersion: AGENT_HUB_VERSION,
      protocolVersion: AGENT_HUB_PROTOCOL_VERSION,
      schemaVersion: AGENT_HUB_SCHEMA_VERSION,
    }), owner.body.token);
    const automatic = await auth(request(app).post("/api/leases").send({
      sessionId: session.body.session.id,
      title: "Automatic source work",
      autoClaim: true,
      paths: ["src/automatic.ts"],
    }), owner.body.token);
    const exclusive = await auth(request(app).post("/api/leases").send({
      sessionId: session.body.session.id,
      title: "Manual exclusive data",
      kind: "exclusive",
      ttlMinutes: 5,
      paths: ["Config/Luban"],
    }), owner.body.token);
    const blocked = await auth(request(app).post("/api/leases").send({
      title: "Luban edit",
      autoClaim: true,
      paths: ["Config/Luban/Weapon.xlsx"],
    }), bob.body.token);
    expect(blocked.body).toMatchObject({ acquired: false, decision: "deny" });
    expect(blocked.body.conflicts[0].existingLeaseKind).toBe("exclusive");

    currentTime += 4 * 60_000;
    const heartbeat = await auth(request(app)
      .post(`/api/sessions/${session.body.session.id}/heartbeat`)
      .send({
        clientVersion: AGENT_HUB_VERSION,
        protocolVersion: AGENT_HUB_PROTOCOL_VERSION,
        schemaVersion: AGENT_HUB_SCHEMA_VERSION,
      }), owner.body.token);
    expect(heartbeat.body.renewedLeases.map((lease: { id: string }) => lease.id)).toContain(automatic.body.lease.id);
    expect(heartbeat.body.renewedLeases.map((lease: { id: string }) => lease.id)).not.toContain(exclusive.body.lease.id);
    currentTime += 2 * 60_000;
    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases.map((lease: { id: string }) => lease.id)).toContain(automatic.body.lease.id);
    expect(dashboard.body.leases.map((lease: { id: string }) => lease.id)).not.toContain(exclusive.body.lease.id);
  });

  it("ends an entire exclusive lease when its holder approves one precise path", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const bob = await joinRoom(app, owner.body.inviteCode, "Bob");
    await auth(request(app).post("/api/room/settings").send({ blockingProtectionEnabled: false }), owner.body.token);
    const exclusive = await auth(request(app).post("/api/leases").send({
      title: "Exclusive systems",
      kind: "exclusive",
      ttlMinutes: 60,
      paths: ["Assets/SystemA", "Assets/SystemB"],
    }), owner.body.token);
    const blocked = await auth(request(app).post("/api/leases").send({
      title: "System A edit",
      autoClaim: true,
      paths: ["Assets/SystemA/Feature.cs"],
    }), bob.body.token);
    const approved = await auth(request(app)
      .post(`/api/release-requests/${blocked.body.releaseRequests[0].id}/resolve`)
      .send({ decision: "approve" }), owner.body.token);
    expect(approved.body.releaseRequest).toMatchObject({
      status: "approved",
      conflictingLeaseKind: "exclusive",
      requestedPaths: ["Assets/SystemA/Feature.cs"],
      transferredLeaseId: expect.any(String),
    });
    const dashboard = await auth(request(app).get("/api/dashboard"), owner.body.token);
    expect(dashboard.body.leases.map((lease: { id: string }) => lease.id)).not.toContain(exclusive.body.lease.id);
    expect(dashboard.body.leases.find(
      (lease: { id: string }) => lease.id === approved.body.releaseRequest.transferredLeaseId,
    )).toMatchObject({ memberName: "Bob", paths: ["Assets/SystemA/Feature.cs"] });
  });

  it("stores structured context, decisions, verification, handoffs, sessions, and local scan metadata", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const token = owner.body.token;

    const session = await auth(
      request(app).post("/api/sessions").send({
        clientName: "Agent Hub desktop",
        agentName: "Codex",
        repository: "https://github.com/example/projectvanguard.git",
        branch: "feature/durability",
        baseCommit: "deadbeef",
        worktree: "D:/UGit/projectvanguard",
        task: "Add weapon durability",
        metadata: { processId: 42 },
      }),
      token,
    );
    expect(session.status).toBe(201);

    const scan = await auth(
      request(app).post(`/api/sessions/${session.body.session.id}/scan`).send({
        changedPaths: ["Assets/Vanguard/Combat/WeaponDurability.cs"],
        ruleFiles: ["ProjectRules/AGENTS.md"],
        systems: ["combat", "inventory"],
        metadata: { dirty: true },
      }),
      token,
    );
    expect(scan.body.scan).toMatchObject({ systems: ["combat", "inventory"] });

    const context = await auth(
      request(app).post("/api/context").send({
        kind: "architecture",
        title: "Weapon durability boundary",
        content: "Firing depends on durability but inventory owns persistence.",
        paths: ["Assets/Vanguard/Combat"],
      }),
      token,
    );
    expect(context.status).toBe(201);

    const decision = await auth(
      request(app).post("/api/decisions").send({
        title: "Keep fire interface compatible",
        decision: "Add a durability gate without changing the fire method signature.",
        rationale: "Existing AI and player weapons share the interface.",
        paths: ["Assets/Vanguard/Combat"],
      }),
      token,
    );
    expect(decision.status).toBe(201);

    const verification = await auth(
      request(app).post("/api/verifications").send({
        kind: "automated_test",
        result: "passed",
        summary: "Durability unit tests passed.",
        command: "pnpm test",
      }),
      token,
    );
    expect(verification.status).toBe(201);

    const handoff = await auth(
      request(app).post("/api/handoffs").send({
        summary: "Runtime verification remains.",
        completed: ["Static tests"],
        remaining: ["Unity Play Mode"],
        risks: ["Animation timing"],
      }),
      token,
    );
    expect(handoff.status).toBe(201);

    const relevant = await auth(
      request(app).get("/api/context").query({ paths: "Assets/Vanguard/Combat/Weapon.cs" }),
      token,
    );
    expect(relevant.body.contextEntries).toHaveLength(1);
    expect(relevant.body.decisions).toHaveLength(1);
    expect(relevant.body.verifications).toHaveLength(1);
    expect(relevant.body.handoffs).toHaveLength(1);

    const closed = await auth(
      request(app).post(`/api/sessions/${session.body.session.id}/close`).send({
        summary: "Agent task ended.",
      }),
      token,
    );
    expect(closed.body.session.status).toBe("closed");
  });

  it("exposes feature revision history and requires explicit confirmation for exact historical impacts", async () => {
    const { app } = testApp();
    const owner = await createRoom(app);
    const token = owner.body.token;
    const session = await auth(
      request(app).post("/api/sessions").send({
        clientName: "Codex",
        branch: "develop",
        baseCommit: "aaaa1111",
        task: "Maintain inventory apply behavior",
      }),
      token,
    );
    const sessionId = session.body.session.id as string;
    const lease = await auth(
      request(app).post("/api/leases").send({
        sessionId,
        title: "Inventory apply",
        paths: ["Assets/Inventory/Feature.cs"],
        mode: "write",
      }),
      token,
    );
    expect(lease.body.acquired).toBe(true);

    const featureVerification = await auth(
      request(app).post("/api/verifications").send({
        sessionId,
        leaseId: lease.body.lease.id,
        kind: "automated_test",
        result: "passed",
        summary: "Inventory regression tests passed.",
      }),
      token,
    );
    expect(featureVerification.status).toBe(201);

    const submitted = await auth(
      request(app).post("/api/features/revisions").send({
        sessionId,
        featureKey: "inventory.apply",
        name: "Inventory apply",
        systemId: "inventory",
        objective: "Apply compatible items without changing unrelated slots.",
        changeSummary: "Established the verified inventory apply contract.",
        contractChanges: [{
          operation: "add",
          key: "inventory.apply.compatible",
          behavior: "Applying a compatible item preserves every unrelated slot.",
        }],
        targets: [{
          kind: "symbol",
          role: "contract",
          path: "Assets/Inventory/Feature.cs",
          symbol: "InventoryFeature.Apply",
        }],
        finalCommit: "bbbb2222",
        completed: true,
        verifications: [{
          testKey: "inventory-regression",
          result: "passed",
          summary: "Inventory regression tests passed.",
        }],
      }),
      token,
    );
    expect(submitted.status).toBe(201);
    expect(submitted.body.revision).toMatchObject({ revisionNumber: 1, status: "candidate" });
    const revision = submitted.body.revision as { id: string; featureId: string };

    const unrelatedEvidenceScan = await auth(
      request(app).post(`/api/sessions/${sessionId}/scan`).send({
        branch: "develop",
        baseCommit: "aaaa1111",
        changedPaths: ["Assets/Unrelated/Other.cs"],
        metadata: {
          source: "codex-hook",
          event: "SessionEnd",
          featureEvidence: {
            version: 1,
            branch: "develop",
            baseCommit: "aaaa1111",
            finalCommit: "bbbb2222",
            committed: true,
            committedPaths: ["Assets/Unrelated/Other.cs"],
            uncommittedPaths: [],
            changedPaths: ["Assets/Unrelated/Other.cs"],
            commitHashes: ["bbbb2222"],
            diffSha256: "0".repeat(64),
          },
        },
      }),
      token,
    );
    expect(unrelatedEvidenceScan.status).toBe(201);
    const stillCandidate = await auth(
      request(app).get(`/api/features/${revision.featureId}/history`),
      token,
    );
    expect(stillCandidate.body.revisions[0]).toMatchObject({ id: revision.id, status: "candidate" });

    const finalEvidenceScan = await auth(
      request(app).post(`/api/sessions/${sessionId}/scan`).send({
        branch: "develop",
        baseCommit: "aaaa1111",
        changedPaths: ["Assets/Inventory/Feature.cs"],
        metadata: {
          source: "codex-hook",
          event: "SessionEnd",
          featureEvidence: {
            version: 2,
            branch: "develop",
            baseCommit: "aaaa1111",
            finalCommit: "bbbb2222",
            committed: true,
            committedPathCount: 1,
            uncommittedPathCount: 0,
            changedPathCount: 1,
            changedPathsSha256: createHash("sha256")
              .update(JSON.stringify(["assets/inventory/feature.cs"]), "utf8")
              .digest("hex"),
            commitHashCount: 1,
            commitHashesSha256: createHash("sha256")
              .update(JSON.stringify(["bbbb2222"]), "utf8")
              .digest("hex"),
            finalCommitIncluded: true,
            diffSha256: "a".repeat(64),
          },
        },
      }),
      token,
    );
    expect(finalEvidenceScan.status).toBe(201);

    const promotedHistory = await auth(
      request(app).get(`/api/features/${revision.featureId}/history`),
      token,
    );
    expect(promotedHistory.body.revisions[0]).toMatchObject({ id: revision.id, status: "current" });

    const partiallyAttested = await auth(
      request(app).post("/api/features/revisions").send({
        sessionId,
        featureKey: "inventory.partial-evidence",
        name: "Inventory partial evidence",
        systemId: "inventory",
        objective: "Do not promote a feature whose declared paths exceed its final Hook evidence.",
        changeSummary: "Claims one attested and one unattested implementation path.",
        contractChanges: [{
          operation: "add",
          key: "inventory.partial-evidence.coverage",
          behavior: "Every declared implementation path must be covered by final evidence.",
        }],
        targets: [
          { kind: "path", path: "Assets/Inventory/Feature.cs" },
          { kind: "path", path: "Assets/Inventory/Unattested.cs" },
        ],
        finalCommit: "bbbb2222",
        completed: true,
        verifications: [{
          testKey: "inventory-regression",
          result: "passed",
          summary: "Inventory regression tests passed.",
        }],
      }),
      token,
    );
    expect(partiallyAttested.status).toBe(201);
    expect(partiallyAttested.body.revision).toMatchObject({ status: "candidate" });

    const queried = await auth(
      request(app).post("/api/features/query").send({
        sessionId,
        symbols: ["InventoryFeature.Apply"],
      }),
      token,
    );
    expect(queried.body.cards).toEqual([
      expect.objectContaining({ featureId: revision.featureId, revisionId: revision.id }),
    ]);

    const proposal = {
      sessionId,
      leaseId: lease.body.lease.id,
      paths: ["Assets/Inventory/Feature.cs"],
      proposedEdits: [{
        path: "Assets/Inventory/Feature.cs",
        precision: "symbol",
        symbols: ["InventoryFeature.Apply"],
        operation: "update",
      }],
    };
    const blocked = await auth(request(app).post("/api/edits/check").send(proposal), token);
    expect(blocked.body).toMatchObject({
      allowed: false,
      historicalImpacts: [expect.objectContaining({ confidence: "exact" })],
      featureConfirmation: expect.objectContaining({ status: "pending" }),
    });
    await auth(request(app).post("/api/room/settings").send({
      blockingProtectionEnabled: false,
    }), token);
    const advisory = await auth(request(app).post("/api/edits/check").send(proposal), token);
    expect(advisory.body).toMatchObject({
      allowed: true,
      blockers: [],
      historicalImpacts: [expect.objectContaining({ confidence: "exact" })],
      featureConfirmation: expect.objectContaining({ status: "pending" }),
      warnings: [expect.objectContaining({ code: "feature_confirmation_required" })],
    });
    await auth(request(app).post("/api/room/settings").send({
      blockingProtectionEnabled: true,
    }), token);

    const missingDecision = await auth(
      request(app)
        .post(`/api/feature-confirmations/${blocked.body.featureConfirmation.id}/resolve`)
        .send({ sessionId }),
      token,
    );
    expect(missingDecision.status).toBe(400);
    expect(missingDecision.body.error).toBe("invalid_feature_confirmation_decision");

    const approved = await auth(
      request(app)
        .post(`/api/feature-confirmations/${blocked.body.featureConfirmation.id}/resolve`)
        .send({
          sessionId,
          decision: "approved",
          reason: "This is an intentional behavior update with regression coverage.",
        }),
      token,
    );
    expect(approved.body.confirmation.status).toBe("approved");
    const allowed = await auth(request(app).post("/api/edits/check").send(proposal), token);
    expect(allowed.body).toMatchObject({
      allowed: true,
      featureConfirmation: expect.objectContaining({ status: "approved" }),
    });

    const rollbackVerification = await auth(
      request(app).post("/api/verifications").send({
        sessionId,
        leaseId: lease.body.lease.id,
        kind: "automated_test",
        result: "passed",
        summary: "Rollback regression tests passed.",
      }),
      token,
    );
    expect(rollbackVerification.status).toBe(201);
    const rollbackEvidenceScan = await auth(
      request(app).post(`/api/sessions/${sessionId}/scan`).send({
        branch: "develop",
        baseCommit: "aaaa1111",
        changedPaths: ["Assets/Inventory/Feature.cs"],
        metadata: {
          source: "codex-hook",
          event: "SessionEnd",
          featureEvidence: {
            version: 1,
            branch: "develop",
            baseCommit: "aaaa1111",
            finalCommit: "cccc3333",
            committed: true,
            committedPaths: ["Assets/Inventory/Feature.cs"],
            uncommittedPaths: [],
            changedPaths: ["Assets/Inventory/Feature.cs"],
            commitHashes: ["cccc3333"],
            diffSha256: "b".repeat(64),
          },
        },
      }),
      token,
    );
    expect(rollbackEvidenceScan.status).toBe(201);

    const rollback = await auth(
      request(app).post(`/api/features/${revision.featureId}/rollback`).send({
        sessionId,
        targetRevisionId: revision.id,
        changeSummary: "Restore the last verified behavior after an incompatible experiment.",
        finalCommit: "cccc3333",
        completed: true,
        verifications: [{
          testKey: "inventory-regression",
          result: "passed",
          summary: "Rollback regression tests passed.",
        }],
      }),
      token,
    );
    expect(rollback.status).toBe(201);
    expect(rollback.body.revision).toMatchObject({ revisionNumber: 2, status: "current" });

    const history = await auth(
      request(app).get(`/api/features/${revision.featureId}/history`),
      token,
    );
    expect(history.body.revisions).toHaveLength(2);
    expect(history.body.revisions.map((item: { revisionNumber: number }) => item.revisionNumber)).toEqual([2, 1]);
  });

  it("reopens the SQLite database without losing rooms, membership, or records", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-hub-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "hub.sqlite");
    const firstDatabase = new AgentHubDatabase({ path });
    databases.push(firstDatabase);
    const firstApp = createAgentHubApp({ database: firstDatabase });
    const owner = await createRoom(firstApp);
    await auth(
      request(firstApp).post("/api/records").send({
        kind: "risk",
        title: "Runtime gap",
        summary: "Unity Play Mode has not run.",
        paths: ["Assets/Vanguard/Combat"],
      }),
      owner.body.token,
    );
    firstDatabase.close();
    databases.splice(databases.indexOf(firstDatabase), 1);

    const secondDatabase = new AgentHubDatabase({ path });
    databases.push(secondDatabase);
    const secondApp = createAgentHubApp({ database: secondDatabase });
    const dashboard = await auth(request(secondApp).get("/api/dashboard"), owner.body.token);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.room.projectName).toBe("Project Vanguard");
    expect(dashboard.body.records).toMatchObject([
      { kind: "risk", title: "Runtime gap", status: "open" },
    ]);
  });
});

function testApp(now?: () => Date) {
  const database = new AgentHubDatabase({ path: ":memory:" });
  databases.push(database);
  const service = new AgentHubService(database, { now });
  return { app: createAgentHubApp({ database, service }), database };
}

function createRoom(app: ReturnType<typeof createAgentHubApp>) {
  return request(app).post("/api/rooms").send({
    roomName: "Vanguard team",
    projectName: "Project Vanguard",
    repository: "https://github.com/example/projectvanguard.git",
    defaultBranch: "develop",
    ownerName: "Alice",
    clientVersion: AGENT_HUB_VERSION,
    protocolVersion: AGENT_HUB_PROTOCOL_VERSION,
    schemaVersion: AGENT_HUB_SCHEMA_VERSION,
  });
}

function joinRoom(app: ReturnType<typeof createAgentHubApp>, inviteCode: string, memberName: string) {
  return request(app).post("/api/rooms/join").send({
    inviteCode,
    memberName,
    clientVersion: AGENT_HUB_VERSION,
    protocolVersion: AGENT_HUB_PROTOCOL_VERSION,
    schemaVersion: AGENT_HUB_SCHEMA_VERSION,
  });
}

function createLease(
  app: ReturnType<typeof createAgentHubApp>,
  token: string,
  input: {
    title: string;
    paths: string[];
    overrideReason?: string;
    ttlMinutes?: number;
  },
) {
  return auth(
    request(app)
      .post("/api/leases")
      .send({
        intent: input.title,
        branch: "feature/test",
        mode: "write",
        ttlMinutes: input.ttlMinutes ?? 30,
        ...input,
      }),
    token,
  );
}

function auth<T extends request.Test>(test: T, token: string): T {
  return test.set("Authorization", `Bearer ${token}`) as T;
}
