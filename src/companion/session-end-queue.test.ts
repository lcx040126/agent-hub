import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    expect(failed!.nextAttemptAt).toBe("2026-08-27T00:00:12.000Z");
    await expect(new SessionEndQueueStore(userDataPath).list()).resolves.toEqual([failed]);
  });

  it("monotonically merges late Hook evidence without resetting retry state", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "agent-hub-session-end-merge-"));
    temporaryDirectories.push(userDataPath);
    const queue = new SessionEndQueueStore(userDataPath);
    const state = sessionState(userDataPath);
    const first = await queue.enqueue(state, "other", new Date("2026-08-27T00:00:00.000Z"));
    const failed = await queue.recordFailure(
      first,
      new Error("room offline"),
      new Date("2026-08-27T00:00:02.000Z"),
    );
    const merged = await queue.mergeState(first.finalizationId, {
      ...state,
      attributedChangedPaths: ["src/value.ts", "src/late.ts"],
      attributedPathsTruncated: true,
      leases: [
        {
          id: "lease-a",
          paths: ["src/value.ts", "src/late.ts"],
          expiresAt: "2026-08-27T02:00:00.000Z",
        },
        {
          id: "lease-b",
          paths: ["src/second.ts"],
          expiresAt: "2026-08-27T01:30:00.000Z",
        },
      ],
      externalChangeDiagnostics: [{
        paths: ["src/external-a.ts", "src/external-b.ts"],
        detectedAt: "2026-08-27T00:00:03.000Z",
      }],
    }, "shutdown", new Date("2026-08-27T00:00:03.000Z"));

    expect(merged).toMatchObject({
      attempts: failed!.attempts,
      nextAttemptAt: failed!.nextAttemptAt,
      lastError: failed!.lastError,
      createdAt: failed!.createdAt,
      reason: "other",
      attributedPaths: ["src/value.ts", "src/late.ts"],
      attributedPathsTruncated: true,
      externalChangeCount: 2,
      leases: [
        {
          id: "lease-a",
          paths: ["src/value.ts", "src/late.ts"],
          expiresAt: "2026-08-27T02:00:00.000Z",
        },
        {
          id: "lease-b",
          paths: ["src/second.ts"],
          expiresAt: "2026-08-27T01:30:00.000Z",
        },
      ],
    });
    await expect(queue.load(first.finalizationId)).resolves.toEqual(merged);
  });

  it("serializes concurrent evidence merges and retry accounting across store instances", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "agent-hub-session-end-concurrent-"));
    temporaryDirectories.push(userDataPath);
    const queue = new SessionEndQueueStore(userDataPath);
    const otherProcessView = new SessionEndQueueStore(userDataPath);
    const state = sessionState(userDataPath);
    const first = await queue.enqueue(state, "other", new Date("2026-08-27T00:00:00.000Z"));
    const lateState: CodexHookSessionState = {
      ...state,
      attributedChangedPaths: ["src/value.ts", "src/late.ts"],
      leases: [{
        id: "lease-a",
        paths: ["src/value.ts", "src/late.ts"],
        expiresAt: "2026-08-27T02:00:00.000Z",
      }],
    };

    await Promise.all([
      queue.mergeState(first.finalizationId, lateState),
      ...Array.from({ length: 5 }, (_, index) => otherProcessView.recordFailure(
        first,
        new Error(`local evidence ${index + 1}`),
        new Date("2026-08-27T00:00:10.000Z"),
        { localEvidenceFailure: true },
      )),
    ]);

    await expect(queue.load(first.finalizationId)).resolves.toMatchObject({
      attempts: 5,
      localEvidenceAttempts: 5,
      attributedPaths: ["src/value.ts", "src/late.ts"],
      leases: [expect.objectContaining({
        id: "lease-a",
        paths: ["src/value.ts", "src/late.ts"],
        expiresAt: "2026-08-27T02:00:00.000Z",
      })],
    });
  });

  it("loads legacy retry files without local evidence counters", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "agent-hub-session-end-legacy-"));
    temporaryDirectories.push(userDataPath);
    const queue = new SessionEndQueueStore(userDataPath);
    const job = await queue.enqueue(sessionState(userDataPath));
    const filePath = path.join(queue.directory, `${job.finalizationId}.json`);
    const legacy = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    delete legacy.localEvidenceAttempts;
    await writeFile(filePath, `${JSON.stringify(legacy)}\n`, "utf8");

    await expect(queue.load(job.finalizationId)).resolves.toMatchObject({
      attempts: 0,
      localEvidenceAttempts: 0,
    });
  });

  it("does not resurrect a removed job from a stale failure snapshot", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "agent-hub-session-end-no-resurrection-"));
    temporaryDirectories.push(userDataPath);
    const queue = new SessionEndQueueStore(userDataPath);
    const job = await queue.enqueue(sessionState(userDataPath));

    await queue.remove(job.finalizationId);
    await expect(queue.recordFailure(
      job,
      new Error("late worker failure"),
      new Date("2026-08-27T00:00:10.000Z"),
      { localEvidenceFailure: true },
    )).resolves.toBeUndefined();
    await expect(queue.list()).resolves.toEqual([]);
  });

  it("isolates one malformed entry while returning healthy finalizations", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "agent-hub-session-end-invalid-"));
    temporaryDirectories.push(userDataPath);
    const queue = new SessionEndQueueStore(userDataPath);
    const job = await queue.enqueue(sessionState(userDataPath));
    const brokenPath = path.join(queue.directory, "broken.json");
    await writeFile(brokenPath, "{not-json", "utf8");
    const diagnostics: Array<{ error: Error; filePath: string }> = [];

    await expect(queue.list((error, filePath) => diagnostics.push({ error, filePath })))
      .resolves.toEqual([job]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.error.message).toContain("broken.json");
    expect(diagnostics[0]!.filePath).toBe(brokenPath);
  });

  it("bounds queue-lock contention so SessionEnd retains its host budget", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "agent-hub-session-end-lock-budget-"));
    temporaryDirectories.push(userDataPath);
    const queue = new SessionEndQueueStore(userDataPath);
    const state = sessionState(userDataPath);
    await mkdir(queue.directory, { recursive: true });
    await writeFile(
      path.join(queue.directory, `${state.finalizationId}.lock`),
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        token: "held-by-live-test-process",
        startedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const startedAt = performance.now();
    const tombstone = await queue.enqueue(state);
    await expect(queue.mergeState(tombstone.finalizationId, state))
      .rejects.toThrow("SessionEnd queue lock");

    expect(performance.now() - startedAt).toBeLessThan(900);
    await expect(queue.load(tombstone.finalizationId)).resolves.toEqual(tombstone);
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
