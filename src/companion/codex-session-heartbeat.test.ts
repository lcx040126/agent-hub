import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_HUB_PROTOCOL_VERSION,
  AGENT_HUB_SCHEMA_VERSION,
  AGENT_HUB_VERSION,
} from "../shared/version.js";
import { startCodexSessionHeartbeatScheduler } from "./codex-session-heartbeat.js";
import { CodexHookStateStore, type CodexHookSessionState } from "./hook-state.js";
import { IntegrationOperationTracker } from "./integration-operations.js";
import { PausePreparationQueue } from "./pause-preparation.js";
import { TurnCompletionQueueStore } from "./turn-completion-queue.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Codex session heartbeat scheduler", () => {
  it("heartbeats saved Hook sessions with desktop compatibility versions", async () => {
    const userDataPath = await temporaryUserData();
    const state = hookState();
    await new CodexHookStateStore(userDataPath).save(state);
    let requestUrl: string | undefined;
    let requestBody: unknown;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(_url);
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse(200, { session: { id: state.hubSessionId }, renewedLeases: [] });
    }) as typeof fetch;
    const onError = vi.fn();
    const scheduler = startCodexSessionHeartbeatScheduler({
      userDataPath,
      store: connectionLookup(),
      fetchImpl,
      intervalMs: 60_000,
      onError,
    });
    await scheduler.scanNow();
    await scheduler.stop();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestUrl).toContain(`/api/sessions/${state.hubSessionId}/heartbeat`);
    expect(requestBody).toMatchObject({
      clientVersion: AGENT_HUB_VERSION,
      protocolVersion: AGENT_HUB_PROTOCOL_VERSION,
      schemaVersion: AGENT_HUB_SCHEMA_VERSION,
      activityEpoch: 0,
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("persists renewed lease expiries without turning the heartbeat into Hook activity", async () => {
    const userDataPath = await temporaryUserData();
    const stateStore = new CodexHookStateStore(userDataPath);
    const state = hookState();
    state.leases = [{
      id: "lease-1",
      paths: ["src/task.ts"],
      expiresAt: "2026-08-27T00:02:00.000Z",
    }];
    await stateStore.save(state);
    const beforeHeartbeat = (await stateStore.load(state.codexSessionId))!;
    const renewedExpiry = "2026-08-27T00:10:00.000Z";
    const scheduler = startCodexSessionHeartbeatScheduler({
      userDataPath,
      store: connectionLookup(),
      fetchImpl: vi.fn(async () => jsonResponse(200, {
        session: { id: state.hubSessionId },
        renewedLeases: [{ id: "lease-1", expiresAt: renewedExpiry }],
      })) as typeof fetch,
      intervalMs: 60_000,
    });

    await scheduler.scanNow();
    await scheduler.stop();

    const afterHeartbeat = (await stateStore.load(state.codexSessionId))!;
    expect(afterHeartbeat.updatedAt).toBe(beforeHeartbeat.updatedAt);
    expect(afterHeartbeat.leases).toEqual([
      expect.objectContaining({ id: "lease-1", expiresAt: renewedExpiry }),
    ]);
    const completion = await new TurnCompletionQueueStore(userDataPath).enqueue({
      operationId: "completion-renewed-expiry",
      turnId: "turn-1",
      activityEpoch: 0,
      state: afterHeartbeat,
    }, new Date("2026-08-27T00:01:00.000Z"));
    expect(completion.expiresAt).toBe(renewedExpiry);
  });

  it("adopts the canonical managed lease when MCP acquired it before Hook state", async () => {
    const userDataPath = await temporaryUserData();
    const stateStore = new CodexHookStateStore(userDataPath);
    const state = hookState();
    state.leases = [];
    state.leaseAttributionComplete = false;
    await stateStore.save(state);
    const beforeHeartbeat = (await stateStore.load(state.codexSessionId))!;
    const scheduler = startCodexSessionHeartbeatScheduler({
      userDataPath,
      store: connectionLookup(),
      fetchImpl: vi.fn(async () => jsonResponse(200, {
        session: { id: state.hubSessionId },
        renewedLeases: [],
        managedLease: {
          id: "mcp-managed-lease",
          paths: ["src/mcp.ts", "src/hook.ts"],
          expiresAt: "2026-08-27T00:20:00.000Z",
        },
      })) as typeof fetch,
      intervalMs: 60_000,
    });

    await scheduler.scanNow();
    await scheduler.stop();

    await expect(stateStore.load(state.codexSessionId)).resolves.toMatchObject({
      updatedAt: beforeHeartbeat.updatedAt,
      leaseAttributionComplete: true,
      leases: [{
        id: "mcp-managed-lease",
        paths: ["src/mcp.ts", "src/hook.ts"],
        expiresAt: "2026-08-27T00:20:00.000Z",
      }],
    });
  });

  it("does not heartbeat while a write-blocked transition is pending", async () => {
    const userDataPath = await temporaryUserData();
    const state = hookState();
    state.writeBlockSyncPending = {
      dirty: true,
      paths: ["src/task.ts"],
      recordedAt: new Date().toISOString(),
    };
    await new CodexHookStateStore(userDataPath).save(state);
    const store = connectionLookup();
    const fetchImpl = vi.fn<typeof fetch>();
    const scheduler = startCodexSessionHeartbeatScheduler({
      userDataPath,
      store,
      fetchImpl,
      intervalMs: 60_000,
    });

    await scheduler.scanNow();
    await scheduler.stop();

    expect(store.get).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rechecks the write-blocked gate after a stale scan snapshot and before sending", async () => {
    const userDataPath = await temporaryUserData();
    const stateStore = new CodexHookStateStore(userDataPath);
    const state = hookState();
    state.leases = [{
      id: "lease-before-pending",
      paths: ["src/task.ts"],
      expiresAt: "2026-08-28T00:10:00.000Z",
      coordinationState: "working",
    }];
    await stateStore.save(state);
    let markTrackerEntered!: () => void;
    const trackerEntered = new Promise<void>((resolve) => { markTrackerEntered = resolve; });
    let releaseTracker!: () => void;
    const trackerReleased = new Promise<void>((resolve) => { releaseTracker = resolve; });
    const operationTracker = {
      async run<T>(_connectionId: string, operation: () => Promise<T>): Promise<T> {
        markTrackerEntered();
        await trackerReleased;
        return operation();
      },
    };
    const store = connectionLookup();
    const fetchImpl = vi.fn<typeof fetch>();
    const scheduler = startCodexSessionHeartbeatScheduler({
      userDataPath,
      store,
      fetchImpl,
      operationTracker,
      intervalMs: 60_000,
    });
    const scan = scheduler.scanNow();
    await trackerEntered;

    const pending = (await stateStore.load(state.codexSessionId))!;
    pending.writeBlockSyncPending = {
      dirty: true,
      paths: ["src/task.ts"],
      recordedAt: new Date().toISOString(),
    };
    pending.leases = pending.leases.map((lease) => ({
      ...lease,
      coordinationState: "blocked",
    }));
    await stateStore.save(pending);
    releaseTracker();

    await scan;
    await scheduler.stop();

    expect(store.get).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(stateStore.load(state.codexSessionId)).resolves.toMatchObject({
      writeBlockSyncPending: { dirty: true, paths: ["src/task.ts"] },
      leases: [{ id: "lease-before-pending", coordinationState: "blocked" }],
    });
  });

  it("keeps heartbeating a working lease while a passive path fence remains", async () => {
    const userDataPath = await temporaryUserData();
    const state = hookState();
    state.leases = [{
      id: "working-lease",
      paths: ["src/reclaimed.ts"],
      expiresAt: "2026-08-28T00:10:00.000Z",
      coordinationState: "working",
    }];
    state.passiveWriteBlock = {
      leaseId: "older-holder",
      memberName: "Alice",
      paths: ["src/still-held.ts"],
      requestedPaths: ["src/reclaimed.ts", "src/still-held.ts"],
      expiresAt: "2026-08-28T00:05:00.000Z",
    };
    await new CodexHookStateStore(userDataPath).save(state);
    const renewedExpiry = "2026-08-28T00:20:00.000Z";
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      session: { id: state.hubSessionId },
      renewedLeases: [{ id: "working-lease", expiresAt: renewedExpiry }],
    })) as typeof fetch;
    const scheduler = startCodexSessionHeartbeatScheduler({
      userDataPath,
      store: connectionLookup(),
      fetchImpl,
      intervalMs: 60_000,
    });

    await scheduler.scanNow();
    await scheduler.stop();

    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(new CodexHookStateStore(userDataPath).load(state.codexSessionId))
      .resolves.toMatchObject({
        passiveWriteBlock: { leaseId: "older-holder" },
        leases: [{ id: "working-lease", expiresAt: renewedExpiry }],
      });
  });

  it("heartbeats two healthy sessions while isolating one malformed completion entry", async () => {
    const userDataPath = await temporaryUserData();
    const stateStore = new CodexHookStateStore(userDataPath);
    const first = hookState();
    const second = hookState();
    second.codexSessionId = "codex-session-2";
    second.hubSessionId = "hub-session-2";
    await stateStore.save(first);
    await stateStore.save(second);
    const queue = new TurnCompletionQueueStore(userDataPath);
    await mkdir(queue.directory, { recursive: true });
    await writeFile(path.join(queue.directory, "broken.json"), "{not-json", "utf8");
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      session: {},
      renewedLeases: [],
    })) as typeof fetch;
    const scheduler = startCodexSessionHeartbeatScheduler({
      userDataPath,
      store: connectionLookup(),
      fetchImpl,
      intervalMs: 60_000,
      onError,
    });

    await scheduler.scanNow();
    await scheduler.stop();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls.some(([error]) => String(error).includes("broken.json"))).toBe(true);
  });

  it("stops heartbeating but preserves ordinary Hook evidence after real activity becomes stale", async () => {
    const userDataPath = await temporaryUserData();
    const stateStore = new CodexHookStateStore(userDataPath);
    await stateStore.save(hookState());
    const saved = (await stateStore.load("codex-session-1"))!;
    const fetchImpl = vi.fn(async () => jsonResponse(200, {})) as typeof fetch;
    const store = connectionLookup();
    const scheduler = startCodexSessionHeartbeatScheduler({
      userDataPath,
      store,
      fetchImpl,
      now: () => new Date(Date.parse(saved.updatedAt) + 5 * 60_000 + 1),
      intervalMs: 60_000,
    });
    await scheduler.scanNow();
    await scheduler.stop();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    await expect(stateStore.load(saved.codexSessionId)).resolves.toBeDefined();
  });

  it("extends a pending write beyond normal freshness but only stops heartbeats at its hard deadline", async () => {
    const userDataPath = await temporaryUserData();
    const stateStore = new CodexHookStateStore(userDataPath);
    const state = hookState();
    state.pendingWrite = {
      proposalHash: "a".repeat(64),
      toolName: "apply_patch",
      proposedEdits: [{ path: "src/feature.ts", precision: "symbol", symbols: ["feature"], operation: "update" }],
      attributedSideEffects: false,
      baselineChangedPaths: [],
      baselineChangedFingerprints: {},
      recordedAt: new Date().toISOString(),
    };
    await stateStore.save(state);
    const saved = (await stateStore.load(state.codexSessionId))!;
    const fetchImpl = vi.fn(async () => jsonResponse(200, {
      session: { id: saved.hubSessionId },
      renewedLeases: [],
    })) as typeof fetch;

    const pendingScheduler = startCodexSessionHeartbeatScheduler({
      userDataPath,
      store: connectionLookup(),
      fetchImpl,
      now: () => new Date(Date.parse(saved.pendingWrite!.recordedAt) + 30 * 60_000),
      intervalMs: 60_000,
    });
    await pendingScheduler.scanNow();
    await pendingScheduler.stop();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(stateStore.load(saved.codexSessionId)).resolves.toBeDefined();

    const expiredScheduler = startCodexSessionHeartbeatScheduler({
      userDataPath,
      store: connectionLookup(),
      fetchImpl,
      now: () => new Date(Date.parse(saved.pendingWrite!.recordedAt) + 2 * 60 * 60_000 + 1),
      intervalMs: 60_000,
    });
    await expiredScheduler.scanNow();
    await expiredScheduler.stop();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(stateStore.load(saved.codexSessionId)).resolves.toBeDefined();
  });

  it("preserves Hook evidence when a stopped or stale fence returns 409", async () => {
    const userDataPath = await temporaryUserData();
    const state = hookState();
    const stateStore = new CodexHookStateStore(userDataPath);
    await stateStore.save(state);
    const scheduler = startCodexSessionHeartbeatScheduler({
      userDataPath,
      store: connectionLookup(),
      fetchImpl: vi.fn(async () => jsonResponse(409, {
        error: "session_not_active",
        message: "The work session is not active.",
      })) as typeof fetch,
      intervalMs: 60_000,
    });
    await scheduler.scanNow();
    await scheduler.stop();
    await expect(stateStore.load(state.codexSessionId)).resolves.toBeDefined();
  });

  it("does not renew heartbeats while a durable completion job awaits a commit", async () => {
    const userDataPath = await temporaryUserData();
    const state = hookState();
    state.repositoryPath = userDataPath;
    state.leases = [{ id: "lease-1", paths: ["src/task.ts"], expiresAt: "2099-01-01T00:00:00.000Z" }];
    await new CodexHookStateStore(userDataPath).save(state);
    await new TurnCompletionQueueStore(userDataPath).enqueue({
      operationId: "completion-heartbeat",
      turnId: "turn-1",
      activityEpoch: 0,
      state,
    });
    const store = connectionLookup();
    const fetchImpl = vi.fn<typeof fetch>();
    const scheduler = startCodexSessionHeartbeatScheduler({
      userDataPath,
      store,
      fetchImpl,
      intervalMs: 60_000,
    });
    await scheduler.scanNow();
    await scheduler.stop();

    expect(store.get).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(new CodexHookStateStore(userDataPath).load(state.codexSessionId)).resolves.toBeDefined();
  });

  it("does not heartbeat or read credentials while exit cleanup is pending", async () => {
    const userDataPath = await temporaryUserData();
    const state = hookState();
    await new CodexHookStateStore(userDataPath).save(state);
    await new PausePreparationQueue({
      filePath: path.join(userDataPath, "pause-preparation.json"),
    }).enqueue({
      connectionId: state.connectionId,
      reason: "app-shutdown",
      requestId: "pending-heartbeat-cleanup",
    });
    const store = connectionLookup();
    const fetchImpl = vi.fn<typeof fetch>();
    const scheduler = startCodexSessionHeartbeatScheduler({
      userDataPath,
      store,
      fetchImpl,
      intervalMs: 60_000,
    });

    await scheduler.scanNow();
    await scheduler.stop();

    expect(store.get).toHaveBeenCalled();
    expect(store.readMemberToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps an in-flight heartbeat registered until pause can drain it", async () => {
    const userDataPath = await temporaryUserData();
    const state = hookState();
    await new CodexHookStateStore(userDataPath).save(state);
    let releaseHeartbeat: (() => void) | undefined;
    const fetchImpl = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
      return jsonResponse(200, { session: { id: state.hubSessionId }, renewedLeases: [] });
    }) as typeof fetch;
    const scheduler = startCodexSessionHeartbeatScheduler({
      userDataPath,
      store: connectionLookup(),
      fetchImpl,
      intervalMs: 60_000,
    });
    await vi.waitFor(() => expect(releaseHeartbeat).toBeTypeOf("function"));
    let drained = false;
    const drain = new IntegrationOperationTracker(userDataPath)
      .drain(state.connectionId, { pollIntervalMs: 5 })
      .then(() => { drained = true; });
    await vi.waitFor(() => expect(drained).toBe(false));

    releaseHeartbeat?.();
    await scheduler.scanNow();
    await scheduler.stop();
    await drain;

    expect(drained).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

function connectionLookup() {
  return {
    get: vi.fn(async () => ({
      id: "connection-1",
      serverUrl: "http://127.0.0.1:4173",
      repositoryPath: "D:\\UGit\\projectvanguard",
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    })),
    readMemberToken: vi.fn(async () => "member-token"),
  };
}

function hookState(): CodexHookSessionState {
  const now = new Date().toISOString();
  return {
    version: 1,
    codexSessionId: "codex-session-1",
    connectionId: "connection-1",
    hubSessionId: "hub-session-1",
    repositoryPath: "D:\\UGit\\projectvanguard",
    branch: "main",
    baseCommit: "abc1234",
    initialChangedPaths: [],
    initialChangedFingerprints: {},
    observedChangedPaths: [],
    observedChangedFingerprints: {},
    leases: [],
    openedAt: now,
    updatedAt: now,
  };
}

async function temporaryUserData(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-heartbeat-"));
  cleanup.push(directory);
  return directory;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
