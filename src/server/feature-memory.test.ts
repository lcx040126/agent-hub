import { afterEach, describe, expect, it } from "vitest";
import { AgentHubDatabase } from "./db.js";
import type {
  CreateRoomResult,
  FeatureTargetInput,
  SubmitFeatureRevisionInput,
  WorkSession,
} from "./domain.js";
import {
  FeatureMemoryError,
  FeatureMemoryStore,
  type FeatureMemoryActor,
} from "./feature-memory.js";
import { AgentHubService } from "./service.js";

const databases: AgentHubDatabase[] = [];
const passedVerification = [{
  testKey: "inventory-regression",
  result: "passed" as const,
  summary: "The inventory regression suite passed.",
  command: "pnpm test inventory",
}];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

interface TestContext {
  database: AgentHubDatabase;
  service: AgentHubService;
  store: FeatureMemoryStore;
  owner: CreateRoomResult;
  actor: FeatureMemoryActor;
  session: WorkSession & { promotionEvidenceVerified: true };
}

function setup(): TestContext {
  const database = new AgentHubDatabase({ path: ":memory:" });
  databases.push(database);
  const now = () => new Date("2026-08-26T08:00:00.000Z");
  const service = new AgentHubService(database, { now });
  const owner = service.createRoom({
    name: "Feature memory tests",
    projectName: "Agent Hub",
    repository: "https://github.com/example/agent-hub.git",
    defaultBranch: "main",
    hostName: "Alice",
    hostAgent: "Codex",
  });
  const session = service.openSession({
    memberToken: owner.memberToken,
    agentName: "Codex",
    repository: owner.room.repository,
    branch: "main",
    baseCommit: "base-main",
    task: "Protect completed inventory behavior",
  });
  return {
    database,
    service,
    store: new FeatureMemoryStore(database, now),
    owner,
    actor: {
      roomId: owner.room.id,
      memberId: owner.member.id,
      memberName: owner.member.displayName,
      defaultBranch: owner.room.defaultBranch,
    },
    session: { ...session, promotionEvidenceVerified: true },
  };
}

function revisionInput(
  context: TestContext,
  overrides: Partial<SubmitFeatureRevisionInput> = {},
): SubmitFeatureRevisionInput {
  return {
    memberToken: context.owner.memberToken,
    sessionId: context.session.id,
    featureKey: "inventory.detach-attachment",
    name: "Detach weapon attachments",
    systemId: "inventory",
    relation: "add",
    objective: "Allow an attachment to be removed without losing it.",
    changeSummary: "Implemented attachment detachment.",
    contractChanges: [{
      operation: "add",
      key: "detached-item-is-preserved",
      behavior: "A detached attachment is returned to inventory.",
      constraints: ["Never silently destroy an attachment."],
    }],
    targets: [{
      kind: "symbol",
      path: "src/inventory/attachment-service.ts",
      symbol: "AttachmentService.detach",
    }],
    finalCommit: "commit-stable",
    completed: true,
    verifications: passedVerification,
    gitEvidence: { changedPaths: ["src/inventory/attachment-service.ts"] },
    ...overrides,
  };
}

function openOwnerSession(context: TestContext, branch: string): WorkSession {
  return context.service.openSession({
    memberToken: context.owner.memberToken,
    agentName: "Codex",
    repository: context.owner.room.repository,
    branch,
    baseCommit: `base-${branch}`,
    task: `Work on ${branch}`,
  });
}

