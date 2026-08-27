import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexHookSessionState } from "./hook-state.js";
import { SessionEndQueueStore } from "./session-end-queue.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("session-end persistent queue", () => {
  it("persists one deterministic token-free job and recovers retry state", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "agent-hub-session-end-queue-"));
    temporaryDirectories.push(userDataPath);
    const queue = new SessionEndQueueStore(userDataPath);
    const state = sessionState(userDataPath);
    const first = await queue.enqueue(state, "other", new Date("2026-08-27T00:00:00.000Z"));
    const repeated = await queue.enqueue(state, "shutdown", new Date("2026-08-27T00:00:01.000Z"));

    expect(first.finalizationId).toBe(state.finalizationId);
    expect(repeated).toEqual(first);
    expect(await queue.list()).toEqual([first]);
    const persisted = await readFile(
      path.join(queue.directory, `${first.finalizationId}.json`),
      "utf8",
    );
    expect(persisted).not.toContain("member-token");
    expect(persisted).not.toContain("diff --git");

    const failed = await queue.recordFailure(
      first,
      new Error("room offline"),
      new Date("2026-08-27T00:00:10.000Z"),
    );
    expect(failed).toMatchObject({ attempts: 1, lastError: "room offline" });
    expect(failed.nextAttemptAt).toBe("2026-08-27T00:00:12.000Z");
    await expect(new SessionEndQueueStore(userDataPath).list()).resolves.toEqual([failed]);
  });
});

function sessionState(repositoryPath: string): CodexHookSessionState {
  return {
    version: 1,
    codexSessionId: "codex-session",
    connectionId: "connection-a",
    hubSessionId: "hub-session-a",
    finalizationId: "finalization-a",
    repositoryPath,
    branch: "main",
    baseCommit: "0123456789abcdef",
    initialChangedPaths: [],
    initialChangedFingerprints: {},
    observedChangedPaths: ["src/value.ts"],
    observedChangedFingerprints: { "src/value.ts": "fingerprint" },
    attributedChangedPaths: ["src/value.ts"],
    leases: [{
      id: "lease-a",
      paths: ["src/value.ts"],
      expiresAt: "2026-08-27T01:00:00.000Z",
    }],
    openedAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}
