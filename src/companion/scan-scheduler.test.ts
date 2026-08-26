import { describe, expect, it } from "vitest";
import type { RepositorySnapshot } from "./repository.js";
import { createBackgroundScanPayload } from "./scan-scheduler.js";

describe("background repository scan attribution", () => {
  it("keeps manual, IDE, and Unity changed paths off the room server", () => {
    const snapshot: RepositorySnapshot = {
      repository: {
        root: "C:/project",
        name: "project",
        remote: null,
        branch: "main",
        headCommit: "abc123",
        rootCommit: "abc123",
        fingerprint: "fingerprint",
      },
      generatedAt: "2026-08-26T00:00:00.000Z",
      changedPaths: ["Assets/Scenes/Manual.unity", "src/ide-save.ts"],
      ruleFiles: [],
      systems: [],
      dependencies: [],
      impactedSystemIds: ["manual", "ide-save"],
      analysis: {
        trackedFileCount: 2,
        parsedCSharpFileCount: 0,
        unityReferenceCount: 1,
        historyCommitCount: 1,
        truncated: false,
      },
    };

    const payload = createBackgroundScanPayload(snapshot);
    expect(payload.changedPaths).toEqual([]);
    expect(payload.metadata).toMatchObject({ externalChangesExcluded: true });
    expect(payload.metadata).not.toHaveProperty("impactedSystemIds");
    expect(payload.metadata).not.toHaveProperty("changedPathCount");
  });
});
