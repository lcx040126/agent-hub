import { describe, expect, it } from "vitest";
import {
  retrieveFeatureMemory,
  type FeatureMemoryIndexEntry,
  type FeatureMemoryRetrievalItem,
} from "./context-retrieval.js";

function memory(
  memoryId: string,
  overrides: Partial<FeatureMemoryIndexEntry> = {},
): FeatureMemoryIndexEntry {
  return {
    memoryId,
    versionId: `${memoryId}-v1`,
    featureName: `Feature ${memoryId}`,
    systemId: "inventory",
    objective: `Implement ${memoryId}`,
    behaviorContract: `${memoryId} remains compatible`,
    paths: [`src/${memoryId}.ts`],
    symbols: [`Inventory.${memoryId}`],
    tests: [`tests/${memoryId}.test.ts`],
    dependencies: [],
    validationStatus: "passed",
    state: "current",
    sections: {
      behavior: `${memoryId} behavior`,
      constraints: `${memoryId} constraints`,
      implementation: `${memoryId} implementation`,
    },
    evidence: { command: `test ${memoryId}`, result: "passed" },
    ...overrides,
  };
}

function itemById(items: FeatureMemoryRetrievalItem[], memoryId: string) {
  return items.find((item) => item.memoryId === memoryId);
}

describe("retrieveFeatureMemory ranking", () => {
  it("ranks exact symbols, tests, paths, systems, and objective matches with reasons", () => {
    const entries = [
      memory("objective", { systemId: "other", objective: "add inventory sorting", paths: [], symbols: [], tests: [] }),
      memory("system", { systemId: "inventory", objective: "unrelated", paths: [], symbols: [], tests: [] }),
      memory("path", { systemId: "other", objective: "unrelated", paths: ["src/target.ts"], symbols: [], tests: [] }),
      memory("test", { systemId: "other", objective: "unrelated", paths: [], symbols: [], tests: ["tests/target.test.ts"] }),
      memory("symbol", { systemId: "other", objective: "unrelated", paths: [], symbols: ["Inventory.Target"], tests: [] }),
    ];
    const result = retrieveFeatureMemory(entries, {
      mode: "planning",
      objective: "inventory sorting",
      systems: ["inventory"],
      paths: ["src/target.ts"],
      symbols: ["Inventory.Target"],
      tests: ["tests/target.test.ts"],
    });

    expect(result.items.map((item) => item.memoryId)).toEqual([
      "symbol",
      "test",
      "path",
      "system",
      "objective",
    ]);
    expect(itemById(result.items, "symbol")?.hitReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "symbol", matched: "Inventory.Target" }),
    ]));
    expect(itemById(result.items, "path")?.hitReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "path", matched: "src/target.ts" }),
    ]));
  });

  it("returns objective-only low-confidence matches as stubs", () => {
    const result = retrieveFeatureMemory([
      memory("drag", { systemId: "other", objective: "drag inventory items between slots" }),
    ], { mode: "planning", objective: "drag inventory items" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ memoryId: "drag", kind: "stub", candidate: true });
    expect(result.items[0]).not.toHaveProperty("behaviorContract");
  });

  it("never returns every memory when the query has no criteria", () => {
    const result = retrieveFeatureMemory(
      Array.from({ length: 100 }, (_, index) => memory(`memory-${index}`)),
      { mode: "startup" },
    );

    expect(result.items).toEqual([]);
    expect(result.matchedCount).toBe(0);
    expect(result.estimatedTokens).toBe(0);
  });
});

