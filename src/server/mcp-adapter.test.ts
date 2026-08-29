import { afterEach, describe, expect, it } from "vitest";
import { estimateContextTokens } from "./context-budget.js";
import { AgentHubDatabase } from "./db.js";
import { FeatureMemoryStore } from "./feature-memory.js";
import { createMcpServiceAdapter } from "./mcp-adapter.js";
import type { AgentHubToolContext } from "./mcp.js";
import type { FeatureRevision, SubmitFeatureRevisionInput, WorkSession } from "./domain.js";
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

  it("keeps the SessionStart Hook session and its lease under Hook lifecycle ownership", async () => {
    const { service, adapter, context } = setup();
    const hookSession = service.openSession({
      memberToken: context.memberToken,
      clientName: "Agent Hub Codex hook",
      metadata: { source: "codex-hook" },
    });
    const hookLease = service.claimLease({
      memberToken: context.memberToken,
      sessionId: hookSession.id,
      title: "Hook-owned scope",
      paths: ["src/hook-owned.ts"],
      mode: "write",
    });
    expect(hookLease.acquired).toBe(true);

    const countBefore = service.listRoomSessions(context.memberToken).sessions.length;
    expect(() => adapter.sessionClose(context, {
      sessionId: hookSession.id,
      status: "cancelled",
    })).toThrow(expect.objectContaining({
      code: "hook_session_lifecycle_owned",
      status: 409,
    }));
    expect(
      service.listRoomSessions(context.memberToken).sessions.find((session) => session.id === hookSession.id)?.status,
    ).toBe("active");
    expect(service.getDashboard(context.memberToken).leases.find(
      (lease) => lease.id === (hookLease.acquired ? hookLease.lease.id : ""),
    )).toMatchObject({ status: "active", sessionId: hookSession.id });
    expect(service.listRoomSessions(context.memberToken).sessions).toHaveLength(countBefore);
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
    expect(overlapping).toMatchObject({
      acquired: false,
      decision: "wait",
      waitingFor: {
        leaseId: secondLease.lease.id,
        sessionId: second.session.id,
      },
    });
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

  it("uses a same-member manual standard range as MCP coverage without creating an Agent lease", async () => {
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
    expect(adapter.editCheck(context, {
      sessionId: opened.session.id,
      leaseId: legacyLease.lease.id,
      paths: ["Assets/Scenes/Legacy.unity"],
    })).toMatchObject({
      allowed: true,
      coveredPaths: ["Assets/Scenes/Legacy.unity"],
      uncoveredPaths: [],
    });

    const overlapping = await adapter.leaseAcquire(context, {
      sessionId: opened.session.id,
      title: "New session tries legacy scene",
      paths: ["Assets/Scenes/Legacy.unity"],
    });
    expect(overlapping).toMatchObject({
      acquired: true,
      decision: "allow",
      lease: {
        id: legacyLease.lease.id,
        sessionId: null,
        kind: "standard",
        managedBy: "manual",
      },
      coverage: [{
        leaseId: legacyLease.lease.id,
        managedBy: "manual",
        paths: ["Assets/Scenes/Legacy.unity"],
        action: "covered",
      }],
    });
    expect(service.getDashboard(context.memberToken).leases.filter(
      (lease) => lease.sessionId === opened.session.id && lease.managedBy === "agent",
    )).toHaveLength(0);
  });

  it("does not treat a same-member manual read range as MCP write coverage", async () => {
    const { service, adapter, context } = setup();
    const manualRead = service.claimLease({
      memberToken: context.memberToken,
      title: "Read-only source review",
      paths: ["src/reviewed.ts"],
      mode: "read",
      kind: "standard",
      managedBy: "manual",
      createdVia: "ui",
    });
    expect(manualRead.acquired).toBe(true);
    if (!manualRead.acquired) throw new Error("Expected the manual read lease to be acquired.");

    const opened = await adapter.sessionOpen(context, { objective: "Write the reviewed source" }) as OpenResult;
    const acquired = await adapter.leaseAcquire(context, {
      sessionId: opened.session.id,
      title: "Write reviewed source",
      paths: ["src/reviewed.ts"],
    });

    expect(acquired).toMatchObject({
      acquired: true,
      lease: {
        sessionId: opened.session.id,
        mode: "write",
        kind: "automatic",
        managedBy: "agent",
        createdVia: "mcp",
      },
      coverage: [{
        managedBy: "agent",
        paths: ["src/reviewed.ts"],
        action: "added",
      }],
    });
    if (!acquired.acquired) throw new Error("Expected the MCP write lease to be acquired.");
    expect(acquired.lease.id).not.toBe(manualRead.lease.id);
    expect(service.getDashboard(context.memberToken).leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: manualRead.lease.id, mode: "read", managedBy: "manual" }),
      expect.objectContaining({ id: acquired.lease.id, mode: "write", managedBy: "agent" }),
    ]));
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

  it("cancels the canonical MCP Agent lease while preserving manual and other-session work", async () => {
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
    const firstAutomatic = service.claimLease({
      memberToken: context.memberToken,
      sessionId: first.session.id,
      title: "First automatic task",
      paths: ["src/first-automatic.ts"],
      kind: "automatic",
    });
    const firstManual = service.claimLease({
      memberToken: context.memberToken,
      sessionId: first.session.id,
      title: "First manual task",
      paths: ["src/first-manual.ts"],
      kind: "standard",
    });
    expect(
      firstLeaseA.acquired
        && firstLeaseB.acquired
        && secondLease.acquired
        && firstAutomatic.acquired
        && firstManual.acquired,
    ).toBe(true);
    if (
      !firstLeaseA.acquired
      || !firstLeaseB.acquired
      || !secondLease.acquired
      || !firstAutomatic.acquired
      || !firstManual.acquired
    ) {
      throw new Error("Expected every independent lease to be acquired.");
    }
    expect(firstLeaseB.lease.id).toBe(firstLeaseA.lease.id);
    expect(firstAutomatic.lease.id).toBe(firstLeaseA.lease.id);
    expect(firstAutomatic.lease.paths.map((path) => path.path)).toEqual(expect.arrayContaining([
      "src/first-a.ts",
      "src/first-b.ts",
      "src/first-automatic.ts",
    ]));

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
    expect(statusById.get(firstAutomatic.lease.id)).toBe("cancelled");
    expect(statusById.get(firstManual.lease.id)).toBe("active");
    expect(statusById.get(secondLease.lease.id)).toBe("active");
  });

  it("submits, queries, and protects an established feature through one owned MCP session", async () => {
    const { service, adapter, context } = setup();
    const opened = await adapter.sessionOpen(context, {
      objective: "Maintain inventory behavior",
      branch: "main",
      baseCommit: "aaaa1111",
    }) as OpenResult;
    const lease = await adapter.leaseAcquire(context, {
      sessionId: opened.session.id,
      title: "Inventory apply",
      paths: ["Assets/Inventory/Feature.cs"],
    });
    expect(lease.acquired).toBe(true);
    if (!lease.acquired) throw new Error("Expected the feature lease to be acquired.");
    service.addVerification({
      memberToken: context.memberToken,
      sessionId: opened.session.id,
      leaseId: lease.lease.id,
      kind: "automated_test",
      result: "passed",
      summary: "Inventory regression tests passed.",
    });

    const revision = await adapter.featureRevisionSubmit(context, {
      sessionId: opened.session.id,
      featureKey: "inventory.apply",
      name: "Inventory apply",
      systemId: "inventory",
      relation: "add",
      objective: "Apply compatible items without changing unrelated slots.",
      changeSummary: "Established the inventory apply contract.",
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
    });
    expect(revision).toMatchObject({ revisionNumber: 1, status: "candidate" });
    service.recordLocalScan({
      memberToken: context.memberToken,
      sessionId: opened.session.id,
      branch: "main",
      baseCommit: "aaaa1111",
      changedPaths: ["Assets/Inventory/Feature.cs"],
      metadata: finalFeatureEvidence({
        branch: "main",
        baseCommit: "aaaa1111",
        finalCommit: "bbbb2222",
        changedPaths: ["Assets/Inventory/Feature.cs"],
        diffSha256: "a".repeat(64),
      }),
    });

    const queried = await adapter.featureContextQuery(context, {
      sessionId: opened.session.id,
      level: "cards",
      symbols: ["InventoryFeature.Apply"],
      limit: 8,
    });
    expect(queried.cards).toEqual([
      expect.objectContaining({
        featureId: revision.featureId,
        revisionId: revision.id,
        status: "current",
      }),
    ]);
    const history = await adapter.featureHistory(context, {
      sessionId: opened.session.id,
      featureId: revision.featureId,
    });
    expect(history.revisions).toEqual([
      expect.objectContaining({ id: revision.id, status: "current" }),
    ]);

    const proposal = {
      sessionId: opened.session.id,
      leaseId: lease.lease.id,
      paths: ["Assets/Inventory/Feature.cs"],
      proposedEdits: [{
        path: "Assets/Inventory/Feature.cs",
        precision: "symbol" as const,
        symbols: ["InventoryFeature.Apply"],
        operation: "update" as const,
      }],
    };
    const blocked = await adapter.editCheck(context, proposal);
    expect(blocked).toMatchObject({
      allowed: false,
      historicalImpacts: [expect.objectContaining({ confidence: "exact" })],
      featureConfirmation: expect.objectContaining({ status: "pending" }),
    });
    if (!blocked.featureConfirmation) throw new Error("Expected an exact feature confirmation.");

    await adapter.featureChangeConfirm(context, {
      sessionId: opened.session.id,
      confirmationId: blocked.featureConfirmation.id,
      decision: "approved",
      reason: "The behavior update is intentional and will retain regression coverage.",
    });
    expect(await adapter.editCheck(context, proposal)).toMatchObject({
      allowed: true,
      featureConfirmation: expect.objectContaining({ status: "approved" }),
    });
  });

  it("allows feature-memory retrieval through an active owned Codex Hook session", async () => {
    const { service, adapter, context } = setup();
    const hookSession = service.openSession({
      memberToken: context.memberToken,
      clientName: "Agent Hub Codex hook",
      metadata: { source: "codex-hook" },
    });

    expect(await adapter.featureContextQuery(context, {
      sessionId: hookSession.id,
      level: "cards",
      paths: ["src/protected.ts"],
      limit: 8,
    })).toMatchObject({ cards: [], details: [] });
    expect(service.listRoomSessions(context.memberToken).sessions).toHaveLength(1);
  });

  it("packs 100 real shared-context entries into complete pages below 3000 tokens", async () => {
    const { service, adapter, context } = setup();
    for (let index = 0; index < 100; index += 1) {
      service.addContextEntry({
        memberToken: context.memberToken,
        kind: index < 3 ? "rule" : index < 5 ? "risk" : "note",
        title: `Context needle ${index}`,
        content: `Complete context entry ${index}: ${"preserve behavior ".repeat(18)}`,
        paths: ["src/shared"],
      });
    }

    const opened = await adapter.sessionOpen(context, {}) as OpenResult & { context: SharedContextResult };
    expect(opened.context.contextEntries.length).toBeGreaterThan(0);
    expect(opened.context.contextEntries.length).toBeLessThanOrEqual(5);
    expect(opened.context.contextEntries.every((entry) => entry.kind === "rule" || entry.kind === "risk")).toBe(true);
    expect(opened.context.retrieval.estimatedTokens).toBeLessThanOrEqual(3_000);

    const first = await adapter.contextQuery(context, {
      paths: ["src/shared"],
      query: "needle",
      limit: 200,
      budgetTokens: 3_000,
    }) as SharedContextResult;
    expect(first.retrieval.matchedCount).toBe(100);
    expect(first.contextEntries.length).toBeGreaterThan(0);
    expect(first.contextEntries.length).toBeLessThan(100);
    expect(first.retrieval.nextCursor).toEqual(expect.any(String));
    expect(first.retrieval.estimatedTokens).toBeLessThanOrEqual(3_000);
    expect(estimateContextTokens(JSON.stringify(first))).toBeLessThanOrEqual(3_000);

    const second = await adapter.contextQuery(context, {
      paths: ["src/shared"],
      query: "needle",
      limit: 200,
      budgetTokens: 3_000,
      cursor: first.retrieval.nextCursor!,
    }) as SharedContextResult;
    expect(second.contextEntries.length).toBeGreaterThan(0);
    expect(new Set(first.contextEntries.map((entry) => entry.id))).not.toEqual(
      new Set(second.contextEntries.map((entry) => entry.id)),
    );
    expect(estimateContextTokens(JSON.stringify(second))).toBeLessThanOrEqual(3_000);
  });

  it("retrieves 100 feature memories in bounded non-repeating pages for existing and late members", async () => {
    const { service, adapter, context, room } = setup();
    const opened = await adapter.sessionOpen(context, {
      objective: "Plan inventory features",
      branch: "main",
      baseCommit: "aaaa0000",
    }) as OpenResult;
    for (let index = 0; index < 100; index += 1) {
      submitTrustedFeatureRevision(service, context, opened.session, {
        sessionId: opened.session.id,
        featureKey: `inventory.feature-${index}`,
        name: `Inventory feature ${index}`,
        systemId: "inventory",
        relation: "add",
        objective: `Preserve inventory behavior ${index}.`,
        changeSummary: `Established inventory behavior ${index}.`,
        contractChanges: [{
          operation: "add",
          key: `inventory.contract-${index}`,
          behavior: `Inventory behavior ${index} remains compatible with existing slots.`,
        }],
        targets: [{
          kind: "symbol",
          path: `src/inventory/feature-${index}.ts`,
          symbol: `InventoryFeature${index}.run`,
        }],
        finalCommit: `commit-${index}`,
        completed: true,
        verifications: [{
          testKey: `inventory-test-${index}`,
          result: "passed",
          summary: `Inventory test ${index} passed.`,
        }],
      });
    }

    const first = await adapter.featureContextQuery(context, {
      sessionId: opened.session.id,
      level: "cards",
      systems: ["inventory"],
      limit: 8,
      budgetTokens: 3_000,
    }) as FeatureContextResult;
    expect(first.retrieval.matchedCount).toBe(100);
    expect(first.cards).toHaveLength(8);
    expect(first.retrieval.estimatedTokens).toBeLessThanOrEqual(3_000);
    expect(estimateContextTokens(JSON.stringify(first))).toBeLessThanOrEqual(3_000);

    const second = await adapter.featureContextQuery(context, {
      sessionId: opened.session.id,
      level: "cards",
      systems: ["inventory"],
      limit: 8,
      budgetTokens: 3_000,
    }) as FeatureContextResult;
    expect(second.cards).toHaveLength(8);
    expect(second.cards.map((card) => card.featureId)).not.toEqual(first.cards.map((card) => card.featureId));

    const joined = service.joinRoom({
      roomToken: room.roomToken,
      displayName: "Late member",
      agent: "Codex",
    });
    const lateContext: AgentHubToolContext = {
      memberToken: joined.memberToken,
      member: {
        id: joined.member.id,
        roomId: joined.member.roomId,
        displayName: joined.member.displayName,
        role: joined.member.role,
        agent: joined.member.agent,
      },
    };
    const lateSession = await adapter.sessionOpen(lateContext, { objective: "Continue inventory work" }) as OpenResult;
    const lateResult = await adapter.featureContextQuery(lateContext, {
      sessionId: lateSession.session.id,
      level: "cards",
      systems: ["inventory"],
      limit: 8,
      budgetTokens: 3_000,
    }) as FeatureContextResult;
    expect(lateResult.cards).toHaveLength(8);
    expect(lateResult.retrieval.matchedCount).toBe(100);
    expect(estimateContextTokens(JSON.stringify(lateResult))).toBeLessThanOrEqual(3_000);
  });

  it("returns only changed feature sections when a loaded feature gains a new version", async () => {
    const { service, adapter, context } = setup();
    const opened = await adapter.sessionOpen(context, {
      objective: "Maintain inventory drag",
      branch: "main",
      baseCommit: "aaaa1111",
    }) as OpenResult;
    const original = submitTrustedFeatureRevision(service, context, opened.session, {
      sessionId: opened.session.id,
      featureKey: "inventory.drag",
      name: "Inventory drag",
      systemId: "inventory",
      relation: "add",
      objective: "Drag items without changing unrelated slots.",
      changeSummary: "Established drag behavior.",
      contractChanges: [{
        operation: "add",
        key: "inventory.drag.preserve",
        behavior: "Dragging preserves unrelated slots.",
      }],
      constraints: ["Only compatible slots accept a drop."],
      dependencies: ["inventory-slots"],
      targets: [{
        kind: "symbol",
        path: "src/inventory/drag.ts",
        symbol: "InventoryDrag.apply",
      }],
      finalCommit: "bbbb1111",
      completed: true,
      verifications: [{ testKey: "drag-test", result: "passed", summary: "Drag passed." }],
    }) as { id: string; featureId: string };
    const first = await adapter.featureContextQuery(context, {
      sessionId: opened.session.id,
      level: "detail",
      featureIds: [original.featureId],
      budgetTokens: 3_000,
    }) as FeatureContextResult;
    expect(first.details).toHaveLength(1);
    expect(first.details[0]?.sections).toHaveProperty("dependencies");

    const replacement = submitTrustedFeatureRevision(service, context, opened.session, {
      sessionId: opened.session.id,
      featureKey: "inventory.drag",
      name: "Inventory drag",
      systemId: "inventory",
      parentRevisionId: original.id,
      relation: "replace",
      objective: "Drag items without changing unrelated slots.",
      changeSummary: "Tightened the drag preservation contract.",
      contractChanges: [{
        operation: "update",
        key: "inventory.drag.preserve",
        behavior: "Dragging preserves unrelated slots and their item order.",
      }],
      targets: [{
        kind: "symbol",
        path: "src/inventory/drag.ts",
        symbol: "InventoryDrag.apply",
      }],
      finalCommit: "cccc1111",
      completed: true,
      verifications: [{ testKey: "drag-test", result: "passed", summary: "Drag passed." }],
    }) as { id: string };
    const changed = await adapter.featureContextQuery(context, {
      sessionId: opened.session.id,
      level: "detail",
      featureIds: [original.featureId],
      budgetTokens: 3_000,
    }) as FeatureContextResult;
    expect(changed.details).toHaveLength(1);
    expect(changed.details[0]).toMatchObject({
      id: replacement.id,
      versionChangedFrom: original.id,
    });
    expect(changed.details[0]?.sections).toHaveProperty("behavior");
    expect(changed.details[0]?.sections).not.toHaveProperty("dependencies");
    expect(changed.details[0]?.unchangedSections).toContain("dependencies");

    const repeated = await adapter.featureContextQuery(context, {
      sessionId: opened.session.id,
      level: "detail",
      featureIds: [original.featureId],
      budgetTokens: 3_000,
    }) as FeatureContextResult;
    expect(repeated.details).toEqual([]);
    expect(repeated.unchangedFeatureIds).toEqual([original.featureId]);
  });
});

