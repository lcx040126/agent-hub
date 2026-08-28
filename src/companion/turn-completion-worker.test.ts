import { Readable, Writable } from "node:stream";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodexHook } from "./codex-hook.js";
import { AgentHubClient } from "./hub-client.js";
import { CodexHookStateStore, type CodexHookSessionState } from "./hook-state.js";
import { TurnCompletionQueueStore } from "./turn-completion-queue.js";
import {
  processTurnCompletionJob,
  resumePendingTurnCompletion,
  startTurnCompletionWorker,
} from "./turn-completion-worker.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("Stop hook and turn completion worker", () => {
  it("always emits valid continue JSON and persists the token-free job before remote work", async () => {
    const userDataPath = await temporaryDirectory();
    const stateStore = new CodexHookStateStore(userDataPath);
    const state = hookState(userDataPath);
    await stateStore.save(state);
    const output = outputSink();
    const lastMessage = "do not persist this assistant message";

    await expect(runCodexHook({
      eventName: "Stop",
      userDataPath,
      stdin: Readable.from([JSON.stringify({
        session_id: state.codexSessionId,
        cwd: userDataPath,
        hook_event_name: "Stop",
        turn_id: "turn-7",
        stop_hook_active: false,
        last_assistant_message: lastMessage,
      })]),
      stdout: output.stream,
    })).resolves.toBe(0);

    expect(output.text()).toBe('{"continue":true}\n');
    const [job] = await new TurnCompletionQueueStore(userDataPath).list();
    expect(job).toMatchObject({
      turnId: "turn-7",
      activityEpoch: 2,
      codexSessionId: state.codexSessionId,
      leaseIds: ["lease-1"],
      attributedPaths: ["src/task.ts"],
      baselineEvidence: [{ path: "src/task.ts" }],
    });
    const persisted = await readFile(
      path.join(userDataPath, "turn-completion-queue", `${job!.operationId}.json`),
      "utf8",
    );
    expect(persisted).not.toContain(lastMessage);
    expect(persisted).not.toContain("member-token");
    await expect(stateStore.load(state.codexSessionId)).resolves.toMatchObject({
      pendingCompletion: { phase: "awaiting_commit", operationId: job!.operationId },
    });
  });

  it("returns Stop within the host budget when the conservative job queue lock is busy", async () => {
    const userDataPath = await temporaryDirectory();
    const stateStore = new CodexHookStateStore(userDataPath);
    const state = hookState(userDataPath);
    const queue = new TurnCompletionQueueStore(userDataPath);
    const conservativeState: CodexHookSessionState = {
      ...state,
      attributedPathsTruncated: true,
    };
    const job = await queue.enqueue({
      operationId: "completion-busy-stop-lock",
      turnId: "turn-busy-stop-lock",
      activityEpoch: 2,
      state: conservativeState,
    });
    state.pendingCompletion = {
      operationId: job.operationId,
      turnId: job.turnId,
      activityEpoch: job.activityEpoch,
      phase: "awaiting_commit",
      recordedAt: job.createdAt,
    };
    await stateStore.save(state);
    const entered = deferred();
    const release = deferred();
    const held = queue.runExclusive(job.operationId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const output = outputSink();
    const startedAt = performance.now();
    let exitCode: number;
    try {
      exitCode = await runCodexHook({
        eventName: "Stop",
        userDataPath,
        stdin: Readable.from([JSON.stringify({
          session_id: state.codexSessionId,
          cwd: userDataPath,
          hook_event_name: "Stop",
          turn_id: job.turnId,
          stop_hook_active: false,
        })]),
        stdout: output.stream,
      });
    } finally {
      release.resolve();
      await held;
    }

    expect(exitCode!).toBe(0);
    expect(output.text()).toBe('{"continue":true}\n');
    expect(performance.now() - startedAt).toBeLessThan(2_500);
    await expect(queue.load(job.operationId)).resolves.toMatchObject({
      revision: 1,
      attributedPathsTruncated: true,
    });
  });

  it("returns continue JSON even when Stop input cannot be parsed", async () => {
    const output = outputSink();
    await expect(runCodexHook({
      eventName: "Stop",
      userDataPath: await temporaryDirectory(),
      stdin: Readable.from(["not-json"]),
      stdout: output.stream,
    })).resolves.toBe(0);
    expect(output.text()).toBe('{"continue":true}\n');
  });

  it("retries a persisted job after a network failure without losing it", async () => {
    const userDataPath = await temporaryDirectory();
    const stateStore = new CodexHookStateStore(userDataPath);
    const state = hookState(userDataPath);
    await stateStore.save(state);
    const queue = new TurnCompletionQueueStore(userDataPath);
    const job = await queue.enqueue({
      operationId: "completion-retry",
      turnId: "turn-retry",
      activityEpoch: 2,
      state,
    }, new Date("2026-08-27T00:00:00.000Z"));
    state.pendingCompletion = {
      operationId: job.operationId,
      turnId: job.turnId,
      activityEpoch: job.activityEpoch,
      phase: "awaiting_commit",
      recordedAt: job.createdAt,
    };
    await stateStore.save(state);
    const onError = vi.fn();
    const worker = startTurnCompletionWorker({
      userDataPath,
      store: connectionLookup(),
      fetchImpl: vi.fn(async () => { throw new Error("network offline"); }) as typeof fetch,
      now: () => new Date("2026-08-27T00:00:01.000Z"),
      intervalMs: 60_000,
      operationTracker: { run: async (_connectionId, task) => task() },
      onError,
    });
    await worker.scanNow();
    await worker.stop();

    const [retried] = await queue.list();
    expect(retried).toMatchObject({ operationId: job.operationId, attempts: 1, lastError: "network offline" });
    expect(retried!.nextAttemptAt).toBe("2026-08-27T00:00:16.000Z");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("reloads the job after locking and skips a retry deferred from the listed snapshot", async () => {
    const userDataPath = await temporaryDirectory();
    const state = hookState(userDataPath);
    const queue = new TurnCompletionQueueStore(userDataPath);
    const job = await queue.enqueue({
      operationId: "completion-deferred-after-list",
      turnId: "turn-deferred-after-list",
      activityEpoch: 2,
      state,
    }, new Date("2026-08-27T00:00:00.000Z"));
    let deferred = false;
    const fetchImpl = vi.fn<typeof fetch>();
    const worker = startTurnCompletionWorker({
      userDataPath,
      store: connectionLookup(),
      fetchImpl,
      now: () => new Date("2026-08-27T00:00:01.000Z"),
      intervalMs: 60_000,
      operationTracker: {
        run: async (_connectionId, task) => {
          if (!deferred) {
            deferred = true;
            await queue.recordRetry(
              job,
              null,
              new Date("2026-08-27T00:00:01.000Z"),
              60_000,
            );
          }
          return task();
        },
      },
    });

    await worker.scanNow();
    await worker.stop();

    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(queue.load(job.operationId)).resolves.toMatchObject({
      attempts: 1,
      nextAttemptAt: "2026-08-27T00:01:01.000Z",
    });
  });

  it("does not hold the queue lock across remote work or delete evidence enqueued meanwhile", async () => {
    const userDataPath = await temporaryDirectory();
    const stateStore = new CodexHookStateStore(userDataPath);
    const state = hookState(userDataPath);
    state.leases = [];
    state.attributedChangedPaths = [];
    state.attributedPathEvidence = [];
    const queue = new TurnCompletionQueueStore(userDataPath);
    const job = await queue.enqueue({
      operationId: "completion-evidence-during-request",
      turnId: "turn-evidence-during-request",
      activityEpoch: 2,
      state,
    }, new Date("2026-08-27T00:00:00.000Z"));
    state.pendingCompletion = {
      operationId: job.operationId,
      turnId: job.turnId,
      activityEpoch: job.activityEpoch,
      phase: "awaiting_commit",
      recordedAt: job.createdAt,
    };
    await stateStore.save(state);
    const requestStarted = deferred();
    const releaseResponse = deferred();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      requestStarted.resolve();
      await releaseResponse.promise;
      return jsonResponse(200, { result: "awaiting_commit", awaitingAutomaticLeases: [] });
    });
    const worker = startTurnCompletionWorker({
      userDataPath,
      store: connectionLookup(),
      fetchImpl,
      now: () => new Date("2026-08-27T00:00:01.000Z"),
      intervalMs: 60_000,
      operationTracker: { run: async (_connectionId, task) => task() },
    });
    await requestStarted.promise;
    const latestState: CodexHookSessionState = {
      ...state,
      attributedChangedPaths: ["src/latest.ts"],
      attributedPathEvidence: [{
        path: "src/latest.ts",
        baseEntry: `blob:${"a".repeat(40)}`,
        attributedEntry: `blob:${"b".repeat(40)}`,
      }],
    };

    await expect(queue.enqueue({
      operationId: job.operationId,
      turnId: job.turnId,
      activityEpoch: job.activityEpoch,
      state: latestState,
    }, new Date("2026-08-27T00:00:02.000Z"))).resolves.toMatchObject({ revision: 2 });
    releaseResponse.resolve();
    await worker.scanNow();
    await worker.stop();

    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(queue.load(job.operationId)).resolves.toMatchObject({
      revision: 2,
      attributedPaths: ["src/latest.ts"],
      baselineEvidence: [{ path: "src/latest.ts" }],
    });
  });

  it("retries a non-terminal HTTP 404 instead of deleting the completion", async () => {
    const userDataPath = await temporaryDirectory();
    const state = hookState(userDataPath);
    const queue = new TurnCompletionQueueStore(userDataPath);
    const job = await queue.enqueue({
      operationId: "completion-endpoint-404",
      turnId: "turn-endpoint-404",
      activityEpoch: 2,
      state,
    }, new Date("2026-08-27T00:00:00.000Z"));
    const onError = vi.fn();
    const worker = startTurnCompletionWorker({
      userDataPath,
      store: connectionLookup(),
      fetchImpl: async () => jsonResponse(404, {
        error: "not_found",
        message: "Completion endpoint unavailable.",
      }),
      now: () => new Date("2026-08-27T00:00:01.000Z"),
      intervalMs: 60_000,
      operationTracker: { run: async (_connectionId, task) => task() },
      onError,
    });

    await worker.scanNow();
    await worker.stop();

    await expect(queue.load(job.operationId)).resolves.toMatchObject({
      attempts: 1,
      lastError: "Completion endpoint unavailable.",
    });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("removes a completion only for an explicit terminal session error", async () => {
    const userDataPath = await temporaryDirectory();
    const state = hookState(userDataPath);
    const queue = new TurnCompletionQueueStore(userDataPath);
    await queue.enqueue({
      operationId: "completion-session-missing",
      turnId: "turn-session-missing",
      activityEpoch: 2,
      state,
    }, new Date("2026-08-27T00:00:00.000Z"));
    const worker = startTurnCompletionWorker({
      userDataPath,
      store: connectionLookup(),
      fetchImpl: async () => jsonResponse(404, {
        error: "session_not_found",
        message: "Session not found.",
      }),
      now: () => new Date("2026-08-27T00:00:01.000Z"),
      intervalMs: 60_000,
      operationTracker: { run: async (_connectionId, task) => task() },
    });

    await worker.scanNow();
    await worker.stop();

    await expect(queue.list()).resolves.toEqual([]);
  });

  it("processes an old Hub generation without resuming or clearing the reopened state", async () => {
    const userDataPath = await temporaryDirectory();
    const stateStore = new CodexHookStateStore(userDataPath);
    const oldState = hookState(userDataPath);
    const queue = new TurnCompletionQueueStore(userDataPath);
    const job = await queue.enqueue({
      operationId: "completion-old-generation",
      turnId: "turn-old-generation",
      activityEpoch: 2,
      state: oldState,
    }, new Date("2026-08-27T00:00:00.000Z"));
    const newState: CodexHookSessionState = {
      ...oldState,
      hubSessionId: "hub-session-reopened",
      activityEpoch: 9,
      currentTurnId: "turn-reopened",
      pendingCompletion: {
        operationId: "resume-reopened-generation",
        turnId: "turn-reopened",
        activityEpoch: 9,
        phase: "resuming",
        recordedAt: "2026-08-27T00:00:01.000Z",
      },
    };
    await stateStore.save(newState);
    const requestedPaths: string[] = [];
    const worker = startTurnCompletionWorker({
      userDataPath,
      store: connectionLookup(),
      fetchImpl: vi.fn(async (request) => {
        requestedPaths.push(new URL(request instanceof Request ? request.url : String(request)).pathname);
        throw new Error("old generation remains pending");
      }) as typeof fetch,
      now: () => new Date("2026-08-27T00:00:01.000Z"),
      intervalMs: 60_000,
      operationTracker: { run: async (_connectionId, task) => task() },
    });
    await worker.scanNow();
    await worker.stop();

    expect(requestedPaths).toEqual([`/api/sessions/${job.hubSessionId}/stop`]);
    await expect(stateStore.load(oldState.codexSessionId)).resolves.toMatchObject({
      hubSessionId: newState.hubSessionId,
      currentTurnId: "turn-reopened",
      pendingCompletion: { operationId: "resume-reopened-generation", phase: "resuming" },
    });
    await expect(queue.list()).resolves.toEqual([
      expect.objectContaining({ operationId: job.operationId, attempts: 1 }),
    ]);
  });

  it("does not apply an old resume response to a replacement Hub generation", async () => {
    const userDataPath = await temporaryDirectory();
    const stateStore = new CodexHookStateStore(userDataPath);
    const oldState = hookState(userDataPath);
    oldState.finalizationId = "finalization-old-generation";
    const queue = new TurnCompletionQueueStore(userDataPath);
    const job = await queue.enqueue({
      operationId: "completion-before-resume",
      turnId: "turn-before-resume",
      activityEpoch: 2,
      state: oldState,
    }, new Date("2026-08-27T00:00:00.000Z"));
    oldState.activityEpoch = 3;
    oldState.currentTurnId = "turn-resuming";
    oldState.pendingCompletion = {
      operationId: "resume-shared-token",
      turnId: "turn-resuming",
      activityEpoch: 3,
      phase: "resuming",
      recordedAt: "2026-08-27T00:00:01.000Z",
    };
    await stateStore.save(oldState);
    const replacementState: CodexHookSessionState = {
      ...oldState,
      hubSessionId: "hub-session-replacement",
      finalizationId: "finalization-replacement-generation",
      currentTurnId: "turn-replacement",
      // 故意复用 token，证明锁内必须核对 Hub generation，不能把 operation ID 当成身份。
      pendingCompletion: {
        ...oldState.pendingCompletion,
        turnId: "turn-replacement",
      },
      openedAt: "2026-08-27T00:00:02.000Z",
    };
    const requestedPaths: string[] = [];
    const worker = startTurnCompletionWorker({
      userDataPath,
      store: connectionLookup(),
      fetchImpl: vi.fn(async (request) => {
        requestedPaths.push(new URL(request instanceof Request ? request.url : String(request)).pathname);
        await stateStore.save(replacementState);
        return jsonResponse(200, { result: "resumed" });
      }) as typeof fetch,
      now: () => new Date("2026-08-27T00:00:02.000Z"),
      intervalMs: 60_000,
      operationTracker: { run: async (_connectionId, task) => task() },
    });
    await worker.scanNow();
    await worker.stop();

    expect(requestedPaths).toEqual([`/api/sessions/${oldState.hubSessionId}/resume`]);
    await expect(stateStore.load(oldState.codexSessionId)).resolves.toMatchObject({
      hubSessionId: replacementState.hubSessionId,
      finalizationId: replacementState.finalizationId,
      currentTurnId: "turn-replacement",
      pendingCompletion: {
        operationId: "resume-shared-token",
        turnId: "turn-replacement",
        phase: "resuming",
      },
    });
    await expect(queue.list()).resolves.toEqual([
      expect.objectContaining({ operationId: job.operationId, hubSessionId: oldState.hubSessionId }),
    ]);
  });

  it("processes two healthy jobs even when one persisted queue file is malformed", async () => {
    const userDataPath = await temporaryDirectory();
    const queue = new TurnCompletionQueueStore(userDataPath);
    const stateStore = new CodexHookStateStore(userDataPath);
    const states = ["a", "b"].map((suffix) => {
      const state = hookState(userDataPath);
      state.codexSessionId = `codex-session-${suffix}`;
      state.connectionId = `connection-${suffix}`;
      state.hubSessionId = `hub-session-${suffix}`;
      state.leases = [{
        id: `lease-${suffix}`,
        paths: ["src/task.ts"],
        expiresAt: "2026-08-27T00:05:00.000Z",
      }];
      return state;
    });
    for (const [index, state] of states.entries()) {
      const job = await queue.enqueue({
        operationId: `completion-${index}`,
        turnId: `turn-${index}`,
        activityEpoch: 2,
        state,
      }, new Date("2026-08-27T00:00:00.000Z"));
      state.pendingCompletion = {
        operationId: job.operationId,
        turnId: job.turnId,
        activityEpoch: job.activityEpoch,
        phase: "awaiting_commit",
        recordedAt: job.createdAt,
      };
      await stateStore.save(state);
    }
    await writeFile(path.join(queue.directory, "broken.json"), "{not-json", "utf8");
    const onError = vi.fn();
    const worker = startTurnCompletionWorker({
      userDataPath,
      store: connectionLookup(),
      now: () => new Date("2026-08-27T00:05:00.001Z"),
      intervalMs: 60_000,
      operationTracker: { run: async (_connectionId, task) => task() },
      onError,
    });

    await worker.scanNow();
    await worker.stop();

    await expect(queue.list()).resolves.toEqual([]);
    await expect(stateStore.load("codex-session-a")).resolves.toMatchObject({
      pendingCompletion: { phase: "stopped" },
    });
    await expect(stateStore.load("codex-session-b")).resolves.toMatchObject({
      pendingCompletion: { phase: "stopped" },
    });
    expect(onError.mock.calls.some(([error]) => String(error).includes("broken.json"))).toBe(true);
  });

  it("resumes and increments the epoch after a completed job was already removed", async () => {
    const userDataPath = await temporaryDirectory();
    const stateStore = new CodexHookStateStore(userDataPath);
    const state = hookState(userDataPath);
    state.pendingCompletion = {
      operationId: "completed-operation",
      turnId: "turn-2",
      activityEpoch: 2,
      phase: "stopped",
      recordedAt: "2026-08-27T00:00:00.000Z",
    };
    await stateStore.save(state);
    const saved = (await stateStore.load(state.codexSessionId))!;
    const requests: Array<Record<string, unknown>> = [];
    const client = new AgentHubClient({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token",
      fetchImpl: vi.fn(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse(200, { result: "resumed", session: {} });
      }) as typeof fetch,
    });

    await resumePendingTurnCompletion({
      userDataPath,
      state: saved,
      stateStore,
      client,
      turnId: "turn-3",
    });

    expect(requests).toEqual([expect.objectContaining({ turnId: "turn-3", activityEpoch: 3 })]);
    await expect(stateStore.load(state.codexSessionId)).resolves.toMatchObject({
      activityEpoch: 3,
      currentTurnId: "turn-3",
    });
    expect((await stateStore.load(state.codexSessionId))!.pendingCompletion).toBeUndefined();
  });

  it("synchronizes a superseded resume only when the server proves the same turn is active", async () => {
    const userDataPath = await temporaryDirectory();
    const stateStore = new CodexHookStateStore(userDataPath);
    const state = hookState(userDataPath);
    state.pendingCompletion = {
      operationId: "completed-operation",
      turnId: "turn-2",
      activityEpoch: 2,
      phase: "stopped",
      recordedAt: "2026-08-27T00:00:00.000Z",
    };
    await stateStore.save(state);
    const saved = (await stateStore.load(state.codexSessionId))!;
    const client = new AgentHubClient({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token",
      fetchImpl: vi.fn(async () => jsonResponse(200, {
        result: "superseded",
        session: {
          status: "active",
          currentTurnId: "turn-3",
          activityEpoch: 7,
          turnStoppedAt: null,
        },
      })) as typeof fetch,
    });

    await resumePendingTurnCompletion({
      userDataPath,
      state: saved,
      stateStore,
      client,
      turnId: "turn-3",
    });

    await expect(stateStore.load(state.codexSessionId)).resolves.toMatchObject({
      activityEpoch: 7,
      currentTurnId: "turn-3",
    });
    expect((await stateStore.load(state.codexSessionId))!.pendingCompletion).toBeUndefined();
  });

  it("preserves the resuming fence when a superseded response cannot prove the target turn", async () => {
    const userDataPath = await temporaryDirectory();
    const stateStore = new CodexHookStateStore(userDataPath);
    const state = hookState(userDataPath);
    state.pendingCompletion = {
      operationId: "completed-operation",
      turnId: "turn-2",
      activityEpoch: 2,
      phase: "stopped",
      recordedAt: "2026-08-27T00:00:00.000Z",
    };
    await stateStore.save(state);
    const saved = (await stateStore.load(state.codexSessionId))!;
    const client = new AgentHubClient({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token",
      fetchImpl: vi.fn(async () => jsonResponse(200, {
        result: "superseded",
        session: {
          status: "active",
          currentTurnId: "different-turn",
          activityEpoch: 7,
          turnStoppedAt: null,
        },
      })) as typeof fetch,
    });

    await expect(resumePendingTurnCompletion({
      userDataPath,
      state: saved,
      stateStore,
      client,
      turnId: "turn-3",
    })).rejects.toThrow("write remains blocked");

    await expect(stateStore.load(state.codexSessionId)).resolves.toMatchObject({
      activityEpoch: 3,
      pendingCompletion: {
        turnId: "turn-3",
        activityEpoch: 3,
        phase: "resuming",
      },
    });
  });

  it("rejects an already-applied response that omits proof of the resumed result", async () => {
    const userDataPath = await temporaryDirectory();
    const stateStore = new CodexHookStateStore(userDataPath);
    const state = hookState(userDataPath);
    state.pendingCompletion = {
      operationId: "completed-operation",
      turnId: "turn-2",
      activityEpoch: 2,
      phase: "stopped",
      recordedAt: "2026-08-27T00:00:00.000Z",
    };
    await stateStore.save(state);
    const client = new AgentHubClient({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token",
      fetchImpl: vi.fn(async () => jsonResponse(200, { result: "already_applied", session: {} })) as typeof fetch,
    });

    await expect(resumePendingTurnCompletion({
      userDataPath,
      state: (await stateStore.load(state.codexSessionId))!,
      stateStore,
      client,
      turnId: "turn-3",
    })).rejects.toThrow("without a confirmed resumed result");

    await expect(stateStore.load(state.codexSessionId)).resolves.toMatchObject({
      activityEpoch: 3,
      pendingCompletion: { turnId: "turn-3", activityEpoch: 3, phase: "resuming" },
    });
  });

  it("retries the same durable resume operation after a lost response", async () => {
    const userDataPath = await temporaryDirectory();
    const stateStore = new CodexHookStateStore(userDataPath);
    const state = hookState(userDataPath);
    state.pendingCompletion = {
      operationId: "completed-operation",
      turnId: "turn-2",
      activityEpoch: 2,
      phase: "stopped",
      recordedAt: "2026-08-27T00:00:00.000Z",
    };
    await stateStore.save(state);
    const firstRequests: Array<Record<string, unknown>> = [];
    const lostResponseClient = new AgentHubClient({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token",
      fetchImpl: vi.fn(async (_url, init) => {
        firstRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        throw new Error("response lost");
      }) as typeof fetch,
    });

    await expect(resumePendingTurnCompletion({
      userDataPath,
      state: (await stateStore.load(state.codexSessionId))!,
      stateStore,
      client: lostResponseClient,
      turnId: "turn-3",
    })).rejects.toThrow("response lost");
    const afterLoss = (await stateStore.load(state.codexSessionId))!;
    expect(afterLoss.pendingCompletion).toMatchObject({ phase: "resuming", activityEpoch: 3 });

    const replayRequests: Array<Record<string, unknown>> = [];
    const replayClient = new AgentHubClient({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token",
      fetchImpl: vi.fn(async (_url, init) => {
        replayRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse(200, { result: "already_applied", previousResult: "resumed", session: {} });
      }) as typeof fetch,
    });
    await resumePendingTurnCompletion({
      userDataPath,
      state: afterLoss,
      stateStore,
      client: replayClient,
      turnId: "turn-3",
    });

    expect(replayRequests[0]!.operationId).toBe(firstRequests[0]!.operationId);
    expect((await stateStore.load(state.codexSessionId))!.pendingCompletion).toBeUndefined();
  });

  it("preserves server automatic leases that are missing from recovered local state", async () => {
    const repositoryPath = await createRepository();
    const branch = (await git(repositoryPath, ["branch", "--show-current"])).trim();
    const baseCommit = (await git(repositoryPath, ["rev-parse", "HEAD"])).trim();
    const state = hookState(repositoryPath);
    state.branch = branch;
    state.baseCommit = baseCommit;
    state.leases = [];
    state.leaseAttributionComplete = false;
    state.attributedChangedPaths = [];
    state.attributedPathEvidence = [];
    const job = await new TurnCompletionQueueStore(repositoryPath).enqueue({
      operationId: "completion-empty-leases",
      turnId: "turn-empty-leases",
      activityEpoch: 2,
      state,
    }, new Date("2026-08-27T00:00:00.000Z"));
    const requests: Array<Record<string, unknown>> = [];
    const client = new AgentHubClient({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token",
      fetchImpl: vi.fn(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse(200, {
          result: "awaiting_commit",
          awaitingAutomaticLeases: [{
            id: "server-automatic-lease",
            expiresAt: "2026-08-27T00:30:00.000Z",
          }],
        });
      }) as typeof fetch,
    });

    await expect(processTurnCompletionJob(job, { userDataPath: repositoryPath, client }))
      .resolves.toEqual({ error: expect.objectContaining({
        message: expect.stringContaining("does not account for every active automatic lease"),
      }) });

    expect(requests).toHaveLength(1);
    expect(job.expiresAt).toBe("2026-08-27T00:30:00.000Z");
  }, 10_000);

  it("preserves protection when Stop omits its automatic lease manifest", async () => {
    const repositoryPath = await createRepository();
    const state = hookState(repositoryPath);
    const job = await new TurnCompletionQueueStore(repositoryPath).enqueue({
      operationId: "completion-missing-manifest",
      turnId: "turn-missing-manifest",
      activityEpoch: 2,
      state,
    }, new Date("2026-08-27T00:00:00.000Z"));
    const requests: Array<Record<string, unknown>> = [];
    const client = new AgentHubClient({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token",
      fetchImpl: vi.fn(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse(200, { result: "awaiting_commit" });
      }) as typeof fetch,
    });

    await expect(processTurnCompletionJob(job, { userDataPath: repositoryPath, client }))
      .resolves.toEqual({ error: expect.objectContaining({
        message: expect.stringContaining("evidence is unavailable"),
      }) });
    expect(requests).toHaveLength(1);
  }, 10_000);

  it("preserves protection when Stop returns a malformed automatic lease manifest", async () => {
    const repositoryPath = await createRepository();
    const state = hookState(repositoryPath);
    const job = await new TurnCompletionQueueStore(repositoryPath).enqueue({
      operationId: "completion-malformed-manifest",
      turnId: "turn-malformed-manifest",
      activityEpoch: 2,
      state,
    }, new Date("2026-08-27T00:00:00.000Z"));
    const requests: Array<Record<string, unknown>> = [];
    const client = new AgentHubClient({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token",
      fetchImpl: vi.fn(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse(200, {
          result: "awaiting_commit",
          awaitingAutomaticLeases: [{ id: "lease-1", expiresAt: "not-a-date" }],
        });
      }) as typeof fetch,
    });

    await expect(processTurnCompletionJob(job, { userDataPath: repositoryPath, client }))
      .resolves.toEqual({ error: expect.objectContaining({
        message: expect.stringContaining("incomplete automatic lease evidence"),
      }) });
    expect(requests).toHaveLength(1);
  }, 10_000);

  it("finishes a trustworthy empty task when both lease manifests are empty", async () => {
    const repositoryPath = await createRepository();
    const stateStore = new CodexHookStateStore(repositoryPath);
    const state = hookState(repositoryPath);
    state.leases = [];
    state.leaseAttributionComplete = true;
    state.attributedChangedPaths = [];
    state.attributedPathEvidence = [];
    const job = await new TurnCompletionQueueStore(repositoryPath).enqueue({
      operationId: "completion-empty-task",
      turnId: "turn-empty-task",
      activityEpoch: 2,
      state,
    }, new Date("2026-08-27T00:00:00.000Z"));
    state.pendingCompletion = {
      operationId: job.operationId,
      turnId: job.turnId,
      activityEpoch: job.activityEpoch,
      phase: "awaiting_commit",
      recordedAt: job.createdAt,
    };
    await stateStore.save(state);
    const requests: Array<Record<string, unknown>> = [];
    const client = new AgentHubClient({
      serverUrl: "http://127.0.0.1:4173",
      memberToken: "member-token",
      fetchImpl: vi.fn(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse(200, { result: "awaiting_commit", awaitingAutomaticLeases: [] });
      }) as typeof fetch,
    });

    await expect(processTurnCompletionJob(job, { userDataPath: repositoryPath, client }))
      .resolves.toBeNull();
    expect(requests).toHaveLength(1);
    await expect(stateStore.load(state.codexSessionId)).resolves.toMatchObject({
      pendingCompletion: { phase: "stopped", operationId: job.operationId },
    });
  }, 10_000);
});

