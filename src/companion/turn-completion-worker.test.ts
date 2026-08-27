import { Readable, Writable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCodexHook } from "./codex-hook.js";
import { AgentHubClient } from "./hub-client.js";
import { CodexHookStateStore, type CodexHookSessionState } from "./hook-state.js";
import { TurnCompletionQueueStore } from "./turn-completion-queue.js";
import {
  resumePendingTurnCompletion,
  startTurnCompletionWorker,
} from "./turn-completion-worker.js";

const temporaryDirectories: string[] = [];

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
