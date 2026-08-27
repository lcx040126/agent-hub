import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexHookSessionState } from "./hook-state.js";
import { TurnCompletionQueueStore } from "./turn-completion-queue.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("turn completion persistent queue", () => {
  it("uses the actual lease deadline and keeps newer epochs isolated from stale retries", async () => {
    const userDataPath = await temporaryDirectory();
    const queue = new TurnCompletionQueueStore(userDataPath);
    const state = hookState(userDataPath, "connection-a");
    const oldJob = await queue.enqueue({
      operationId: "operation-old",
      turnId: "turn-old",
      activityEpoch: 0,
      state,
    }, new Date("2026-08-27T00:00:00.000Z"));
    const newJob = await queue.enqueue({
      operationId: "operation-new",
      turnId: "turn-new",
      activityEpoch: 1,
      state,
    }, new Date("2026-08-27T00:00:01.000Z"));

    expect(oldJob.expiresAt).toBe("2026-08-27T00:05:00.000Z");
    await queue.recordRetry(oldJob, new Error("old response"), new Date("2026-08-27T00:00:02.000Z"));
    await queue.remove(oldJob.operationId);
    await expect(queue.list()).resolves.toEqual([newJob]);
  });

  it("marks initial-dirty path evidence incomplete while preserving a trustworthy empty set", async () => {
    const userDataPath = await temporaryDirectory();
    const queue = new TurnCompletionQueueStore(userDataPath);
    const initialDirty = hookState(userDataPath, "connection-dirty");
    initialDirty.attributedChangedPaths = ["src/task.ts"];
    initialDirty.attributedPathEvidence = [{
      path: "src/task.ts",
      baseEntry: null,
      attributedEntry: `blob:${"b".repeat(40)}`,
    }];

    const incomplete = await queue.enqueue({
      operationId: "operation-incomplete",
      turnId: "turn-incomplete",
      activityEpoch: 0,
      state: initialDirty,
    });
    const empty = await queue.enqueue({
      operationId: "operation-empty",
      turnId: "turn-empty",
      activityEpoch: 0,
      state: hookState(userDataPath, "connection-empty"),
    });

    expect(incomplete.attributionComplete).toBe(false);
    expect(empty.attributionComplete).toBe(true);
  });

  it("uses the maximum automatic TTL when recovered state cannot account for server leases", async () => {
    const userDataPath = await temporaryDirectory();
    const queue = new TurnCompletionQueueStore(userDataPath);
    const recovered = hookState(userDataPath, "connection-recovered");
    recovered.leases = [];
    recovered.leaseAttributionComplete = false;

    const job = await queue.enqueue({
      operationId: "operation-recovered",
      turnId: "turn-recovered",
      activityEpoch: 3,
      state: recovered,
    }, new Date("2026-08-27T00:00:00.000Z"));

    expect(job.leaseAttributionComplete).toBe(false);
    expect(job.expiresAt).toBe("2026-08-27T01:00:00.000Z");
  });

  it("removes only completion jobs owned by selected connections", async () => {
    const userDataPath = await temporaryDirectory();
    const queue = new TurnCompletionQueueStore(userDataPath);
    await queue.enqueue({
      operationId: "operation-a",
      turnId: "turn-a",
      activityEpoch: 0,
      state: hookState(userDataPath, "connection-a"),
    });
    await queue.enqueue({
      operationId: "operation-b",
      turnId: "turn-b",
      activityEpoch: 0,
      state: hookState(userDataPath, "connection-b"),
    });

    await expect(queue.removeForConnection("connection-a")).resolves.toBe(1);
    await expect(queue.list()).resolves.toEqual([
      expect.objectContaining({ connectionId: "connection-b", operationId: "operation-b" }),
    ]);
  });

  it("isolates one malformed entry while returning jobs for two healthy sessions", async () => {
    const userDataPath = await temporaryDirectory();
    const queue = new TurnCompletionQueueStore(userDataPath);
    await queue.enqueue({
      operationId: "operation-a",
      turnId: "turn-a",
      activityEpoch: 0,
      state: hookState(userDataPath, "connection-a"),
    });
    await queue.enqueue({
      operationId: "operation-b",
      turnId: "turn-b",
      activityEpoch: 0,
      state: hookState(userDataPath, "connection-b"),
    });
    await writeFile(path.join(queue.directory, "broken.json"), "{not-json", "utf8");
    const diagnostics: Array<{ error: Error; filePath: string }> = [];

    const jobs = await queue.list((error, filePath) => diagnostics.push({ error, filePath }));
    expect(jobs.map((job) => [job.codexSessionId, job.operationId]).sort()).toEqual([
      ["codex-connection-a", "operation-a"],
      ["codex-connection-b", "operation-b"],
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.error.message).toContain("broken.json");
    expect(diagnostics[0]!.filePath).toBe(path.join(queue.directory, "broken.json"));
  });
});

function hookState(repositoryPath: string, connectionId: string): CodexHookSessionState {
  return {
    version: 1,
    codexSessionId: `codex-${connectionId}`,
    connectionId,
    hubSessionId: `hub-${connectionId}`,
    repositoryPath,
    branch: "main",
    baseCommit: "0123456789abcdef",
    initialChangedPaths: [],
    initialChangedFingerprints: {},
    observedChangedPaths: [],
    observedChangedFingerprints: {},
    attributedChangedPaths: [],
    attributedPathEvidence: [],
    leases: [{ id: `lease-${connectionId}`, paths: ["src/task.ts"], expiresAt: "2026-08-27T00:05:00.000Z" }],
    openedAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-turn-queue-"));
  temporaryDirectories.push(directory);
  return directory;
}
