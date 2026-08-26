import { describe, expect, it } from "vitest";
import { estimateContextTokens } from "../server/context-budget.js";
import { AgentHubHttpError } from "./hub-client.js";
import {
  extractWriteIntent,
  featureEvidenceAttestation,
  formatRoomContext,
  shouldDiscardLeaseRenewal,
} from "./codex-hook.js";

describe("Codex hook write detection", () => {
  it("extracts every source and destination from apply_patch", () => {
    const intent = extractWriteIntent("apply_patch", {
      command: [
        "*** Begin Patch",
        "*** Update File: src/existing.ts",
        "*** Move to: src/moved.ts",
        "*** Add File: src/new.ts",
        "*** Delete File: src/old.ts",
        "*** End Patch",
      ].join("\n"),
    });

    expect(intent).toEqual({
      writes: true,
      pathCandidates: ["src/existing.ts", "src/moved.ts", "src/new.ts", "src/old.ts"],
    });
  });

  it("does not treat read-only shell commands as writes", () => {
    expect(extractWriteIntent("Bash", { command: "git diff -- src/app.ts" })).toEqual({
      writes: false,
      pathCandidates: [],
    });
  });

  it("detects PowerShell and redirection targets", () => {
    expect(extractWriteIntent("Bash", {
      command: "Set-Content -LiteralPath 'src/config.json' -Value '{}'",
    })).toMatchObject({ writes: true, pathCandidates: ["src/config.json"] });
    expect(extractWriteIntent("Bash", {
      command: "tool.exe > artifacts/result.txt",
    })).toMatchObject({ writes: true, pathCandidates: ["artifacts/result.txt"] });
  });

  it("drops local lease references after the server reports missing or expired state", () => {
    expect(shouldDiscardLeaseRenewal(new AgentHubHttpError(404, "not_found", "missing"))).toBe(true);
    expect(shouldDiscardLeaseRenewal(new AgentHubHttpError(409, "lease_not_active", "expired"))).toBe(true);
    expect(shouldDiscardLeaseRenewal(new AgentHubHttpError(500, "server_error", "retry"))).toBe(false);
  });

  it("keeps final feature evidence compact for 100 long paths", () => {
    const finalCommit = "b".repeat(40);
    const paths = Array.from({ length: 100 }, (_, index) =>
      `Assets/VeryLongFeatureDirectory${index.toString().padStart(3, "0")}/${"nested-segment/".repeat(8)}Feature${index}.cs`);
    const attestation = featureEvidenceAttestation({
      repositoryRoot: "C:/project",
      branch: "main",
      baseCommit: "a".repeat(40),
      finalCommit,
      committed: true,
      committedPaths: paths,
      uncommittedPaths: [],
      changedPaths: paths,
      commits: [{
        hash: finalCommit,
        author: "Agent",
        authorEmail: "agent@example.test",
        authoredAt: "2026-08-26T00:00:00.000Z",
        subject: "Complete feature",
      }],
      diffSummary: "100 files changed",
      diffSha256: "c".repeat(64),
      symbols: [],
      symbolLocations: [],
      dependencies: [],
      relatedTests: [],
      inferredSystems: ["feature"],
    });

    expect(attestation).toMatchObject({
      version: 2,
      committedPathCount: 100,
      uncommittedPathCount: 0,
      changedPathCount: 100,
      commitHashCount: 1,
      finalCommitIncluded: true,
    });
    expect(JSON.stringify(attestation).length).toBeLessThan(2_000);
  });

  it("packs complete SessionStart entries into the 2,500-token budget", () => {
    const records = Array.from({ length: 100 }, (_, index) => ({
      id: `risk-${index}`,
      kind: "risk",
      status: "open",
      title: `Risk ${index}`,
      summary: `Complete summary ${index} ${"evidence ".repeat(25)}`,
    }));
    const context = formatRoomContext(
      {
        room: {
          name: "Budget room",
          blockingProtectionEnabled: true,
          riskPolicyVersion: 4,
          automaticLeaseTtlMinutes: 10,
        },
        members: [],
        activeLeases: [],
        decisions: [],
        verifications: [],
        featureMemories: [{
          featureId: "inventory-drag",
          featureKey: "inventory-drag",
          revisionId: "revision-1",
          revisionNumber: 1,
          name: "背包物品拖拽",
          systemId: "inventory",
          coreContract: "物品可以在背包格与存储格之间拖拽，既有交换语义必须保留。",
          paths: ["src/inventory/drag.ts", "src/inventory/store.ts"],
        }],
        records,
      },
      {
        id: "connection",
        serverUrl: "http://127.0.0.1:4317",
        repositoryPath: "C:/project",
        roomName: "Budget room",
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
      },
      {
        repositoryRoot: "C:/project",
        branch: "main",
        headCommit: "1234567890abcdef",
        changedPaths: [],
        changedPathFingerprints: {},
      },
      "hub-session",
    );

    expect(estimateContextTokens(context)).toBeLessThanOrEqual(2_500);
    expect(context).toContain("还有更多完整协作条目未在启动层加载");
    expect(context).toContain("长期功能记忆：背包物品拖拽 [inventory]");
    expect(context).toContain("既有交换语义必须保留");
    for (const line of context.split("\n").filter((value) => value.startsWith("未解决风险："))) {
      const index = Number(line.match(/^未解决风险：Risk (\d+):/)?.[1]);
      expect(line).toBe(`未解决风险：Risk ${index}: ${records[index]?.summary.trim()}`);
    }
  });
});