describe("FeatureMemoryStore revision lifecycle", () => {
  it("promotes only completed, committed, verified default-branch revisions", () => {
    const context = setup();
    const stable = context.store.submitRevision(
      context.actor,
      context.session,
      revisionInput(context),
    );
    expect(stable.status).toBe("current");

    const draft = context.store.submitRevision(context.actor, context.session, revisionInput(context, {
      parentRevisionId: stable.id,
      relation: "extend",
      changeSummary: "Started a draft extension.",
      contractChanges: [{
        operation: "add",
        key: "draft-preview",
        behavior: "Preview a draft detach operation.",
      }],
      completed: false,
      finalCommit: undefined,
    }));
    expect(draft.status).toBe("draft");

    const featureSession = openOwnerSession(context, "feature/detach-preview");
    const branchCandidate = context.store.submitRevision(context.actor, featureSession, revisionInput(context, {
      sessionId: featureSession.id,
      parentRevisionId: stable.id,
      relation: "extend",
      changeSummary: "Committed the preview on a feature branch.",
      contractChanges: [{
        operation: "add",
        key: "branch-preview",
        behavior: "Preview detachment from the feature branch.",
      }],
      finalCommit: "commit-feature-branch",
    }));
    expect(branchCandidate.status).toBe("candidate");

    const failedCandidate = context.store.submitRevision(context.actor, context.session, revisionInput(context, {
      parentRevisionId: stable.id,
      relation: "extend",
      changeSummary: "Added a failed candidate.",
      contractChanges: [{
        operation: "add",
        key: "failed-preview",
        behavior: "Preview detachment after a failed regression run.",
      }],
      finalCommit: "commit-failed-tests",
      verifications: [{
        testKey: "inventory-regression",
        result: "failed",
        summary: "The existing attachment test failed.",
      }],
    }));
    expect(failedCandidate.status).toBe("candidate");

    const missingVerification = context.store.submitRevision(context.actor, context.session, revisionInput(context, {
      parentRevisionId: stable.id,
      relation: "extend",
      changeSummary: "Added an unverified candidate.",
      contractChanges: [{
        operation: "add",
        key: "unverified-preview",
        behavior: "Preview detachment without regression evidence.",
      }],
      finalCommit: "commit-without-tests",
      verifications: [],
    }));
    expect(missingVerification.status).toBe("candidate");

    const history = context.store.history(context.actor, stable.featureId);
    expect(history.feature.currentRevisionId).toBe(stable.id);
    expect(context.store.query(context.actor, {
      memberToken: context.owner.memberToken,
      featureIds: [stable.featureId],
      level: "detail",
    }).details.map((revision) => revision.id)).toEqual([stable.id]);
  });

  it("does not let draft metadata alter the current effective feature view", () => {
    const context = setup();
    const stable = context.store.submitRevision(
      context.actor,
      context.session,
      revisionInput(context),
    );
    const draft = context.store.submitRevision(context.actor, context.session, revisionInput(context, {
      parentRevisionId: stable.id,
      relation: "extend",
      name: "Draft-only renamed feature",
      systemId: "combat",
      changeSummary: "Explored moving this feature to another system.",
      contractChanges: [{
        operation: "add",
        key: "draft-only-contract",
        behavior: "This behavior has not been accepted yet.",
      }],
      completed: false,
      finalCommit: undefined,
    }));
    expect(draft.status).toBe("draft");

    const history = context.store.history(context.actor, stable.featureId);
    expect(history.feature).toMatchObject({
      name: "Detach weapon attachments",
      systemId: "inventory",
      currentRevisionId: stable.id,
    });
    expect(context.store.query(context.actor, {
      memberToken: context.owner.memberToken,
      systems: ["inventory"],
    }).cards.map((card) => card.revisionId)).toEqual([stable.id]);
    expect(context.store.query(context.actor, {
      memberToken: context.owner.memberToken,
      systems: ["combat"],
    }).cards).toEqual([]);
  });

  it("keeps the current contracts when a completed revision was based on a stale parent", () => {
    const context = setup();
    const original = context.store.submitRevision(context.actor, context.session, revisionInput(context));
    const current = context.store.submitRevision(context.actor, context.session, revisionInput(context, {
      parentRevisionId: original.id,
      relation: "extend",
      changeSummary: "Added a contract after the original revision.",
      contractChanges: [{
        operation: "add",
        key: "new-current-contract",
        behavior: "The newer current behavior must survive concurrent work.",
      }],
      finalCommit: "commit-current-v2",
    }));
    expect(current.status).toBe("current");

    const stale = context.store.submitRevision(context.actor, context.session, revisionInput(context, {
      parentRevisionId: original.id,
      relation: "extend",
      changeSummary: "Finished old work without rebasing its feature memory.",
      contractChanges: [{
        operation: "add",
        key: "stale-branch-contract",
        behavior: "This behavior needs explicit reconciliation.",
      }],
      finalCommit: "commit-stale-v3",
    }));

    expect(stale.status).toBe("conflict");
    const history = context.store.history(context.actor, original.featureId);
    expect(history.feature.currentRevisionId).toBe(current.id);
    const currentView = context.store.query(context.actor, {
      memberToken: context.owner.memberToken,
      featureIds: [original.featureId],
      level: "detail",
    });
    expect(currentView.details[0]?.snapshot.contracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "new-current-contract" }),
      ]),
    );
  });

  it("keeps separate features and inherits untouched contracts, targets, constraints, and dependencies", () => {
    const context = setup();
    const featureA = context.store.submitRevision(context.actor, context.session, revisionInput(context, {
      contractChanges: [
        {
          operation: "add",
          key: "detached-item-is-preserved",
          behavior: "A detached attachment is returned to inventory.",
          constraints: ["Never silently destroy an attachment."],
        },
        {
          operation: "add",
          key: "incompatible-slot-is-rejected",
          behavior: "An incompatible destination is rejected without changing the weapon.",
        },
      ],
      constraints: ["The operation is atomic."],
      dependencies: ["weapon-loadout"],
      targets: [
        {
          kind: "symbol",
          path: "src/inventory/attachment-service.ts",
          symbol: "AttachmentService.detach",
        },
        {
          kind: "test",
          path: "tests/inventory/attachment-service.test.ts",
        },
      ],
    }));
    const featureB = context.store.submitRevision(context.actor, context.session, revisionInput(context, {
      featureKey: "inventory.sort-backpack",
      name: "Sort backpack",
      objective: "Sort backpack items while preserving slot contents.",
      changeSummary: "Implemented backpack sorting.",
      contractChanges: [{
        operation: "add",
        key: "stable-sort",
        behavior: "Equal items retain their relative order.",
      }],
      targets: [{
        kind: "symbol",
        path: "src/inventory/backpack-sorter.ts",
        symbol: "BackpackSorter.sort",
      }],
      finalCommit: "commit-feature-b",
    }));

    const updatedA = context.store.submitRevision(context.actor, context.session, revisionInput(context, {
      parentRevisionId: featureA.id,
      relation: "extend",
      objective: "Detach attachments into a selected compatible slot.",
      changeSummary: "Extended detachment with destination selection.",
      contractChanges: [{
        operation: "update",
        key: "detached-item-is-preserved",
        behavior: "A detached attachment is returned to the selected inventory slot.",
        constraints: ["Preserve its item instance identity."],
      }],
      constraints: ["Publish one inventory change event."],
      dependencies: ["inventory-events"],
      targets: [{
        kind: "interface",
        path: "src/inventory/inventory-api.ts",
        symbol: "InventoryApi.detachAttachment",
      }],
      finalCommit: "commit-feature-a-v2",
    }));

    expect(updatedA.status).toBe("current");
    expect(updatedA.snapshot.contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "detached-item-is-preserved",
        behavior: "A detached attachment is returned to the selected inventory slot.",
        constraints: expect.arrayContaining([
          "Never silently destroy an attachment.",
          "Preserve its item instance identity.",
        ]),
      }),
      expect.objectContaining({
        key: "incompatible-slot-is-rejected",
        behavior: "An incompatible destination is rejected without changing the weapon.",
      }),
    ]));
    expect(updatedA.snapshot.constraints).toEqual(expect.arrayContaining([
      "The operation is atomic.",
      "Publish one inventory change event.",
    ]));
    expect(updatedA.snapshot.dependencies).toEqual(expect.arrayContaining([
      "weapon-loadout",
      "inventory-events",
    ]));
    expect(updatedA.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "symbol", symbol: "AttachmentService.detach" }),
      expect.objectContaining({ kind: "test", path: "tests/inventory/attachment-service.test.ts" }),
      expect.objectContaining({ kind: "interface", symbol: "InventoryApi.detachAttachment" }),
    ]));

    const history = context.store.history(context.actor, featureA.featureId);
    expect(history.revisions.map((revision) => revision.id)).toEqual([updatedA.id, featureA.id]);
    expect(history.revisions[1]).toMatchObject({
      status: "superseded",
      snapshot: {
        contracts: expect.arrayContaining([
          expect.objectContaining({
            key: "detached-item-is-preserved",
            behavior: "A detached attachment is returned to inventory.",
          }),
        ]),
      },
    });

    const currentSystemView = context.store.query(context.actor, {
      memberToken: context.owner.memberToken,
      systems: ["inventory"],
    });
    expect(new Set(currentSystemView.cards.map((card) => card.featureId))).toEqual(
      new Set([featureA.featureId, featureB.featureId]),
    );
    expect(currentSystemView.cards.find((card) => card.featureId === featureA.featureId)?.revisionId)
      .toBe(updatedA.id);
  });

  it("marks competing same-parent contract changes as conflicts without replacing the stable revision", () => {
    const context = setup();
    const stable = context.store.submitRevision(context.actor, context.session, revisionInput(context));
    const branchA = openOwnerSession(context, "feature/detach-a");
    const candidateA = context.store.submitRevision(context.actor, branchA, revisionInput(context, {
      sessionId: branchA.id,
      parentRevisionId: stable.id,
      relation: "replace",
      changeSummary: "Changed the detach destination on branch A.",
      contractChanges: [{
        operation: "update",
        key: "detached-item-is-preserved",
        behavior: "Branch A sends the attachment to the backpack.",
      }],
      finalCommit: "commit-branch-a",
    }));
    expect(candidateA.status).toBe("candidate");

    const bob = context.service.joinRoom({
      roomToken: context.owner.roomToken,
      displayName: "Bob",
      agent: "Codex",
    });
    const branchB = context.service.openSession({
      memberToken: bob.memberToken,
      agentName: "Codex",
      repository: context.owner.room.repository,
      branch: "feature/detach-b",
      baseCommit: "base-feature-b",
      task: "Implement another detach behavior",
    });
    const bobActor: FeatureMemoryActor = {
      roomId: bob.room.id,
      memberId: bob.member.id,
      memberName: bob.member.displayName,
      defaultBranch: bob.room.defaultBranch,
    };
    const candidateB = context.store.submitRevision(bobActor, branchB, revisionInput(context, {
      memberToken: bob.memberToken,
      sessionId: branchB.id,
      parentRevisionId: stable.id,
      relation: "replace",
      changeSummary: "Changed the detach destination on branch B.",
      contractChanges: [{
        operation: "update",
        key: "detached-item-is-preserved",
        behavior: "Branch B sends the attachment to a chosen equipment slot.",
      }],
      finalCommit: "commit-branch-b",
    }));

    expect(candidateB.status).toBe("conflict");
    const history = context.store.history(context.actor, stable.featureId);
    expect(history.feature.currentRevisionId).toBe(stable.id);
    expect(history.revisions.find((revision) => revision.id === candidateA.id)?.status).toBe("conflict");
    expect(history.revisions.find((revision) => revision.id === candidateB.id)?.status).toBe("conflict");
    expect(context.store.query(context.actor, {
      memberToken: context.owner.memberToken,
      featureIds: [stable.featureId],
    }).cards[0]?.revisionId).toBe(stable.id);
  });

  it("creates a new current rollback revision while retaining every prior revision", () => {
    const context = setup();
    const original = context.store.submitRevision(context.actor, context.session, revisionInput(context));
    const replacement = context.store.submitRevision(context.actor, context.session, revisionInput(context, {
      parentRevisionId: original.id,
      relation: "replace",
      changeSummary: "Changed detachment to drop the item into the world.",
      contractChanges: [{
        operation: "update",
        key: "detached-item-is-preserved",
        behavior: "A detached attachment is dropped into the world.",
      }],
      finalCommit: "commit-replacement",
    }));
    const rollback = context.store.rollbackRevision(context.actor, context.session, {
      memberToken: context.owner.memberToken,
      sessionId: context.session.id,
      featureId: original.featureId,
      targetRevisionId: original.id,
      changeSummary: "Restored inventory preservation after a regression.",
      finalCommit: "commit-rollback",
      completed: true,
      verifications: passedVerification,
      gitEvidence: { reason: "The replacement lost items." },
    });

    expect(rollback).toMatchObject({
      relation: "rollback",
      status: "current",
      parentRevisionId: replacement.id,
      snapshot: original.snapshot,
      gitEvidence: {
        reason: "The replacement lost items.",
        rollbackTargetRevisionId: original.id,
      },
    });
    const history = context.store.history(context.actor, original.featureId);
    expect(history.feature.currentRevisionId).toBe(rollback.id);
    expect(history.revisions.map((revision) => revision.id)).toEqual([
      rollback.id,
      replacement.id,
      original.id,
    ]);
    expect(history.revisions.map((revision) => revision.status)).toEqual([
      "current",
      "superseded",
      "superseded",
    ]);
    expect(context.store.query(context.actor, {
      memberToken: context.owner.memberToken,
      featureIds: [original.featureId],
      level: "detail",
    }).details[0]?.id).toBe(rollback.id);
  });

  it("requires a selector and caps cards at eight and details at three", () => {
    const context = setup();
    const featureIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const revision = context.store.submitRevision(context.actor, context.session, revisionInput(context, {
        featureKey: `inventory.feature-${index}`,
        name: `Inventory feature ${index}`,
        contractChanges: [{
          operation: "add",
          key: `contract-${index}`,
          behavior: `Preserve behavior ${index}.`,
        }],
        targets: [{
          kind: "symbol",
          path: `src/inventory/feature-${index}.ts`,
          symbol: `Feature${index}.run`,
        }],
        finalCommit: `commit-${index}`,
      }));
      featureIds.push(revision.featureId);
    }

    expect(context.store.query(context.actor, {
      memberToken: context.owner.memberToken,
    })).toMatchObject({ cards: [], details: [], nextCursor: null });
    const cards = context.store.query(context.actor, {
      memberToken: context.owner.memberToken,
      systems: ["inventory"],
      limit: 99,
    });
    expect(cards.cards).toHaveLength(8);
    expect(cards.details).toEqual([]);
    expect(cards.nextCursor).toBe("8");

    const details = context.store.query(context.actor, {
      memberToken: context.owner.memberToken,
      featureIds,
      level: "detail",
      limit: 99,
    });
    expect(details.cards).toHaveLength(3);
    expect(details.details).toHaveLength(3);
  });
});