interface OpenResult {
  session: WorkSession;
}

interface CloseResult {
  session: { id: string; status: string };
  lease?: { id: string; status: string };
}

interface SharedContextResult {
  contextEntries: Array<{ id: string; kind: string }>;
  retrieval: {
    matchedCount: number;
    estimatedTokens: number;
    nextCursor: string | null;
  };
}

interface FeatureContextResult {
  cards: Array<{ featureId: string }>;
  details: Array<{
    id: string;
    sections: Record<string, unknown>;
    unchangedSections: string[];
    versionChangedFrom?: string;
  }>;
  unchangedFeatureIds: string[];
  retrieval: {
    matchedCount: number;
    estimatedTokens: number;
  };
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
  return { service, adapter: createMcpServiceAdapter(service), context, room };
}

function submitTrustedFeatureRevision(
  service: AgentHubService,
  context: AgentHubToolContext,
  session: WorkSession,
  input: Omit<SubmitFeatureRevisionInput, "memberToken" | "sessionId">,
): FeatureRevision {
  return new FeatureMemoryStore(service.database).submitRevision({
    roomId: context.member.roomId,
    memberId: context.member.id,
    memberName: context.member.displayName,
    defaultBranch: "main",
  }, {
    id: session.id,
    memberId: session.memberId,
    branch: session.branch,
    baseCommit: session.baseCommit,
    status: session.status,
    promotionEvidenceVerified: true,
  }, {
    ...input,
    memberToken: context.memberToken,
    sessionId: session.id,
  });
}

function finalFeatureEvidence(input: {
  branch: string;
  baseCommit: string;
  finalCommit: string;
  changedPaths: string[];
  diffSha256: string;
}): Record<string, unknown> {
  return {
    source: "codex-hook",
    event: "SessionEnd",
    featureEvidence: {
      version: 1,
      branch: input.branch,
      baseCommit: input.baseCommit,
      finalCommit: input.finalCommit,
      committed: true,
      committedPaths: input.changedPaths,
      uncommittedPaths: [],
      changedPaths: input.changedPaths,
      commitHashes: [input.finalCommit],
      diffSha256: input.diffSha256,
    },
  };
}
