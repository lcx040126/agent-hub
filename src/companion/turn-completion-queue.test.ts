import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("merges concurrent enqueue evidence with the latest retry count", async () => {
    const userDataPath = await temporaryDirectory();
    const queue = new TurnCompletionQueueStore(userDataPath);
    const state = hookState(userDataPath, "connection-race");
    const job = await queue.enqueue({
      operationId: "operation-race",
      turnId: "turn-race",
      activityEpoch: 2,
      state,
    }, new Date("2026-08-27T00:00:00.000Z"));
    const latestState = hookState(userDataPath, "connection-race");
    latestState.attributedChangedPaths = ["src/latest.ts"];
    latestState.attributedPathEvidence = [{
      path: "src/latest.ts",
      baseEntry: `blob:${"a".repeat(40)}`,
      attributedEntry: `blob:${"b".repeat(40)}`,
    }];
    const entered = deferred();
    const release = deferred();
    const held = queue.runExclusive(job.operationId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    const retrying = queue.recordRetry(
      job,
      new Error("retry after old evidence"),
      new Date("2026-08-27T00:00:01.000Z"),
    );
    const enqueuing = queue.enqueue({
      operationId: job.operationId,
      turnId: job.turnId,
      activityEpoch: job.activityEpoch,
      state: latestState,
    }, new Date("2026-08-27T00:00:02.000Z"));
    release.resolve();
    await held;
    await Promise.all([retrying, enqueuing]);

    await expect(queue.load(job.operationId)).resolves.toMatchObject({
      revision: 3,
      attempts: 1,
      attributedPaths: ["src/latest.ts"],
      baselineEvidence: [{ path: "src/latest.ts" }],
      lastError: "retry after old evidence",
    });

    // A Hook snapshot can be captured before a newer PostToolUse update but
    // reach the queue afterwards.  The late snapshot must not erase newer
    // evidence, even when its enqueue timestamp is later.
    const staleSnapshot = hookState(userDataPath, "connection-reverse");
    staleSnapshot.updatedAt = "2026-08-27T00:01:00.000Z";
    staleSnapshot.leases = [{
      id: "lease-reverse-old",
      paths: ["src/old.ts"],
      expiresAt: "2026-08-27T00:10:00.000Z",
    }];
    staleSnapshot.attributedChangedPaths = ["src/shared.ts", "src/old.ts"];
    staleSnapshot.attributedPathEvidence = [
      {
        path: "src/shared.ts",
        baseEntry: `blob:${"1".repeat(40)}`,
        attributedEntry: `blob:${"2".repeat(40)}`,
      },
      {
        path: "src/old.ts",
        baseEntry: `blob:${"3".repeat(40)}`,
        attributedEntry: `blob:${"4".repeat(40)}`,
      },
    ];
    const newerSnapshot = {
      ...staleSnapshot,
      updatedAt: "2026-08-27T00:02:00.000Z",
      leases: [{
        id: "lease-reverse-new",
        paths: ["src/new.ts"],
        expiresAt: "2026-08-27T00:20:00.000Z",
      }],
      attributedChangedPaths: ["src/shared.ts", "src/new.ts"],
      attributedPathEvidence: [
        {
          path: "src/shared.ts",
          baseEntry: `blob:${"5".repeat(40)}`,
          attributedEntry: `blob:${"6".repeat(40)}`,
        },
        {
          path: "src/new.ts",
          baseEntry: `blob:${"7".repeat(40)}`,
          attributedEntry: `blob:${"8".repeat(40)}`,
        },
      ],
    };
    const newer = await queue.enqueue({
      operationId: "operation-reverse-order",
      turnId: "turn-reverse-order",
      activityEpoch: 2,
      state: newerSnapshot,
    }, new Date("2026-08-27T00:02:00.000Z"));
    const late = await queue.enqueue({
      operationId: "operation-reverse-order",
      turnId: "turn-reverse-order",
      activityEpoch: 2,
      state: staleSnapshot,
    }, new Date("2026-08-27T00:03:00.000Z"));

    expect(late).toMatchObject({
      revision: 2,
      leaseIds: ["lease-reverse-new", "lease-reverse-old"],
      attributedPaths: ["src/shared.ts", "src/new.ts", "src/old.ts"],
      snapshotUpdatedAt: newer.snapshotUpdatedAt,
      attributionComplete: true,
    });
    expect(late.baselineEvidence).toEqual(expect.arrayContaining([
      {
        path: "src/shared.ts",
        baseEntry: `blob:${"5".repeat(40)}`,
        attributedEntry: `blob:${"6".repeat(40)}`,
      },
      expect.objectContaining({ path: "src/new.ts" }),
      expect.objectContaining({ path: "src/old.ts" }),
    ]));
  });

  it("keeps nested queue mutations reentrant inside an operation lock", async () => {
    const userDataPath = await temporaryDirectory();
    const queue = new TurnCompletionQueueStore(userDataPath);
    const job = await queue.enqueue({
      operationId: "operation-reentrant",
      turnId: "turn-reentrant",
      activityEpoch: 1,
      state: hookState(userDataPath, "connection-reentrant"),
    }, new Date("2026-08-27T00:00:00.000Z"));

    const retried = await queue.runExclusive(job.operationId, () =>
      queue.recordRetry(job, null, new Date("2026-08-27T00:00:01.000Z")));

    expect(retried).toMatchObject({ revision: 2, attempts: 1 });
  });

  it("does not reclaim an old lock while its owner PID is alive", async () => {
    const userDataPath = await temporaryDirectory();
    const queue = new TurnCompletionQueueStore(userDataPath);
    await queue.enqueue({
      operationId: "operation-live-lock",
      turnId: "turn-live-lock",
      activityEpoch: 1,
      state: hookState(userDataPath, "connection-live-lock"),
    });
    const lockPath = path.join(queue.directory, "operation-live-lock.lock");
    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      pid: process.pid,
      token: "live-owner-token",
      startedAt: "2020-01-01T00:00:00.000Z",
    })}\n`, "utf8");
    const old = new Date("2020-01-01T00:00:00.000Z");
    await utimes(lockPath, old, old);
    const task = vi.fn(async () => "acquired");

    await expect(queue.runExclusive("operation-live-lock", task)).resolves.toBeUndefined();
    expect(task).not.toHaveBeenCalled();
    await expect(readFile(lockPath, "utf8")).resolves.toContain("live-owner-token");
  });

  it("does not let an old owner release a successor token", async () => {
    const userDataPath = await temporaryDirectory();
    const queue = new TurnCompletionQueueStore(userDataPath);
    await queue.enqueue({
      operationId: "operation-successor-lock",
      turnId: "turn-successor-lock",
      activityEpoch: 1,
      state: hookState(userDataPath, "connection-successor-lock"),
    });
    const lockPath = path.join(queue.directory, "operation-successor-lock.lock");

    await queue.runExclusive("operation-successor-lock", async () => {
      await writeFile(lockPath, `${JSON.stringify({
        version: 1,
        pid: process.pid,
        token: "successor-owner-token",
        startedAt: new Date().toISOString(),
      })}\n`, "utf8");
    });

    await expect(readFile(lockPath, "utf8")).resolves.toContain("successor-owner-token");
  });

  it("loads legacy jobs without a revision and advances them on the next write", async () => {
    const userDataPath = await temporaryDirectory();
    const queue = new TurnCompletionQueueStore(userDataPath);
    const job = await queue.enqueue({
      operationId: "operation-legacy-revision",
      turnId: "turn-legacy-revision",
      activityEpoch: 1,
      state: hookState(userDataPath, "connection-legacy-revision"),
    }, new Date("2026-08-27T00:00:00.000Z"));
    const filePath = path.join(queue.directory, `${job.operationId}.json`);
    const legacy = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    delete legacy.revision;
    await writeFile(filePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const loaded = await queue.load(job.operationId);
    expect(loaded?.revision).toBe(0);
    await expect(queue.recordRetry(
      loaded!,
      null,
      new Date("2026-08-27T00:00:01.000Z"),
    )).resolves.toMatchObject({ revision: 1, attempts: 1 });
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

  it("keeps completion jobs isolated between Hub generations of one Codex task", async () => {
    const userDataPath = await temporaryDirectory();
    const queue = new TurnCompletionQueueStore(userDataPath);
    const oldState = hookState(userDataPath, "connection-shared");
    oldState.codexSessionId = "codex-shared";
    oldState.hubSessionId = "hub-old";
    const newState = { ...oldState, hubSessionId: "hub-new" };
    await queue.enqueue({
      operationId: "operation-old-generation",
      turnId: "turn-old",
      activityEpoch: 0,
      state: oldState,
    });
    await queue.enqueue({
      operationId: "operation-new-generation",
      turnId: "turn-new",
      activityEpoch: 1,
      state: newState,
    });

    await expect(queue.listForLifecycle(newState)).resolves.toEqual([
      expect.objectContaining({ operationId: "operation-new-generation", hubSessionId: "hub-new" }),
    ]);
    await expect(queue.removeForLifecycle(newState, 2)).resolves.toBe(1);
    await expect(queue.list()).resolves.toEqual([
      expect.objectContaining({ operationId: "operation-old-generation", hubSessionId: "hub-old" }),
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

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