describe("FeatureMemoryStore historical impact protection", () => {
  const protectedTargets: FeatureTargetInput[] = [
    {
      kind: "symbol",
      path: "src/inventory/attachment-service.ts",
      symbol: "AttachmentService.detach",
    },
    {
      kind: "interface",
      path: "src/inventory/inventory-api.ts",
      symbol: "InventoryApi.detachAttachment",
    },
    { kind: "resource", path: "assets/inventory/attachment-panel.prefab" },
    { kind: "test", path: "tests/inventory/attachment-service.test.ts" },
    { kind: "path", path: "config/inventory.json" },
  ];

  it("ignores unrelated symbols in the same file but catches exact symbols and path-level assets", () => {
    const context = setup();
    context.store.submitRevision(context.actor, context.session, revisionInput(context, {
      targets: protectedTargets,
    }));

    const unrelated = context.store.checkHistoricalImpacts({
      actor: context.actor,
      session: context.session,
      paths: ["src/inventory/attachment-service.ts"],
      proposedEdits: [{
        path: "src/inventory/attachment-service.ts",
        precision: "symbol",
        symbols: ["AttachmentService.preview"],
        operation: "add",
      }],
    });
    expect(unrelated).toEqual({ impacts: [], authorized: true });

    const exactSymbol = context.store.checkHistoricalImpacts({
      actor: context.actor,
      session: context.session,
      paths: ["src/inventory/attachment-service.ts"],
      proposedEdits: [{
        path: "src/inventory/attachment-service.ts",
        precision: "symbol",
        symbols: ["AttachmentService.detach"],
        operation: "update",
      }],
    });
    expect(exactSymbol.authorized).toBe(false);
    expect(exactSymbol.impacts).toEqual([
      expect.objectContaining({
        path: "src/inventory/attachment-service.ts",
        symbols: ["AttachmentService.detach"],
        confidence: "exact",
      }),
    ]);
    expect(exactSymbol.confirmation?.status).toBe("pending");

    const exactInterface = context.store.checkHistoricalImpacts({
      actor: context.actor,
      session: context.session,
      paths: ["src/inventory/inventory-api.ts"],
      proposedEdits: [{
        path: "src/inventory/inventory-api.ts",
        precision: "symbol",
        symbols: ["InventoryApi.detachAttachment"],
        operation: "update",
      }],
    });
    expect(exactInterface.impacts[0]).toMatchObject({
      symbols: ["InventoryApi.detachAttachment"],
      confidence: "exact",
    });

    for (const path of [
      "assets/inventory/attachment-panel.prefab",
      "tests/inventory/attachment-service.test.ts",
      "config/inventory.json",
    ]) {
      const result = context.store.checkHistoricalImpacts({
        actor: context.actor,
        session: context.session,
        paths: [path],
        proposedEdits: [{
          path,
          precision: "symbol",
          symbols: ["Unrelated.symbol"],
          operation: "update",
        }],
      });
      expect(result.authorized).toBe(false);
      expect(result.impacts[0]).toMatchObject({ path, confidence: "fallback" });
    }
  });

  it("matches qualified symbols to bare Hook declarations without conflating qualified owners", () => {
    const context = setup();
    context.store.submitRevision(context.actor, context.session, revisionInput(context, {
      targets: [{ kind: "symbol", path: "src/foo.ts", symbol: "Foo.bar" }],
    }));

    for (const symbols of [["baz"], ["Foo.baz"], ["Other.bar"]]) {
      expect(context.store.checkHistoricalImpacts({
        actor: context.actor,
        session: context.session,
        paths: ["src/foo.ts"],
        proposedEdits: [{
          path: "src/foo.ts",
          precision: "symbol",
          symbols,
          operation: "add",
        }],
      })).toEqual({ impacts: [], authorized: true });
    }

    const bareBar = context.store.checkHistoricalImpacts({
      actor: context.actor,
      session: context.session,
      paths: ["src/foo.ts"],
      proposedEdits: [{
        path: "src/foo.ts",
        precision: "symbol",
        symbols: ["bar"],
        operation: "update",
      }],
    });
    expect(bareBar.authorized).toBe(false);
    expect(bareBar.impacts[0]).toMatchObject({
      path: "src/foo.ts",
      symbols: ["Foo.bar"],
      confidence: "exact",
    });

    context.store.submitRevision(context.actor, context.session, revisionInput(context, {
      featureKey: "inventory.plain-bar",
      name: "Plain bar behavior",
      contractChanges: [{
        operation: "add",
        key: "plain-bar-behavior",
        behavior: "The plain bar behavior remains compatible.",
      }],
      targets: [{ kind: "symbol", path: "src/plain.ts", symbol: "bar" }],
      gitEvidence: { changedPaths: ["src/plain.ts"] },
    }));
    const qualifiedBar = context.store.checkHistoricalImpacts({
      actor: context.actor,
      session: context.session,
      paths: ["src/plain.ts"],
      proposedEdits: [{
        path: "src/plain.ts",
        precision: "symbol",
        symbols: ["Foo.bar"],
        operation: "update",
      }],
    });
    expect(qualifiedBar.authorized).toBe(false);
    expect(qualifiedBar.impacts[0]).toMatchObject({ symbols: ["bar"], confidence: "exact" });
  });

  it("falls back conservatively when a protected symbol edit cannot be narrowed", () => {
    const context = setup();
    context.store.submitRevision(context.actor, context.session, revisionInput(context));

    const result = context.store.checkHistoricalImpacts({
      actor: context.actor,
      session: context.session,
      paths: ["src/inventory/attachment-service.ts"],
    });
    expect(result.authorized).toBe(false);
    expect(result.impacts[0]).toMatchObject({
      path: "src/inventory/attachment-service.ts",
      symbols: ["AttachmentService.detach"],
      confidence: "fallback",
    });
    expect(result.impacts[0]?.reason).toMatch(/cannot be narrowed safely/i);
  });

  it("binds approval to the exact member session and proposal, then expires it on session close", () => {
    const context = setup();
    context.store.submitRevision(context.actor, context.session, revisionInput(context));
    const proposal = {
      actor: context.actor,
      session: context.session,
      paths: ["src/inventory/attachment-service.ts"],
      proposedEdits: [{
        path: "src/inventory/attachment-service.ts",
        precision: "symbol" as const,
        symbols: ["AttachmentService.detach"],
        operation: "update" as const,
      }],
    };
    const pending = context.store.checkHistoricalImpacts(proposal);
    expect(pending.confirmation).toMatchObject({
      memberId: context.actor.memberId,
      sessionId: context.session.id,
      status: "pending",
    });

    const bob = context.service.joinRoom({
      roomToken: context.owner.roomToken,
      displayName: "Bob",
      agent: "Codex",
    });
    const bobSession = context.service.openSession({
      memberToken: bob.memberToken,
      branch: "main",
      baseCommit: "base-main",
      task: "Try to approve Alice's proposal",
    });
    const bobActor: FeatureMemoryActor = {
      roomId: bob.room.id,
      memberId: bob.member.id,
      memberName: bob.member.displayName,
      defaultBranch: bob.room.defaultBranch,
    };
    expect(() => context.store.resolveConfirmation(bobActor, bobSession, {
      memberToken: bob.memberToken,
      sessionId: bobSession.id,
      confirmationId: pending.confirmation!.id,
      decision: "approved",
    })).toThrow(/only be resolved by its current session member/i);

    const approved = context.store.resolveConfirmation(context.actor, context.session, {
      memberToken: context.owner.memberToken,
      sessionId: context.session.id,
      confirmationId: pending.confirmation!.id,
      decision: "approved",
      reason: "This task intentionally updates the recorded behavior.",
    });
    expect(approved.status).toBe("approved");
    expect(context.store.checkHistoricalImpacts(proposal)).toMatchObject({
      authorized: true,
      confirmation: { id: approved.id, status: "approved" },
    });

    const changedProposal = context.store.checkHistoricalImpacts({
      ...proposal,
      proposedEdits: [{
        ...proposal.proposedEdits[0],
        symbols: ["AttachmentService.detach", "AttachmentService.detachAll"],
      }],
    });
    expect(changedProposal.authorized).toBe(false);
    expect(changedProposal.confirmation).toMatchObject({ status: "pending" });
    expect(changedProposal.confirmation?.id).not.toBe(approved.id);

    context.service.closeSession({
      memberToken: context.owner.memberToken,
      sessionId: context.session.id,
      summary: "Finished the task.",
    });
    expect(context.store.checkHistoricalImpacts(proposal)).toMatchObject({
      authorized: false,
      confirmation: { id: approved.id, status: "expired" },
    });
  });

  it("does not allow a rejected feature confirmation to be changed to approved", () => {
    const context = setup();
    context.store.submitRevision(context.actor, context.session, revisionInput(context));
    const proposal = {
      actor: context.actor,
      session: context.session,
      paths: ["src/inventory/attachment-service.ts"],
      proposedEdits: [{
        path: "src/inventory/attachment-service.ts",
        precision: "symbol" as const,
        symbols: ["AttachmentService.detach"],
        operation: "update" as const,
      }],
    };
    const pending = context.store.checkHistoricalImpacts(proposal);
    const rejected = context.store.resolveConfirmation(context.actor, context.session, {
      memberToken: context.owner.memberToken,
      sessionId: context.session.id,
      confirmationId: pending.confirmation!.id,
      decision: "rejected",
      reason: "Keep the established behavior unchanged.",
    });
    expect(rejected.status).toBe("rejected");

    expect(() => context.store.resolveConfirmation(context.actor, context.session, {
      memberToken: context.owner.memberToken,
      sessionId: context.session.id,
      confirmationId: rejected.id,
      decision: "approved",
    })).toThrow(/already rejected/i);
    expect(context.store.checkHistoricalImpacts(proposal)).toMatchObject({
      authorized: false,
      confirmation: { id: rejected.id, status: "rejected" },
    });
  });

  it("rejects impact checks and confirmations from inactive or foreign sessions", () => {
    const context = setup();
    context.store.submitRevision(context.actor, context.session, revisionInput(context));
    const closedSession = { ...context.session, status: "closed" as const };
    expect(() => context.store.checkHistoricalImpacts({
      actor: context.actor,
      session: closedSession,
      paths: ["src/inventory/attachment-service.ts"],
    })).toThrowError(FeatureMemoryError);

    const foreignSession = { ...context.session, memberId: "another-member" };
    expect(() => context.store.checkHistoricalImpacts({
      actor: context.actor,
      session: foreignSession,
      paths: ["src/inventory/attachment-service.ts"],
    })).toThrow(/belongs to another member/i);
  });
});