function hookState(repositoryPath: string): CodexHookSessionState {
  return {
    version: 1,
    codexSessionId: "codex-session-1",
    connectionId: "connection-1",
    hubSessionId: "hub-session-1",
    repositoryPath,
    branch: "main",
    baseCommit: "0123456789abcdef",
    initialChangedPaths: [],
    initialChangedFingerprints: {},
    observedChangedPaths: ["src/task.ts"],
    observedChangedFingerprints: { "src/task.ts": "fingerprint" },
    attributedChangedPaths: ["src/task.ts"],
    attributedPathEvidence: [{
      path: "src/task.ts",
      baseEntry: `blob:${"a".repeat(40)}`,
      attributedEntry: `blob:${"b".repeat(40)}`,
    }],
    activityEpoch: 2,
    currentTurnId: "turn-2",
    leases: [{ id: "lease-1", paths: ["src/task.ts"], expiresAt: "2026-08-27T00:10:00.000Z" }],
    openedAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

function outputSink(): { stream: Writable; text(): string } {
  let value = "";
  return {
    stream: new Writable({ write(chunk, _encoding, callback) { value += String(chunk); callback(); } }),
    text: () => value,
  };
}

function connectionLookup() {
  return {
    get: vi.fn(async () => ({
      id: "connection-1",
      serverUrl: "http://127.0.0.1:4173",
      repositoryPath: "C:\\repository",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    })),
    readMemberToken: vi.fn(async () => "member-token"),
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-turn-worker-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createRepository(): Promise<string> {
  const repository = await temporaryDirectory();
  await git(repository, ["init"]);
  await git(repository, ["config", "user.email", "agent-hub@example.test"]);
  await git(repository, ["config", "user.name", "Agent Hub Test"]);
  await git(repository, ["commit", "--allow-empty", "-m", "initial"]);
  return repository;
}

async function git(repository: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repository,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
