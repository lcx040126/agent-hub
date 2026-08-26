import { afterEach, describe, expect, it } from "vitest";
import { AgentHubDatabase } from "./db.js";
import { createMcpServiceAdapter } from "./mcp-adapter.js";
import type { AgentHubToolContext } from "./mcp.js";
import { AgentHubService } from "./service.js";

const databases: AgentHubDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Agent Hub MCP session lifecycle", () => {
  it("closes the exact session_open session selected by sessionId", async () => {
    const { service, adapter, context } = setup();
    const first = await adapter.sessionOpen(context, { objective: "First task" }) as OpenResult;
    const second = await adapter.sessionOpen(context, { objective: "Second task" }) as OpenResult;
    const lease = await adapter.leaseAcquire(context, {
      sessionId: first.session.id,
      title: "First task scope",
      paths: ["src/first-task.ts"],
    });
    expect(lease.acquired).toBe(true);
    if (!lease.acquired) throw new Error("Expected the first task lease to be acquired.");

    const closed = await adapter.sessionClose(context, {
      sessionId: first.session.id,
      leaseId: lease.lease.id,
      status: "completed",
      summary: "First task finished.",
    }) as CloseResult;

    expect(closed.session).toMatchObject({ id: first.session.id, status: "closed" });
    expect(closed.lease).toMatchObject({
      id: lease.lease.id,
      sessionId: first.session.id,
      status: "completed",
    });
    expect(service.listRoomSessions(context.memberToken).sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.session.id, status: "closed" }),
        expect.objectContaining({ id: second.session.id, status: "active" }),
      ]),
    );
  });

  it("closes only the selected MCP session and leaves the Hook session active", async () => {
    const { service, adapter, context } = setup();
    const hookSession = service.openSession({
      memberToken: context.memberToken,
      clientName: "Agent Hub Codex hook",
      metadata: { source: "codex-hook" },
    });
    const opened = await adapter.sessionOpen(context, { objective: "Legacy MCP task" }) as OpenResult;

    const closed = await adapter.sessionClose(context, {
      sessionId: opened.session.id,
      status: "cancelled",
      summary: "MCP task stopped.",
    }) as CloseResult;

    const sessions = service.listRoomSessions(context.memberToken).sessions;
    expect(closed.session).toMatchObject({ id: opened.session.id, status: "closed" });
    expect(sessions.find((session) => session.id === hookSession.id)?.status).toBe("active");
  });

  it("rejects a Hook session ID instead of closing it through the MCP tool", async () => {
    const { service, adapter, context } = setup();
    const hookSession = service.openSession({
      memberToken: context.memberToken,
      clientName: "Agent Hub Codex hook",
      metadata: { source: "codex-hook" },
    });

    expect(() => adapter.sessionClose(context, {
      sessionId: hookSession.id,
      status: "cancelled",
    })).toThrow(expect.objectContaining({ code: "mcp_session_not_active", status: 409 }));
    expect(
      service.listRoomSessions(context.memberToken).sessions.find((session) => session.id === hookSession.id)?.status,
    ).toBe("active");
  });

  it("does not let one MCP session reuse or close another session's lease", async () => {
    const { service, adapter, context } = setup();
    const first = await adapter.sessionOpen(context, { objective: "First task" }) as OpenResult;
    const second = await adapter.sessionOpen(context, { objective: "Second task" }) as OpenResult;
    const secondLease = await adapter.leaseAcquire(context, {
      sessionId: second.session.id,
      title: "Second scene",
      paths: ["Assets/Scenes/Second.unity"],
    });
    expect(secondLease.acquired).toBe(true);
    if (!secondLease.acquired) throw new Error("Expected the second task lease to be acquired.");

    expect(() => adapter.sessionClose(context, {
      sessionId: first.session.id,
      leaseId: secondLease.lease.id,
      status: "cancelled",
    })).toThrow(expect.objectContaining({ code: "lease_session_mismatch", status: 409 }));
    expect(() => adapter.leaseRenew(context, {
      sessionId: first.session.id,
      leaseId: secondLease.lease.id,
    })).toThrow(expect.objectContaining({ code: "lease_session_mismatch", status: 409 }));
    expect(() => adapter.editCheck(context, {
      sessionId: first.session.id,
      leaseId: secondLease.lease.id,
      paths: ["Assets/Scenes/Second.unity"],
    })).toThrow(expect.objectContaining({ code: "lease_not_found", status: 404 }));

    const overlapping = await adapter.leaseAcquire(context, {
      sessionId: first.session.id,
      title: "First task tries the second scene",
      paths: ["Assets/Scenes/Second.unity"],
    });
    expect(overlapping).toMatchObject({ acquired: false, decision: "deny" });
    expect(service.getDashboard(context.memberToken).leases.find(
      (lease) => lease.id === secondLease.lease.id,
    )).toMatchObject({ status: "active", sessionId: second.session.id });
    expect(service.listRoomSessions(context.memberToken).sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.session.id, status: "active" }),
        expect.objectContaining({ id: second.session.id, status: "active" }),
      ]),
    );
  });

  it("does not let an MCP session close a Hook-owned lease", async () => {
    const { service, adapter, context } = setup();
    const mcpSession = await adapter.sessionOpen(context, { objective: "MCP task" }) as OpenResult;
    const hookSession = service.openSession({
      memberToken: context.memberToken,
      clientName: "Agent Hub Codex hook",
      metadata: { source: "codex-hook" },
    });
    const hookLease = service.claimLease({
      memberToken: context.memberToken,
      sessionId: hookSession.id,
      title: "Hook scope",
      paths: ["Assets/Prefabs/Protected.prefab"],
      mode: "write",
    });
    expect(hookLease.acquired).toBe(true);
    if (!hookLease.acquired) throw new Error("Expected the Hook lease to be acquired.");

    expect(() => adapter.sessionClose(context, {
      sessionId: mcpSession.session.id,
      leaseId: hookLease.lease.id,
      status: "cancelled",
    })).toThrow(expect.objectContaining({ code: "lease_session_mismatch", status: 409 }));
    expect(service.getDashboard(context.memberToken).leases.find(
      (lease) => lease.id === hookLease.lease.id,
    )).toMatchObject({ status: "active", sessionId: hookSession.id });
  });

  it("keeps legacy member leases isolated from a new MCP session", async () => {
    const { service, adapter, context } = setup();
    const legacyLease = service.claimLease({
      memberToken: context.memberToken,
      title: "Legacy unbound scene lease",
      paths: ["Assets/Scenes/Legacy.unity"],
      mode: "write",
    });
    expect(legacyLease.acquired).toBe(true);
    if (!legacyLease.acquired) throw new Error("Expected the legacy lease to be acquired.");
    expect(legacyLease.lease.sessionId).toBeNull();

    const opened = await adapter.sessionOpen(context, { objective: "New MCP task" }) as OpenResult;
    expect(() => adapter.editCheck(context, {
      sessionId: opened.session.id,
      leaseId: legacyLease.lease.id,
      paths: ["Assets/Scenes/Legacy.unity"],
    })).toThrow(expect.objectContaining({ code: "lease_not_found", status: 404 }));

    const overlapping = await adapter.leaseAcquire(context, {
      sessionId: opened.session.id,
      title: "New session tries legacy scene",
      paths: ["Assets/Scenes/Legacy.unity"],
    });
    expect(overlapping).toMatchObject({ acquired: false, decision: "deny" });
  });

  it("does not let one MCP session append evidence to another session's lease", async () => {
    const { adapter, context } = setup();
    const first = await adapter.sessionOpen(context, { objective: "First task" }) as OpenResult;
    const second = await adapter.sessionOpen(context, { objective: "Second task" }) as OpenResult;
    const secondLease = await adapter.leaseAcquire(context, {
      sessionId: second.session.id,
      title: "Second task scope",
      paths: ["src/second.ts"],
    });
    expect(secondLease.acquired).toBe(true);
    if (!secondLease.acquired) throw new Error("Expected the second lease to be acquired.");

    expect(() => adapter.eventAppend(context, {
      sessionId: first.session.id,
      eventType: "verification",
      leaseId: secondLease.lease.id,
      kind: "automated_test",
      result: "passed",
      summary: "This result belongs to the wrong session.",
    })).toThrow(expect.objectContaining({ code: "lease_session_mismatch", status: 409 }));
  });

  it("cancels every remaining lease owned by a closing session only", async () => {
    const { service, adapter, context } = setup();
    const first = await adapter.sessionOpen(context, { objective: "First task" }) as OpenResult;
    const second = await adapter.sessionOpen(context, { objective: "Second task" }) as OpenResult;
    const firstLeaseA = await adapter.leaseAcquire(context, {
      sessionId: first.session.id,
      title: "First task A",
      paths: ["src/first-a.ts"],
    });
    const firstLeaseB = await adapter.leaseAcquire(context, {
      sessionId: first.session.id,
      title: "First task B",
      paths: ["src/first-b.ts"],
    });
    const secondLease = await adapter.leaseAcquire(context, {
      sessionId: second.session.id,
      title: "Second task",
      paths: ["src/second.ts"],
    });
    expect(firstLeaseA.acquired && firstLeaseB.acquired && secondLease.acquired).toBe(true);
    if (!firstLeaseA.acquired || !firstLeaseB.acquired || !secondLease.acquired) {
      throw new Error("Expected every independent lease to be acquired.");
    }

    await adapter.sessionClose(context, {
      sessionId: first.session.id,
      status: "cancelled",
    });

    const rows = service.database.connection
      .prepare("SELECT id, status FROM leases ORDER BY id")
      .all() as Array<{ id: string; status: string }>;
    const statusById = new Map(rows.map((row) => [row.id, row.status]));
    expect(statusById.get(firstLeaseA.lease.id)).toBe("cancelled");
    expect(statusById.get(firstLeaseB.lease.id)).toBe("cancelled");
    expect(statusById.get(secondLease.lease.id)).toBe("active");
  });
});

interface OpenResult {
  session: { id: string; status: string };
}

interface CloseResult {
  session: { id: string; status: string };
  lease?: { id: string; status: string };
}

function setup() {
  const database = new AgentHubDatabase({ path: ":memory:" });
  databases.push(database);
  const service = new AgentHubService(database);
  const room = service.createRoom({
    name: "MCP lifecycle",
    projectName: "Agent Hub",
    repository: "https://github.com/example/agent-hub.git",
    hostName: "Alice",
    hostAgent: "Codex",
  });
  const context: AgentHubToolContext = {
    memberToken: room.memberToken,
    member: {
      id: room.member.id,
      roomId: room.member.roomId,
      displayName: room.member.displayName,
      role: room.member.role,
      agent: room.member.agent,
    },
  };
  return { service, adapter: createMcpServiceAdapter(service), context };
}
