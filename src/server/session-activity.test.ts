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
    expect(session.reused).toBe(false);
    const reused = service.openSession({
      memberToken,
      codexSessionId: "codex-session-1",
      turnId: "turn-0",
      activityEpoch: 0,
      metadata: { source: "SessionStart-resume" },
    });
    expect(reused).toMatchObject({
      id: session.id,
      reused: true,
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
      awaitingAutomaticLeases: [{
        id: automatic.lease.id,
        expiresAt: automatic.lease.expiresAt,
      }],
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
      leaseIds: [automatic.lease.id],
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

  it.each([
    { label: "omitted", includeLeaseIds: false },
    { label: "explicitly empty", includeLeaseIds: true },
  ])("treats an $label completion lease list as releasing zero leases", ({ includeLeaseIds }) => {
    const { database, service, memberToken } = testService();
    const session = service.openSession({
      memberToken,
      codexSessionId: "codex-session-empty-completion-list",
      turnId: "turn-empty-completion-list",
      activityEpoch: 4,
    });
    const automatic = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Automatic lease must remain",
      paths: ["src/automatic-empty-list.ts"],
      kind: "automatic",
    });
    const standard = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Manual standard must remain unchanged",
      paths: ["src/standard-empty-list.ts"],
      kind: "standard",
    });
    const exclusive = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Manual exclusive must remain unchanged",
      paths: ["src/exclusive-empty-list.ts"],
      kind: "exclusive",
      ttlMinutes: 30,
    });
    if (!automatic.acquired || !standard.acquired || !exclusive.acquired) {
      throw new Error("Test leases were not acquired.");
    }
    const manualBefore = new Map(
      [standard.lease, exclusive.lease].map((lease) => [lease.id, {
        status: lease.status,
        expires_at: lease.expiresAt,
      }]),
    );

    service.stopSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "completion-empty-list",
      turnId: "turn-empty-completion-list",
      activityEpoch: 4,
    });
    expect(service.completeSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "completion-empty-list",
      turnId: "turn-empty-completion-list",
      activityEpoch: 4,
      outcome: "reverted",
      ...(includeLeaseIds ? { leaseIds: [] } : {}),
      attributedPaths: [],
    })).toMatchObject({ result: "released", releasedLeaseIds: [] });

    expect(database.connection.prepare(
      "SELECT status, automatic_phase, expires_at FROM leases WHERE id = ?",
    ).get(automatic.lease.id)).toEqual({
      status: "active",
      automatic_phase: "awaiting_commit",
      expires_at: automatic.lease.expiresAt,
    });
    for (const lease of [standard.lease, exclusive.lease]) {
      expect(database.connection.prepare(
        "SELECT status, expires_at FROM leases WHERE id = ?",
      ).get(lease.id)).toEqual(manualBefore.get(lease.id));
    }
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

  it("lets an awaiting automatic lease expire at its original TTL", () => {
    let currentTime = new Date("2026-08-27T12:00:00.000Z");
    const { database, service, memberToken } = testService(() => currentTime);
    const session = service.openSession({
      memberToken,
      codexSessionId: "codex-session-awaiting-expiry",
      turnId: "turn-awaiting-expiry",
      activityEpoch: 21,
    });
    const automatic = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Awaiting work expires naturally",
      paths: ["src/awaiting-expiry.ts"],
      kind: "automatic",
    });
    if (!automatic.acquired) throw new Error("Test lease was not acquired.");

    service.stopSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "stop-awaiting-expiry",
      turnId: "turn-awaiting-expiry",
      activityEpoch: 21,
    });
    expect(database.connection.prepare(
      "SELECT status, automatic_phase, expires_at FROM leases WHERE id = ?",
    ).get(automatic.lease.id)).toEqual({
      status: "active",
      automatic_phase: "awaiting_commit",
      expires_at: automatic.lease.expiresAt,
    });

    currentTime = new Date(new Date(automatic.lease.expiresAt).getTime() + 1);
    expect(service.getDashboard(memberToken).leases.map((lease) => lease.id))
      .not.toContain(automatic.lease.id);
    expect(database.connection.prepare(
      "SELECT status, automatic_phase, expires_at FROM leases WHERE id = ?",
    ).get(automatic.lease.id)).toEqual({
      status: "expired",
      automatic_phase: "awaiting_commit",
      expires_at: automatic.lease.expiresAt,
    });
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

  it("does not renew Agent leases from finalizing or closed monitor-only sessions", () => {
    let currentTime = new Date("2026-08-27T12:00:00.000Z");
    const { database, service, memberToken } = testService(() => currentTime);
    const session = service.openSession({
      memberToken,
      codexSessionId: "codex-monitor-finalization",
      turnId: "turn-monitor-finalization",
      activityEpoch: 4,
    });
    const automatic = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Monitor-only Agent scope",
      paths: ["src/monitor-agent.ts"],
      kind: "automatic",
    });
    const standard = service.claimLease({
      memberToken,
      title: "Sessionless manual heartbeat scope",
      paths: ["src/monitor-manual.ts"],
      kind: "standard",
    });
    if (!automatic.acquired || !standard.acquired) throw new Error("Test leases were not acquired.");

    service.heartbeatSession({
      memberToken,
      sessionId: session.id,
      clientVersion: "0.2.7",
      protocolVersion: 2,
      schemaVersion: 6,
      turnId: "turn-monitor-finalization",
      activityEpoch: 4,
    });
    service.updateRoomSettings({ memberToken, blockingProtectionEnabled: false });
    const agentExpiry = service.getDashboard(memberToken).leases
      .find((lease) => lease.id === automatic.lease.id)?.expiresAt;
    service.startSessionFinalization({
      memberToken,
      sessionId: session.id,
      finalizationId: "finalization-monitor-heartbeat",
    });

    currentTime = new Date("2026-08-27T12:01:00.000Z");
    const finalizingHeartbeat = service.heartbeatSession({
      memberToken,
      sessionId: session.id,
      turnId: "turn-monitor-finalization",
      activityEpoch: 4,
    });
    expect(finalizingHeartbeat.renewedLeases.map((lease) => lease.id)).toEqual([standard.lease.id]);
    expect(service.getDashboard(memberToken).leases
      .find((lease) => lease.id === automatic.lease.id)?.expiresAt).toBe(agentExpiry);

    service.completeSessionFinalization({
      memberToken,
      sessionId: session.id,
      finalizationId: "finalization-monitor-heartbeat",
    });
    currentTime = new Date("2026-08-27T12:02:00.000Z");
    const closedHeartbeat = service.heartbeatSession({
      memberToken,
      sessionId: session.id,
      turnId: "turn-monitor-finalization",
      activityEpoch: 4,
    });
    expect(closedHeartbeat.renewedLeases.map((lease) => lease.id)).toEqual([standard.lease.id]);
    expect(service.getDashboard(memberToken).leases
      .find((lease) => lease.id === automatic.lease.id)?.expiresAt).toBe(agentExpiry);
    database.close();
  });

  it("merges MCP and Hook paths into one Agent-managed lease with invocation history", () => {
    let currentTime = new Date("2026-08-27T12:00:00.000Z");
    const { database, service, memberToken } = testService(() => currentTime);
    const session = service.openSession({
      memberToken,
      codexSessionId: "codex-managed-scope",
      turnId: "turn-managed-0",
      activityEpoch: 0,
      branch: "main",
      baseCommit: "base-managed",
      metadata: { source: "codex-hook" },
    });
    const mcpClaim = service.claimLease({
      memberToken,
      sessionId: session.id,
      title: "Managed scope",
      paths: ["src/first.ts"],
      kind: "automatic",
      managedBy: "agent",
      createdVia: "mcp",
      invocationId: "mcp-call-1",
      toolName: "lease_acquire",
      stage: "pre",
      turnId: "turn-managed-0",
    });
    if (!mcpClaim.acquired) throw new Error("MCP lease was not acquired.");
    currentTime = new Date("2026-08-27T12:00:01.000Z");

    const prepared = service.prepareEdits({
      memberToken,
      sessionId: session.id,
      title: "Hook fallback title",
      branch: "main",
      baseCommit: "base-managed",
      paths: ["src/second.ts"],
      invocationId: "hook-call-2",
      toolName: "Bash",
      stage: "pre",
      turnId: "turn-managed-0",
      activityEpoch: 0,
    });
    expect(prepared.check.allowed).toBe(true);
    expect(prepared.claim).toMatchObject({
      acquired: true,
      lease: {
        id: mcpClaim.lease.id,
        managedBy: "agent",
        createdVia: "mcp",
        title: "Managed scope",
      },
      coverage: [expect.objectContaining({
        leaseId: mcpClaim.lease.id,
        action: "added",
        paths: ["src/second.ts"],
      })],
    });
    expect(prepared.managedLease?.id).toBe(mcpClaim.lease.id);
    expect(service.getDashboard(memberToken).leases).toEqual([
      expect.objectContaining({
        id: mcpClaim.lease.id,
        paths: expect.arrayContaining([
          expect.objectContaining({ path: "src/first.ts" }),
          expect.objectContaining({ path: "src/second.ts" }),
        ]),
      }),
    ]);
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS count FROM leases
      WHERE session_id = ? AND status = 'active' AND managed_by = 'agent'
    `).get(session.id)).toEqual({ count: 1 });
    const history = service.listLeaseScopeEvents(memberToken, mcpClaim.lease.id, 10);
    expect(history.items.map((event) => event.metadata.invocationId)).toEqual([
      "hook-call-2",
      "mcp-call-1",
    ]);
    database.close();
  });

  it("preserves full invocation audit and manual coverage when Agent claims wait or are denied", () => {
    const { database, service, memberToken, room } = testService();
    const sharedManual = service.claimLease({
      memberToken,
      title: "Owner manual coverage",
      paths: ["src/manual-covered.ts"],
      mode: "write",
      kind: "standard",
      managedBy: "manual",
      createdVia: "ui",
    });
    const holderSession = service.openSession({
      memberToken,
      codexSessionId: "codex-audit-holder",
      turnId: "turn-holder-0",
      activityEpoch: 0,
    });
    const waitingSession = service.openSession({
      memberToken,
      codexSessionId: "codex-audit-waiting",
      turnId: "turn-waiting-0",
      activityEpoch: 0,
    });
    const holder = service.claimLease({
      memberToken,
      sessionId: holderSession.id,
      title: "Held Agent scope",
      paths: ["src/held.ts"],
      mode: "write",
      kind: "automatic",
      managedBy: "agent",
      createdVia: "hook",
    });
    if (!sharedManual.acquired || !holder.acquired) throw new Error("Expected owner leases to be acquired.");

    const waiting = service.claimLease({
      memberToken,
      sessionId: waitingSession.id,
      title: "Waiting mixed scope",
      paths: ["src/manual-covered.ts", "src/held.ts"],
      mode: "write",
      kind: "automatic",
      managedBy: "agent",
      createdVia: "hook",
      invocationId: "wait-invocation",
      toolName: "Bash",
      stage: "pre",
      turnId: "turn-waiting-0",
      ignoredPaths: [".tmp/wait.log"],
      actualPaths: [],
      pathDiagnostics: ["Wait diagnostic"],
    });
    expect(waiting).toMatchObject({
      acquired: false,
      decision: "wait",
      coverage: [{
        leaseId: sharedManual.lease.id,
        managedBy: "manual",
        paths: ["src/manual-covered.ts"],
        action: "covered",
      }],
      waitingFor: { leaseId: holder.lease.id },
    });

    const bob = service.joinRoom({
      roomToken: room.roomToken,
      displayName: "Bob",
    });
    const exclusive = service.claimLease({
      memberToken,
      title: "Owner exclusive scope",
      paths: ["src/exclusive"],
      mode: "write",
      kind: "exclusive",
      managedBy: "manual",
      createdVia: "ui",
      ttlMinutes: 60,
    });
    const bobManual = service.claimLease({
      memberToken: bob.memberToken,
      title: "Bob manual coverage",
      paths: ["src/bob-covered.ts"],
      mode: "write",
      kind: "standard",
      managedBy: "manual",
      createdVia: "ui",
    });
    const bobSession = service.openSession({
      memberToken: bob.memberToken,
      codexSessionId: "codex-audit-denied",
      turnId: "turn-denied-0",
      activityEpoch: 0,
    });
    if (!exclusive.acquired || !bobManual.acquired) throw new Error("Expected manual leases to be acquired.");

    const denied = service.claimLease({
      memberToken: bob.memberToken,
      sessionId: bobSession.id,
      title: "Denied mixed scope",
      paths: ["src/bob-covered.ts", "src/exclusive/file.ts"],
      mode: "write",
      kind: "automatic",
      managedBy: "agent",
      createdVia: "hook",
      invocationId: "deny-invocation",
      toolName: "apply_patch",
      stage: "pre",
      turnId: "turn-denied-0",
      ignoredPaths: [".tmp/deny.log"],
      actualPaths: ["src/exclusive/file.ts"],
      pathDiagnostics: ["Deny diagnostic"],
    });
    expect(denied).toMatchObject({
      acquired: false,
      decision: "deny",
      coverage: [{
        leaseId: bobManual.lease.id,
        managedBy: "manual",
        paths: ["src/bob-covered.ts"],
        action: "covered",
      }],
    });

    const activities = (database.connection.prepare(`
      SELECT actor_member_id, type, entity_type, entity_id, metadata_json
      FROM activities
      WHERE type IN ('lease.waiting', 'lease.rejected', 'lease.scope_observed')
    `).all() as Array<{
      actor_member_id: string;
      type: string;
      entity_type: string;
      entity_id: string | null;
      metadata_json: string;
    }>).map((activity) => ({
      ...activity,
      metadata: JSON.parse(activity.metadata_json) as Record<string, unknown>,
    }));
    const waitMetadata = {
      invocationId: "wait-invocation",
      source: "hook",
      toolName: "Bash",
      stage: "pre",
      turnId: "turn-waiting-0",
      requestedPaths: ["src/manual-covered.ts", "src/held.ts"],
      coveredPaths: ["src/manual-covered.ts"],
      addedPaths: [],
      ignoredPaths: [".tmp/wait.log"],
      actualPaths: [],
      pathDiagnostics: ["Wait diagnostic"],
    };
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "lease.waiting",
        entity_type: "lease",
        entity_id: holder.lease.id,
        metadata: expect.objectContaining(waitMetadata),
      }),
      expect.objectContaining({
        type: "lease.scope_observed",
        entity_type: "session",
        entity_id: waitingSession.id,
        metadata: expect.objectContaining(waitMetadata),
      }),
      expect.objectContaining({
        actor_member_id: bob.member.id,
        type: "lease.rejected",
        entity_type: "lease",
        entity_id: null,
        metadata: expect.objectContaining({
          invocationId: "deny-invocation",
          source: "hook",
          toolName: "apply_patch",
          stage: "pre",
          turnId: "turn-denied-0",
          requestedPaths: ["src/bob-covered.ts", "src/exclusive/file.ts"],
          coveredPaths: ["src/bob-covered.ts"],
          addedPaths: [],
          ignoredPaths: [".tmp/deny.log"],
          actualPaths: ["src/exclusive/file.ts"],
          pathDiagnostics: ["Deny diagnostic"],
        }),
      }),
      expect.objectContaining({
        actor_member_id: bob.member.id,
        type: "lease.scope_observed",
        entity_type: "session",
        entity_id: bobSession.id,
        metadata: expect.objectContaining({ invocationId: "deny-invocation" }),
      }),
    ]));
    database.close();
  });

  it("attributes manually covered paths without converting or releasing the manual lease", () => {
    const { database, service, memberToken } = testService();
    const session = service.openSession({
      memberToken,
      codexSessionId: "codex-manual-coverage",
      turnId: "turn-manual-0",
      activityEpoch: 0,
      branch: "main",
      baseCommit: "base-manual",
    });
    const manual = service.claimLease({
      memberToken,
      title: "Manual source scope",
      paths: ["src/manual"],
      kind: "standard",
      managedBy: "manual",
      createdVia: "ui",
    });
    if (!manual.acquired) throw new Error("Manual lease was not acquired.");

    const prepared = service.prepareEdits({
      memberToken,
      sessionId: session.id,
      title: "Covered Agent write",
      branch: "main",
      baseCommit: "base-manual",
      paths: ["src/manual/file.ts"],
      invocationId: "manual-covered-call",
      toolName: "apply_patch",
      stage: "pre",
      turnId: "turn-manual-0",
      activityEpoch: 0,
    });
    expect(prepared).toMatchObject({
      check: { allowed: true },
      claim: {
        acquired: true,
        lease: { id: manual.lease.id, managedBy: "manual", createdVia: "ui" },
        coverage: [{
          leaseId: manual.lease.id,
          managedBy: "manual",
          paths: ["src/manual/file.ts"],
          action: "covered",
        }],
      },
    });
    expect(prepared.managedLease).toBeUndefined();
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS count FROM leases
      WHERE session_id = ? AND status = 'active' AND managed_by = 'agent'
    `).get(session.id)).toEqual({ count: 0 });

    const stopped = service.stopSessionActivity({
      memberToken,
      sessionId: session.id,
      operationId: "stop-manual-coverage",
      turnId: "turn-manual-0",
      activityEpoch: 0,
    });
    expect(stopped.managedLeases).toEqual([]);
    expect(service.getDashboard(memberToken).leases).toEqual([
      expect.objectContaining({ id: manual.lease.id, managedBy: "manual", status: "active" }),
    ]);
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
  return { database, service, memberToken: room.memberToken, room };
}