describe("retrieveFeatureMemory result shaping", () => {
  it("limits planning results to eight and detail results to three", () => {
    const entries = Array.from({ length: 12 }, (_, index) => memory(`memory-${index}`));
    const planning = retrieveFeatureMemory(entries, { mode: "planning", systems: ["inventory"] });
    const detail = retrieveFeatureMemory(entries, {
      mode: "detail",
      memoryIds: entries.slice(0, 5).map((entry) => entry.memoryId),
    });

    expect(planning.items).toHaveLength(8);
    expect(planning.items.every((item) => item.kind === "card")).toBe(true);
    expect(planning.truncated).toBe(true);
    expect(detail.items).toHaveLength(3);
    expect(detail.items.every((item) => item.kind === "detail")).toBe(true);
  });

  it("keeps draft, candidate, and conflict memories as status-only hints by default", () => {
    const entries = [
      memory("current"),
      memory("draft", { state: "draft" }),
      memory("candidate", { state: "candidate" }),
      memory("conflict", { state: "conflict" }),
    ];
    const current = retrieveFeatureMemory(entries, { mode: "detail", memoryIds: ["current"] });
    expect(itemById(current.items, "current")?.kind).toBe("detail");
    for (const memoryId of ["draft", "candidate", "conflict"]) {
      const result = retrieveFeatureMemory(entries, { mode: "detail", memoryIds: [memoryId] });
      expect(itemById(result.items, memoryId)).toMatchObject({ kind: "status", statusOnly: true });
      expect(itemById(result.items, memoryId)).not.toHaveProperty("behaviorContract");
    }
  });

  it("returns only evidence in evidence mode", () => {
    const result = retrieveFeatureMemory([memory("verified")], {
      mode: "evidence",
      memoryIds: ["verified"],
    });

    expect(result.items[0]).toMatchObject({
      kind: "evidence",
      memoryId: "verified",
      evidence: { command: "test verified", result: "passed" },
    });
    expect(result.items[0]).not.toHaveProperty("behaviorContract");
  });
});

describe("retrieveFeatureMemory incremental delivery", () => {
  it("filters a version already known by the session", () => {
    const entry = memory("known");
    const result = retrieveFeatureMemory([entry], {
      mode: "planning",
      memoryIds: [entry.memoryId],
      knownVersions: { [entry.memoryId]: entry.versionId },
    });

    expect(result.items).toEqual([]);
    expect(result.unchangedMemoryIds).toEqual([entry.memoryId]);

    const detail = retrieveFeatureMemory([entry], { mode: "detail", memoryIds: [entry.memoryId] });
    const loaded = detail.items[0];
    if (!loaded || loaded.kind !== "detail") throw new Error("Expected a detail result.");
    const afterDetail = retrieveFeatureMemory([entry], {
      mode: "planning",
      memoryIds: [entry.memoryId],
      knownVersions: {
        [entry.memoryId]: { versionId: entry.versionId, sectionHashes: loaded.sectionHashes },
      },
    });
    expect(afterDetail.items).toEqual([]);
  });

  it("marks a new version and returns only changed detail sections", () => {
    const oldEntry = memory("versioned");
    const first = retrieveFeatureMemory([oldEntry], {
      mode: "detail",
      memoryIds: [oldEntry.memoryId],
    });
    const oldDetail = first.items[0];
    expect(oldDetail?.kind).toBe("detail");
    if (!oldDetail || oldDetail.kind !== "detail") throw new Error("Expected a detail result.");

    const nextEntry = memory("versioned", {
      versionId: "versioned-v2",
      sections: {
        behavior: "versioned behavior",
        constraints: "changed constraints",
        implementation: "versioned implementation",
      },
    });
    const second = retrieveFeatureMemory([nextEntry], {
      mode: "detail",
      memoryIds: [nextEntry.memoryId],
      knownVersions: {
        [nextEntry.memoryId]: {
          versionId: oldEntry.versionId,
          sectionHashes: oldDetail.sectionHashes,
        },
      },
    });
    const nextDetail = second.items[0];
    expect(nextDetail?.kind).toBe("detail");
    if (!nextDetail || nextDetail.kind !== "detail") throw new Error("Expected a detail result.");
    expect(nextDetail.versionChangedFrom).toBe(oldEntry.versionId);
    expect(nextDetail.sections).toEqual({ constraints: "changed constraints" });
    expect(nextDetail.unchangedSections).toEqual(["behavior", "implementation"]);
  });

  it("keeps budget metadata within the configured hard limit", () => {
    const result = retrieveFeatureMemory(
      Array.from({ length: 20 }, (_, index) => memory(`budget-${index}`)),
      { mode: "planning", systems: ["inventory"], budgetTokens: 99_999 },
    );

    expect(result.budgetTokens).toBe(3_000);
    expect(result.estimatedTokens).toBeLessThanOrEqual(result.budgetTokens);
    expect(() => retrieveFeatureMemory([], {
      mode: "planning",
      objective: "anything",
      limit: 0.5,
    })).toThrow(RangeError);
  });
});
