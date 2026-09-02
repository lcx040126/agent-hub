import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStore } from "../desktop/connection-store.js";
import type { SavedRoomConnection } from "../desktop/contracts.js";
import {
  IntegrationController,
  type ConnectionDeletionCleanupContext,
} from "./integration-controller.js";
import { getLocalIntegrationStatus } from "./integration-gate.js";
import { IntegrationOperationTracker } from "./integration-operations.js";
import { CodexHookStateStore, type CodexHookSessionState } from "./hook-state.js";
import { PAUSE_PREPARATION_FILENAME } from "./pause-preparation.js";
import {
  PAUSE_RETRY_FILENAME,
  PauseRetryQueue,
} from "./pause-retry.js";
import {
  readRuntimePresence,
  RUNTIME_PRESENCE_FILENAME,
  startRuntimePresence,
  type StartRuntimePresenceOptions,
} from "./runtime-presence.js";
import { TurnCompletionQueueStore } from "./turn-completion-queue.js";
import { startTurnCompletionWorker } from "./turn-completion-worker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("integration controller lifecycle", () => {
  it("waits for connection operations before choosing the remote cleanup cutoff", async () => {
    const userDataPath = await temporaryDirectory();
    const store = createStore();
    let releaseDrain: (() => void) | undefined;
    let observedPersistedPreparation = false;
    const drain = vi.fn(async () => {
      const document = JSON.parse(await readFile(
        path.join(userDataPath, PAUSE_PREPARATION_FILENAME),
        "utf8",
      )) as { requests?: unknown[] };
      expect(document.requests).toEqual([
        expect.objectContaining({
          connectionId: "connection-a",
          reason: "leave-room",
        }),
      ]);
      observedPersistedPreparation = true;
      await new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
    });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => pauseJsonResponse(init));
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      operationTracker: { drain },
    });

    const pause = controller.pauseConnection("connection-a");
    await vi.waitFor(() => expect(observedPersistedPreparation).toBe(true));
    expect(drain).toHaveBeenCalledWith("connection-a");
    expect(fetchImpl).not.toHaveBeenCalled();
    releaseDrain?.();
    await expect(pause).resolves.toMatchObject({ queued: false });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not choose a remote cutoff when draining the connection fails", async () => {
    const userDataPath = await temporaryDirectory();
    const store = createStore();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => pauseJsonResponse(init));
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      operationTracker: { drain: vi.fn(async () => { throw new Error("drain timed out"); }) },
    });

    await expect(controller.pauseConnection("connection-a")).resolves.toMatchObject({
      queued: true,
      cleanupError: "drain timed out",
    });
    expect(store.pauseIntegration).toHaveBeenCalledWith("connection-a");
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(controller.pausePreparationQueue.list()).resolves.toMatchObject([
      { connectionId: "connection-a", reason: "leave-room" },
    ]);
  });

  it("finishes this connection's pending cleanup before reactivating it", async () => {
    const userDataPath = await temporaryDirectory();
    const store = createStore();
    const calls: string[] = [];
    let drainCount = 0;
    const drain = vi.fn(async () => {
      drainCount += 1;
      calls.push(`drain:${drainCount}`);
      if (drainCount === 1) throw new Error("still running");
    });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      calls.push("remote:pause");
      return pauseJsonResponse(init);
    });
    store.setRepositoryIntegrationOwner = vi.fn(async () => {
      calls.push("connection:activate");
      return {
        repositoryIdentity: path.resolve("project"),
        owner: (await store.get("connection-a"))!,
        pausedConnectionIds: [],
      };
    });
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      operationTracker: { drain },
    });

    await expect(controller.pauseConnection("connection-a")).resolves.toMatchObject({ queued: true });
    await controller.activateConnection("connection-a");

    expect(calls).toEqual([
      "drain:1",
      "drain:2",
      "remote:pause",
      "connection:activate",
    ]);
    await expect(controller.pausePreparationQueue.list()).resolves.toEqual([]);
  });

  it("returns structured recovery state and activates only after the fixed cleanup succeeds", async () => {
    const userDataPath = await temporaryDirectory();
    const target = connectionRecord("connection-a", false);
    const unrelated = connectionRecord("connection-b", false, path.resolve("other-project"));
    const { store, connections } = createMutableStore([target, unrelated]);
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => pauseJsonResponse(init));
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      now: () => new Date("2026-08-27T00:00:00.000Z"),
      operationTracker: { drain: vi.fn(async () => undefined) },
    });
    await controller.pauseQueue.enqueue({
      connectionId: target.id,
      reason: "leave-room",
      cutoffAt: "2026-08-26T23:59:00.000Z",
      requestId: "fixed-cleanup-a",
    });
    await controller.pauseQueue.defer(
      "fixed-cleanup-a",
      new Error("Agent Hub did not respond within 10000 ms."),
    );
    await controller.pauseQueue.enqueue({
      connectionId: unrelated.id,
      reason: "leave-room",
      cutoffAt: "2026-08-26T23:58:00.000Z",
      requestId: "fixed-cleanup-b",
    });
    await controller.pauseQueue.defer(
      "fixed-cleanup-b",
      new Error("connect ECONNREFUSED 10.0.0.2"),
    );

    await expect(controller.activateExclusiveConnection(target.id)).resolves.toMatchObject({
      status: "waiting-cleanup",
      connection: { id: target.id, integrationEnabled: false },
      recovery: {
        phase: "remote-cleanup",
        attempts: 1,
        failureKind: "timeout",
        retryable: true,
      },
    });
    expect(store.setRepositoryIntegrationOwner).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(controller.retryConnectionCleanup(target.id)).resolves.toMatchObject({
      status: "ready",
      connectionId: target.id,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      requestId: "fixed-cleanup-a",
      cutoffAt: "2026-08-26T23:59:00.000Z",
    });
    await expect(controller.pauseQueue.list()).resolves.toMatchObject([
      { connectionId: unrelated.id, requestId: "fixed-cleanup-b" },
    ]);

    await expect(controller.activateExclusiveConnection(target.id)).resolves.toMatchObject({
      status: "activated",
      connection: { id: target.id, integrationEnabled: true },
    });
    expect(connections.get(unrelated.id)?.integrationEnabled).toBe(false);
  });

  it("serializes an immediate reactivation behind an in-flight pause", async () => {
    const userDataPath = await temporaryDirectory();
    const store = createStore();
    const calls: string[] = [];
    let releaseDrain: (() => void) | undefined;
    const drain = vi.fn(() => new Promise<void>((resolve) => {
      calls.push("drain:start");
      releaseDrain = resolve;
    }));
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      calls.push("remote:pause");
      return pauseJsonResponse(init);
    });
    store.setRepositoryIntegrationOwner = vi.fn(async () => {
      calls.push("connection:activate");
      return {
        repositoryIdentity: path.resolve("project"),
        owner: (await store.get("connection-a"))!,
        pausedConnectionIds: [],
      };
    });
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      operationTracker: { drain },
    });

    const pause = controller.pauseConnection("connection-a");
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    const activate = controller.activateConnection("connection-a");
    await Promise.resolve();
    expect(store.setRepositoryIntegrationOwner).not.toHaveBeenCalled();

    releaseDrain?.();
    await pause;
    await activate;
    expect(calls).toEqual(["drain:start", "remote:pause", "connection:activate"]);
  });

  it("pauses the previous repository owner before activating the selected room", async () => {
    const userDataPath = await temporaryDirectory();
    const target = connectionRecord("connection-a", false);
    const previous = connectionRecord("connection-b", true);
    const { store, connections } = createMutableStore([target, previous]);
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) =>
      pauseJsonResponse(init, "member"));
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      operationTracker: { drain: vi.fn(async () => undefined) },
    });

    await expect(controller.activateExclusiveConnection(target.id)).resolves.toMatchObject({
      connection: { id: target.id, integrationEnabled: true },
      pausedConnectionIds: [previous.id],
      warnings: [],
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(connections.get(target.id)?.integrationEnabled).toBe(true);
    expect(connections.get(previous.id)?.integrationEnabled).toBe(false);
  });

  it("serializes concurrent room activations so one repository owner remains", async () => {
    const userDataPath = await temporaryDirectory();
    const first = connectionRecord("connection-a", false);
    const second = connectionRecord("connection-b", false);
    const { store, connections } = createMutableStore([first, second]);
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) =>
      pauseJsonResponse(init, "member"));
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      operationTracker: { drain: vi.fn(async () => undefined) },
    });

    const activations = await Promise.all([
      controller.activateExclusiveConnection(first.id),
      controller.activateExclusiveConnection(second.id),
    ]);
    const active = [...connections.values()].filter((connection) => connection.integrationEnabled);
    const finalOwner = active[0];

    expect(active).toHaveLength(1);
    expect(new Set(activations.map((activation) => activation.connection.id)))
      .toEqual(new Set([first.id, second.id]));
    expect(activations.flatMap((activation) => activation.pausedConnectionIds))
      .toEqual([finalOwner?.id === first.id ? second.id : first.id]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns the verified remote role and removes local state after deleting a room", async () => {
    const userDataPath = await temporaryDirectory();
    const connection = connectionRecord("connection-a", true);
    const { store, connections } = createMutableStore([connection]);
    const removeConnectionState = vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => ({ changed: true, restartRequired: true }));
    const completionQueue = new TurnCompletionQueueStore(userDataPath);
    await completionQueue.enqueue({
      operationId: "delete-completion",
      turnId: "turn-delete",
      activityEpoch: 0,
      state: {
        version: 1,
        codexSessionId: "codex-delete",
        connectionId: connection.id,
        hubSessionId: "hub-delete",
        repositoryPath: connection.repositoryPath,
        branch: "main",
        baseCommit: "0123456789abcdef",
        initialChangedPaths: [],
        initialChangedFingerprints: {},
        observedChangedPaths: [],
        observedChangedFingerprints: {},
        leases: [{ id: "lease-delete", paths: ["src/task.ts"], expiresAt: "2099-01-01T00:00:00.000Z" }],
        openedAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
    });
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl: vi.fn<typeof fetch>(async (_input, init) => pauseJsonResponse(init, "host")),
      operationTracker: {
        drain: vi.fn(async () => undefined),
        removeConnectionState,
      },
    });

    await expect(controller.deleteConnection(connection.id, cleanup)).resolves.toMatchObject({
      deletedConnectionId: connection.id,
      remoteCleanup: "completed",
      memberRole: "host",
      cleanup: { changed: true, restartRequired: true },
    });

    expect(cleanup).toHaveBeenCalledWith({ connection, isLastConnection: true });
    expect(removeConnectionState).toHaveBeenCalledWith(connection.id);
    expect(connections.has(connection.id)).toBe(false);
    await expect(completionQueue.list()).resolves.toEqual([]);
  });

  it("serializes deletion across repositories so the final connection removes shared hooks", async () => {
    const userDataPath = await temporaryDirectory();
    const first = connectionRecord("connection-a", true, path.resolve("project-a"));
    const second = connectionRecord("connection-b", true, path.resolve("project-b"));
    const { store, connections } = createMutableStore([first, second]);
    let signalFirstCleanupStarted!: () => void;
    let releaseFirstCleanup!: () => void;
    let signalSecondCleanupStarted!: () => void;
    const firstCleanupStarted = new Promise<void>((resolve) => {
      signalFirstCleanupStarted = resolve;
    });
    const firstCleanupRelease = new Promise<void>((resolve) => {
      releaseFirstCleanup = resolve;
    });
    const secondCleanupStarted = new Promise<void>((resolve) => {
      signalSecondCleanupStarted = resolve;
    });
    const cleanupContexts: ConnectionDeletionCleanupContext[] = [];
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl: vi.fn<typeof fetch>(async (_input, init) => pauseJsonResponse(init, "host")),
      operationTracker: { drain: vi.fn(async () => undefined) },
    });

    const firstDeletion = controller.deleteConnection(first.id, async (context) => {
      cleanupContexts.push(context);
      signalFirstCleanupStarted();
      await firstCleanupRelease;
      return { changed: true };
    });
    await firstCleanupStarted;
    const secondDeletion = controller.deleteConnection(second.id, async (context) => {
      cleanupContexts.push(context);
      signalSecondCleanupStarted();
      return { changed: true };
    });

    const secondState = await Promise.race([
      secondCleanupStarted.then(() => "started" as const),
      new Promise<"queued">((resolve) => setTimeout(() => resolve("queued"), 25)),
    ]);
    expect(secondState).toBe("queued");
    releaseFirstCleanup();
    await expect(Promise.all([firstDeletion, secondDeletion])).resolves.toHaveLength(2);

    expect(cleanupContexts).toEqual([
      { connection: expect.objectContaining({ id: first.id }), isLastConnection: false },
      { connection: expect.objectContaining({ id: second.id }), isLastConnection: true },
    ]);
    expect(connections.size).toBe(0);
  });

  it("retains a paused connection when local deletion cleanup fails", async () => {
    const userDataPath = await temporaryDirectory();
    const connection = connectionRecord("connection-a", true);
    const { store, connections } = createMutableStore([connection]);
    const cleanupFailure = new Error("Codex config is malformed");
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl: vi.fn<typeof fetch>(async (_input, init) => pauseJsonResponse(init, "host")),
      operationTracker: { drain: vi.fn(async () => undefined) },
    });

    await expect(controller.deleteConnection(connection.id, async () => {
      throw cleanupFailure;
    })).rejects.toBe(cleanupFailure);

    expect(store.remove).not.toHaveBeenCalled();
    expect(connections.get(connection.id)?.integrationEnabled).toBe(false);
  });

  it("preserves only the connection with an unexpired completion job during desktop shutdown", async () => {
    const userDataPath = await temporaryDirectory();
    const pending = connectionRecord("connection-pending", true, path.resolve("project-pending"));
    const ordinary = connectionRecord("connection-ordinary", true, path.resolve("project-ordinary"));
    const { store } = createMutableStore([pending, ordinary]);
    store.readMemberToken = vi.fn(async (connectionId: string) => `token-${connectionId}`);
    const pendingJob = await enqueuePendingCompletion(userDataPath, pending, {
      operationId: "shutdown-pending",
      expiresAt: "2026-08-27T00:10:00.000Z",
    });
    const ordinaryState = completionState(ordinary, {
      codexSessionId: "codex-ordinary",
      hubSessionId: "hub-ordinary",
      expiresAt: "2026-08-27T00:10:00.000Z",
    });
    const stateStore = new CodexHookStateStore(userDataPath);
    await stateStore.save(ordinaryState);
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => pauseJsonResponse(init));
    const drain = vi.fn(async () => undefined);
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      now: () => new Date("2026-08-27T00:01:00.000Z"),
      startPresence: createPresenceStarter(),
      operationTracker: { drain },
    });
    const preparationEnqueue = vi.spyOn(controller.pausePreparationQueue, "enqueue");
    await controller.start();

    await controller.shutdown();

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization"))
      .toBe(`Bearer token-${ordinary.id}`);
    expect(preparationEnqueue).toHaveBeenCalledOnce();
    expect(preparationEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: ordinary.id,
      reason: "app-shutdown",
    }));
    await expect(new TurnCompletionQueueStore(userDataPath).list()).resolves.toEqual([pendingJob]);
    await expect(stateStore.load(pendingJob.codexSessionId)).resolves.toMatchObject({
      pendingCompletion: { operationId: pendingJob.operationId, phase: "awaiting_commit" },
    });
    await expect(stateStore.load(ordinaryState.codexSessionId)).resolves.toBeUndefined();
    await expect(controller.pausePreparationQueue.list()).resolves.toEqual([]);
    await expect(controller.pauseQueue.list()).resolves.toEqual([]);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it("preserves every active connection when shutdown finds incomplete completion queue evidence", async () => {
    const userDataPath = await temporaryDirectory();
    const connection = connectionRecord("connection-corrupt-completion", true);
    const { store } = createMutableStore([connection]);
    const queue = new TurnCompletionQueueStore(userDataPath);
    await mkdir(queue.directory, { recursive: true });
    const corruptPath = path.join(queue.directory, "corrupt-completion.json");
    await writeFile(corruptPath, "{not valid json", "utf8");
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => pauseJsonResponse(init));
    const onError = vi.fn();
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      onError,
      now: () => new Date("2026-08-27T00:01:00.000Z"),
      startPresence: createPresenceStarter(),
      operationTracker: { drain: vi.fn(async () => undefined) },
    });
    const preparationEnqueue = vi.spyOn(controller.pausePreparationQueue, "enqueue");
    await controller.start();

    await controller.shutdown();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(preparationEnqueue).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("Skipped invalid Agent Hub turn-completion queue entry"),
    }));
    await expect(readFile(corruptPath, "utf8")).resolves.toBe("{not valid json");
  });

  it("lets a restarted desktop worker continue a preserved completion job", async () => {
    const userDataPath = await temporaryDirectory();
    const connection = connectionRecord("connection-restart", true);
    const { store } = createMutableStore([connection]);
    const job = await enqueuePendingCompletion(userDataPath, connection, {
      operationId: "restart-pending",
      expiresAt: "2026-08-27T00:10:00.000Z",
    });
    const firstFetch = vi.fn<typeof fetch>(async (_input, init) => pauseJsonResponse(init));
    const first = new IntegrationController({
      userDataPath,
      store,
      fetchImpl: firstFetch,
      now: () => new Date("2026-08-27T00:01:00.000Z"),
      startPresence: createPresenceStarter(),
      operationTracker: { drain: vi.fn(async () => undefined) },
    });
    await first.start();
    await first.shutdown();

    expect(firstFetch).not.toHaveBeenCalled();
    await expect(new TurnCompletionQueueStore(userDataPath).list()).resolves.toEqual([job]);

    const restarted = new IntegrationController({
      userDataPath,
      store,
      now: () => new Date("2026-08-27T00:01:01.000Z"),
      startPresence: createPresenceStarter(),
      operationTracker: { drain: vi.fn(async () => undefined) },
    });
    await restarted.start();
    const workerFetch = vi.fn(async () => { throw new Error("network offline"); }) as typeof fetch;
    const worker = startTurnCompletionWorker({
      userDataPath,
      store,
      fetchImpl: workerFetch,
      now: () => new Date("2026-08-27T00:01:01.000Z"),
      intervalMs: 60_000,
      operationTracker: { run: async (_connectionId, task) => task() },
    });
    await worker.scanNow();
    await worker.stop();

    expect(workerFetch).toHaveBeenCalledOnce();
    await expect(new TurnCompletionQueueStore(userDataPath).list()).resolves.toMatchObject([{
      operationId: job.operationId,
      attempts: 1,
      lastError: "network offline",
    }]);
    await restarted.stopPresence();
  });

  it.each(["pause", "delete"] as const)(
    "does not leave a completion orphan when %s races with Stop persistence",
    async (action) => {
      const userDataPath = await temporaryDirectory();
      const connection = connectionRecord(`connection-race-${action}`, true);
      const { store } = createMutableStore([connection]);
      const tracker = new IntegrationOperationTracker(userDataPath);
      const drain = vi.fn((connectionId: string) => tracker.drain(connectionId, {
        pollIntervalMs: 1,
        timeoutMs: 5_000,
      }));
      const controller = new IntegrationController({
        userDataPath,
        store,
        fetchImpl: vi.fn<typeof fetch>(async (_input, init) => pauseJsonResponse(init, "host")),
        operationTracker: {
          drain,
          removeConnectionState: (connectionId) => tracker.removeConnectionState(connectionId),
        },
      });
      let releaseStop: (() => void) | undefined;
      const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
      let stopStarted: (() => void) | undefined;
      const stopDidStart = new Promise<void>((resolve) => { stopStarted = resolve; });
      const state = completionState(connection, {
        codexSessionId: `codex-race-${action}`,
        hubSessionId: `hub-race-${action}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      const stopOperation = tracker.run(connection.id, async () => {
        stopStarted?.();
        await stopGate;
        await enqueuePendingCompletion(userDataPath, connection, {
          operationId: `race-${action}`,
          state,
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      });
      await stopDidStart;

      const lifecycle = action === "pause"
        ? controller.pauseConnection(connection.id)
        : controller.deleteConnection(connection.id, async () => ({ changed: false }));
      await vi.waitFor(() => expect(drain).toHaveBeenCalled());
      releaseStop?.();
      await Promise.all([stopOperation, lifecycle]);

      await expect(new TurnCompletionQueueStore(userDataPath).list()).resolves.toEqual([]);
      await expect(new CodexHookStateStore(userDataPath).load(state.codexSessionId))
        .resolves.toBeUndefined();
    },
  );

  it("preserves a connection when shutdown cannot establish a stable completion snapshot", async () => {
    const userDataPath = await temporaryDirectory();
    const store = createStore();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => pauseJsonResponse(init));
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      startPresence: createPresenceStarter(),
      operationTracker: { drain: vi.fn(async () => { throw new Error("drain timed out"); }) },
    });
    await controller.start();

    await expect(controller.shutdown()).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(controller.pausePreparationQueue.list()).resolves.toMatchObject([
      { connectionId: "connection-a", reason: "app-shutdown" },
    ]);
    await expect(readRuntimePresence(path.join(userDataPath, RUNTIME_PRESENCE_FILENAME), {
      isProcessAlive: () => true,
    })).resolves.toMatchObject({ active: false, status: "stopped" });
  });

  it("closes the runtime sentinel before waiting for operations to drain", async () => {
    const userDataPath = await temporaryDirectory();
    const sentinelPath = path.join(userDataPath, RUNTIME_PRESENCE_FILENAME);
    const store = createStore();
    let releaseDrain: (() => void) | undefined;
    const drain = vi.fn(() => new Promise<void>((resolve) => {
      releaseDrain = resolve;
    }));
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl: vi.fn<typeof fetch>(async (_input, init) => pauseJsonResponse(init)),
      startPresence: createPresenceStarter(),
      operationTracker: { drain },
    });
    await controller.start();

    const shutdown = controller.shutdown();
    await vi.waitFor(() => expect(drain).toHaveBeenCalledWith("connection-a"));
    await expect(readRuntimePresence(sentinelPath, {
      isProcessAlive: () => true,
    })).resolves.toMatchObject({ active: false, status: "stopped" });

    releaseDrain?.();
    await shutdown;
  });

  it("cannot reactivate the sentinel when startup and shutdown overlap", async () => {
    const userDataPath = await temporaryDirectory();
    const sentinelPath = path.join(userDataPath, RUNTIME_PRESENCE_FILENAME);
    const store = createStore({ list: vi.fn(async () => []) });
    const baseStarter = createPresenceStarter();
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const startPresence = vi.fn(async (
      filePath: string,
      options: StartRuntimePresenceOptions = {},
    ) => {
      await startGate;
      return baseStarter(filePath, options);
    });
    const controller = new IntegrationController({
      userDataPath,
      store,
      startPresence,
    });

    const starting = controller.start();
    await vi.waitFor(() => expect(startPresence).toHaveBeenCalledOnce());
    const shutdown = controller.shutdown();
    await expect(controller.start()).rejects.toThrow("shutdown is in progress");
    await expect(controller.activateConnection("connection-a")).rejects.toThrow(
      "shutdown is in progress",
    );

    releaseStart?.();
    await starting;
    await shutdown;
    await expect(readRuntimePresence(sentinelPath, {
      isProcessAlive: () => true,
    })).resolves.toMatchObject({ active: false, status: "stopped" });
  });

  it("starts the desktop gate before replaying a persisted drain preparation", async () => {
    const userDataPath = await temporaryDirectory();
    const sentinelPath = path.join(userDataPath, RUNTIME_PRESENCE_FILENAME);
    const store = createStore();
    const now = () => new Date("2026-08-27T00:00:00.000Z");
    const first = new IntegrationController({
      userDataPath,
      store,
      now,
      startPresence: createPresenceStarter(),
      operationTracker: { drain: vi.fn(async () => { throw new Error("still running"); }) },
    });
    await first.start();
    await first.shutdown();

    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      await expect(readRuntimePresence(sentinelPath, {
        now: now(),
        isProcessAlive: () => true,
      })).resolves.toMatchObject({ active: true, status: "active" });
      return pauseJsonResponse(init);
    });
    const second = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      now,
      startPresence: createPresenceStarter(),
      operationTracker: { drain: vi.fn(async () => undefined) },
    });

    await second.start();
    await second.retryPendingPauses();

    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(second.pausePreparationQueue.list()).resolves.toEqual([]);
    await expect(readRuntimePresence(sentinelPath, {
      now: now(),
      isProcessAlive: () => true,
    })).resolves.toMatchObject({ active: true, status: "active" });
    await second.shutdown();
  });

  it("keeps one room remotely gated while replaying its cutoff-safe cleanup", async () => {
    const userDataPath = await temporaryDirectory();
    const sentinelPath = path.join(userDataPath, RUNTIME_PRESENCE_FILENAME);
    const store = createStore();
    const now = () => new Date();
    const startPresence = createPresenceStarter(now);
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      await expect(readRuntimePresence(sentinelPath, {
        now: now(),
        isProcessAlive: () => true,
      })).resolves.toMatchObject({ active: true, status: "active" });
      await expect(getLocalIntegrationStatus(
        userDataPath,
        (await store.get("connection-a"))!,
      )).resolves.toMatchObject({ active: true, remoteAllowed: false, reason: "cleanup-pending" });
      expect(startPresence).toHaveBeenCalledOnce();
      return pauseJsonResponse(init);
    });
    const seedQueue = new PauseRetryQueue({
      filePath: path.join(userDataPath, PAUSE_RETRY_FILENAME),
      store,
      fetchImpl,
      now,
    });
    await seedQueue.enqueue({
      connectionId: "connection-a",
      reason: "app-shutdown",
      cutoffAt: now().toISOString(),
      requestId: "pause-a",
    });

    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      now,
      startPresence,
    });
    await controller.start();
    await controller.retryPendingPauses();

    expect(startPresence).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(controller.pausePreparationQueue.list()).resolves.toEqual([]);
    await expect(controller.pauseQueue.list()).resolves.toEqual([]);
    await expect(readRuntimePresence(sentinelPath, {
      now: now(),
      isProcessAlive: () => true,
    })).resolves.toMatchObject({ active: true, status: "active" });
    await expect(getLocalIntegrationStatus(
      userDataPath,
      (await store.get("connection-a"))!,
    )).resolves.toMatchObject({ active: true, remoteAllowed: true, reason: "active" });
    await controller.shutdown();
  });

  it("restores remote access automatically after queued cleanup succeeds", async () => {
    const userDataPath = await temporaryDirectory();
    const store = createStore();
    let currentTime = new Date();
    const now = () => currentTime;
    let attempts = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return pauseJsonResponse(init);
    });
    const seedQueue = new PauseRetryQueue({
      filePath: path.join(userDataPath, PAUSE_RETRY_FILENAME),
      store,
      fetchImpl,
      now,
    });
    await seedQueue.enqueue({
      connectionId: "connection-a",
      reason: "app-shutdown",
      cutoffAt: now().toISOString(),
      requestId: "pause-recover",
    });

    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      now,
      startPresence: createPresenceStarter(now),
    });
    await controller.start();
    await controller.retryPendingPauses();

    await expect(getLocalIntegrationStatus(
      userDataPath,
      (await store.get("connection-a"))!,
    )).resolves.toMatchObject({ active: true, remoteAllowed: false, reason: "cleanup-pending" });
    currentTime = new Date(currentTime.getTime() + 5_000);
    await controller.retryPendingPauses();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(controller.pauseQueue.list()).resolves.toEqual([]);
    await expect(getLocalIntegrationStatus(
      userDataPath,
      (await store.get("connection-a"))!,
    )).resolves.toMatchObject({ active: true, remoteAllowed: true, reason: "active" });
    await controller.shutdown();
  });

  it("keeps new sessions cutoff-safe while offline cleanup remains queued", async () => {
    const userDataPath = await temporaryDirectory();
    const sentinelPath = path.join(userDataPath, RUNTIME_PRESENCE_FILENAME);
    const store = createStore();
    const now = () => new Date("2026-08-27T00:00:00.000Z");
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const seedQueue = new PauseRetryQueue({
      filePath: path.join(userDataPath, PAUSE_RETRY_FILENAME),
      store,
      fetchImpl,
      now,
    });
    await seedQueue.enqueue({
      connectionId: "connection-a",
      reason: "app-shutdown",
      cutoffAt: now().toISOString(),
      requestId: "pause-offline",
    });

    const startPresence = createPresenceStarter();
    const onError = vi.fn();
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      now,
      onError,
      startPresence,
    });
    await controller.start();

    expect(startPresence).toHaveBeenCalledOnce();
    await controller.retryPendingPauses();
    expect(onError).toHaveBeenCalled();
    await expect(controller.pauseQueue.list()).resolves.toHaveLength(1);
    await expect(readRuntimePresence(sentinelPath, {
      now: now(),
      isProcessAlive: () => true,
    })).resolves.toMatchObject({
      active: true,
      status: "active",
    });
    await controller.shutdown();
  });

  it("can resume after maintenance and start again after shutdown", async () => {
    const userDataPath = await temporaryDirectory();
    const sentinelPath = path.join(userDataPath, RUNTIME_PRESENCE_FILENAME);
    const store = createStore({ list: vi.fn(async () => []) });
    const now = () => new Date("2026-08-27T00:00:00.000Z");
    const startPresence = createPresenceStarter();
    const controller = new IntegrationController({
      userDataPath,
      store,
      now,
      startPresence,
    });

    await controller.start();
    await controller.enterMaintenance();
    await expect(readRuntimePresence(sentinelPath, {
      now: now(),
      isProcessAlive: () => true,
    })).resolves.toMatchObject({ active: false, status: "maintenance" });

    await controller.resumeAfterMaintenance();
    expect(startPresence).toHaveBeenCalledTimes(2);
    await expect(readRuntimePresence(sentinelPath, {
      now: now(),
      isProcessAlive: () => true,
    })).resolves.toMatchObject({ active: true, status: "active" });

    await controller.shutdown();
    await expect(readRuntimePresence(sentinelPath, {
      now: now(),
      isProcessAlive: () => true,
    })).resolves.toMatchObject({ active: false, status: "stopped" });

    await controller.start();
    expect(startPresence).toHaveBeenCalledTimes(3);
    await expect(readRuntimePresence(sentinelPath, {
      now: now(),
      isProcessAlive: () => true,
    })).resolves.toMatchObject({ active: true, status: "active" });
    await controller.shutdown();
  });

  it("retains an authentication cleanup error after disabling the local connection", async () => {
    const userDataPath = await temporaryDirectory();
    const store = createStore();
    const onError = vi.fn();
    const controller = new IntegrationController({
      userDataPath,
      store,
      onError,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        error: "unauthorized",
        message: "The member token is invalid.",
      }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })),
    });

    await expect(controller.pauseConnection("connection-a")).resolves.toMatchObject({
      queued: true,
      cleanupError: "The member token is invalid.",
    });
    expect(store.pauseIntegration).toHaveBeenCalledWith("connection-a");
    await expect(controller.pauseQueue.list()).resolves.toMatchObject([{
      connectionId: "connection-a",
      attempts: 1,
      lastError: "The member token is invalid.",
    }]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "The member token is invalid.",
    }));
  });

  it("keeps startup available when one persisted preparation still cannot drain", async () => {
    const userDataPath = await temporaryDirectory();
    const sentinelPath = path.join(userDataPath, RUNTIME_PRESENCE_FILENAME);
    const store = createStore();
    const now = () => new Date();
    await new IntegrationController({ userDataPath, store }).pausePreparationQueue.enqueue({
      connectionId: "connection-a",
      reason: "app-shutdown",
      requestId: "startup-drain-pending",
    });
    const onError = vi.fn();
    const controller = new IntegrationController({
      userDataPath,
      store,
      now,
      onError,
      startPresence: createPresenceStarter(now),
      operationTracker: { drain: vi.fn(async () => { throw new Error("still running"); }) },
    });

    await expect(controller.start()).resolves.toBeUndefined();
    await controller.retryPendingPauses();

    await expect(readRuntimePresence(sentinelPath, {
      now: now(),
      isProcessAlive: () => true,
    })).resolves.toMatchObject({ active: true, status: "active" });
    await expect(getLocalIntegrationStatus(
      userDataPath,
      (await store.get("connection-a"))!,
    )).resolves.toMatchObject({ active: true, remoteAllowed: false, reason: "cleanup-pending" });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "still running" }));
    await controller.stopPresence();
  });

  it("deduplicates foreground pause and background preparation replay", async () => {
    const userDataPath = await temporaryDirectory();
    const store = createStore();
    let releaseDrain: (() => void) | undefined;
    const drain = vi.fn(() => new Promise<void>((resolve) => {
      releaseDrain = resolve;
    }));
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => pauseJsonResponse(init));
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      startPresence: createPresenceStarter(),
      operationTracker: { drain },
    });
    await controller.start();
    await controller.retryPendingPauses();

    const pause = controller.pauseConnection("connection-a");
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    const replay = controller.retryPendingPauses();
    releaseDrain?.();
    const [result] = await Promise.all([pause, replay]);

    expect(result).toMatchObject({ queued: false });
    expect(drain).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    await expect(controller.pausePreparationQueue.list()).resolves.toEqual([]);
    await controller.stopPresence();
  });

  it("keeps a fixed cutoff when background retry waits for a foreground cleanup whose preparation removal fails", async () => {
    const userDataPath = await temporaryDirectory();
    const store = createStore();
    let currentTime = new Date("2026-08-27T00:00:00.000Z");
    const now = () => currentTime;
    let releaseDrain: (() => void) | undefined;
    const drain = vi.fn(() => new Promise<void>((resolve) => {
      releaseDrain = resolve;
    }));
    const requests: Array<{ requestId: string; cutoffAt: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        requestId: string;
        cutoffAt: string;
      };
      requests.push(request);
      return pauseJsonResponse(init);
    });
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      now,
      startPresence: createPresenceStarter(now),
      operationTracker: { drain },
    });
    await controller.start();
    await controller.retryPendingPauses();
    vi.spyOn(controller.pausePreparationQueue, "remove")
      .mockRejectedValueOnce(new Error("disk full"));

    const foreground = controller.pauseConnection("connection-a");
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    const background = controller.retryPendingPauses();
    await vi.waitFor(() => expect(store.pauseIntegration).toHaveBeenCalledTimes(2));
    await controller.stopPresence();
    releaseDrain?.();
    const [result] = await Promise.all([foreground, background]);

    expect(result).toMatchObject({
      queued: true,
      cleanupError: expect.stringContaining("disk full"),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [preparation] = await controller.pausePreparationQueue.list();
    const [fixedRetry] = await controller.pauseQueue.list();
    expect(preparation?.requestId).toBe(fixedRetry?.requestId);
    expect(fixedRetry).toMatchObject(requests[0]!);

    currentTime = new Date("2026-08-27T01:00:00.000Z");
    const restarted = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      now,
      startPresence: createPresenceStarter(now),
      operationTracker: { drain: vi.fn(async () => undefined) },
    });
    await restarted.start();
    await restarted.retryPendingPauses();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(requests[1]).toEqual(requests[0]);
    await expect(restarted.pausePreparationQueue.list()).resolves.toEqual([]);
    await expect(restarted.pauseQueue.list()).resolves.toEqual([]);
    await restarted.stopPresence();
  });

  it("prefers an existing fixed retry over a duplicate preparation record", async () => {
    const userDataPath = await temporaryDirectory();
    const store = createStore();
    const fixedCutoff = "2026-08-27T00:00:00.000Z";
    const requestId = "fixed-request-a";
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => pauseJsonResponse(init));
    const controller = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      startPresence: createPresenceStarter(),
      operationTracker: { drain: vi.fn(async () => undefined) },
    });
    await controller.pauseQueue.enqueue({
      connectionId: "connection-a",
      reason: "app-shutdown",
      cutoffAt: fixedCutoff,
      requestId,
    });
    await controller.pausePreparationQueue.enqueue({
      connectionId: "connection-a",
      reason: "app-shutdown",
      requestId,
    });
    await controller.start();
    await controller.retryPendingPauses();

    expect(fetchImpl).toHaveBeenCalledOnce();
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { cutoffAt?: string };
    expect(request.cutoffAt).toBe(fixedCutoff);
    await expect(controller.pausePreparationQueue.list()).resolves.toEqual([]);
    await expect(controller.pauseQueue.list()).resolves.toEqual([]);
    await controller.stopPresence();
  });

  it("keeps the original fixed cutoff when preparation removal fails before restart", async () => {
    const userDataPath = await temporaryDirectory();
    const store = createStore();
    let currentTime = new Date("2026-08-27T00:00:00.000Z");
    const now = () => currentTime;
    const requests: Array<{ requestId: string; cutoffAt: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        requestId: string;
        cutoffAt: string;
      };
      requests.push(request);
      return pauseJsonResponse(init);
    });
    const first = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      now,
      operationTracker: { drain: vi.fn(async () => undefined) },
    });
    const preparationRemove = vi.spyOn(first.pausePreparationQueue, "remove")
      .mockRejectedValueOnce(new Error("disk full"));
    const fixedRemove = vi.spyOn(first.pauseQueue, "remove");

    await expect(first.shutdown()).resolves.toBeUndefined();
    expect(preparationRemove).toHaveBeenCalledOnce();
    expect(fixedRemove).not.toHaveBeenCalled();
    const [preparation] = await first.pausePreparationQueue.list();
    const [fixedRetry] = await first.pauseQueue.list();
    expect(preparation?.requestId).toBe(fixedRetry?.requestId);
    expect(fixedRetry).toMatchObject({
      cutoffAt: "2026-08-27T00:00:00.000Z",
      requestId: requests[0]?.requestId,
    });

    currentTime = new Date("2026-08-27T01:00:00.000Z");
    const restarted = new IntegrationController({
      userDataPath,
      store,
      fetchImpl,
      now,
      startPresence: createPresenceStarter(now),
      operationTracker: { drain: vi.fn(async () => undefined) },
    });
    await restarted.start();
    await restarted.retryPendingPauses();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(requests[1]).toEqual(requests[0]);
    await expect(restarted.pausePreparationQueue.list()).resolves.toEqual([]);
    await expect(restarted.pauseQueue.list()).resolves.toEqual([]);
    await restarted.stopPresence();
  });
});

function createStore(overrides: Partial<Pick<ConnectionStore, "list">> = {}): ConnectionStore {
  const connection = {
    id: "connection-a",
    serverUrl: "http://127.0.0.1:4173",
    repositoryPath: path.resolve("project"),
    integrationEnabled: true,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
  const list = overrides.list ?? vi.fn(async () => [connection]);
  return {
    list,
    listActive: list,
    get: vi.fn(async () => connection),
    readMemberToken: vi.fn(async () => "member-token"),
    pauseIntegration: vi.fn(async () => ({ ...connection, integrationEnabled: false })),
    activateIntegration: vi.fn(async () => connection),
    setRepositoryIntegrationOwner: vi.fn(async (_repositoryPath: string, ownerId: string | null) => ({
      repositoryIdentity: connection.repositoryPath,
      owner: ownerId === connection.id ? connection : undefined,
      pausedConnectionIds: ownerId === null ? [connection.id] : [],
    })),
    normalizeRepositoryIntegrationOwners: vi.fn(async () => []),
    remove: vi.fn(async () => connection),
  } as unknown as ConnectionStore;
}

function connectionRecord(
  id: string,
  integrationEnabled: boolean,
  repositoryPath = path.resolve("project"),
): SavedRoomConnection {
  return {
    id,
    serverUrl: "http://127.0.0.1:4173",
    repositoryPath,
    memberRole: "host",
    integrationEnabled,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

function completionState(
  connection: SavedRoomConnection,
  input: {
    codexSessionId: string;
    hubSessionId: string;
    expiresAt: string;
  },
): CodexHookSessionState {
  return {
    version: 1,
    codexSessionId: input.codexSessionId,
    connectionId: connection.id,
    hubSessionId: input.hubSessionId,
    repositoryPath: connection.repositoryPath,
    branch: "main",
    baseCommit: "0123456789abcdef",
    initialChangedPaths: [],
    initialChangedFingerprints: {},
    observedChangedPaths: [],
    observedChangedFingerprints: {},
    activityEpoch: 1,
    currentTurnId: "turn-1",
    leases: [{
      id: `lease-${connection.id}`,
      paths: ["src/task.ts"],
      expiresAt: input.expiresAt,
    }],
    openedAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

async function enqueuePendingCompletion(
  userDataPath: string,
  connection: SavedRoomConnection,
  input: {
    operationId: string;
    expiresAt: string;
    state?: CodexHookSessionState;
  },
) {
  const stateStore = new CodexHookStateStore(userDataPath);
  const state = input.state ?? completionState(connection, {
    codexSessionId: `codex-${connection.id}`,
    hubSessionId: `hub-${connection.id}`,
    expiresAt: input.expiresAt,
  });
  await stateStore.save(state);
  const queue = new TurnCompletionQueueStore(userDataPath);
  const job = await queue.enqueue({
    operationId: input.operationId,
    turnId: state.currentTurnId ?? "turn-1",
    activityEpoch: state.activityEpoch ?? 0,
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
  return job;
}

function createMutableStore(initial: SavedRoomConnection[]): {
  store: ConnectionStore;
  connections: Map<string, SavedRoomConnection>;
} {
  const connections = new Map(initial.map((connection) => [connection.id, { ...connection }]));
  const list = vi.fn(async () => [...connections.values()]);
  const store = {
    list,
    listActive: vi.fn(async () => [...connections.values()]
      .filter((connection) => connection.integrationEnabled !== false)),
    get: vi.fn(async (connectionId: string) => connections.get(connectionId)),
    readMemberToken: vi.fn(async () => "member-token"),
    pauseIntegration: vi.fn(async (connectionId: string) => {
      const current = connections.get(connectionId);
      if (!current) throw new Error("missing connection");
      const paused = { ...current, integrationEnabled: false };
      connections.set(connectionId, paused);
      return paused;
    }),
    setRepositoryIntegrationOwner: vi.fn(async (
      repositoryPath: string,
      ownerConnectionId: string | null,
    ) => {
      const pausedConnectionIds: string[] = [];
      let owner: SavedRoomConnection | undefined;
      for (const [connectionId, current] of connections) {
        if (current.repositoryPath !== repositoryPath) continue;
        const enabled = connectionId === ownerConnectionId;
        if (current.integrationEnabled && !enabled) pausedConnectionIds.push(connectionId);
        const updated = { ...current, integrationEnabled: enabled };
        connections.set(connectionId, updated);
        if (enabled) owner = updated;
      }
      return {
        repositoryIdentity: repositoryPath,
        owner,
        pausedConnectionIds: pausedConnectionIds.sort(),
      };
    }),
    normalizeRepositoryIntegrationOwners: vi.fn(async () => []),
    remove: vi.fn(async (connectionId: string) => {
      const current = connections.get(connectionId);
      connections.delete(connectionId);
      return current;
    }),
  } as unknown as ConnectionStore;
  return { store, connections };
}

function createPresenceStarter(
  now: () => Date = () => new Date("2026-08-27T00:00:00.000Z"),
) {
  let sequence = 0;
  return vi.fn(async (filePath: string, options: StartRuntimePresenceOptions = {}) =>
    startRuntimePresence(filePath, {
      ...options,
      instanceId: `test-instance-${++sequence}`,
      pid: process.pid,
      heartbeatIntervalMs: 0,
      now,
    }));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function pauseJsonResponse(init?: RequestInit, memberRole: "host" | "member" = "member"): Response {
  const request = JSON.parse(String(init?.body)) as {
    requestId?: unknown;
    reason?: unknown;
    cutoffAt?: unknown;
  };
  if (
    typeof request.requestId !== "string"
    || typeof request.reason !== "string"
    || typeof request.cutoffAt !== "string"
  ) {
    throw new Error("Expected a complete member pause request.");
  }
  return jsonResponse({
    requestId: request.requestId,
    roomId: "room-a",
    memberId: "member-a",
    memberRole,
    reason: request.reason,
    cutoffAt: request.cutoffAt,
    appliedAt: "2026-08-27T00:00:00.000Z",
    alreadyApplied: false,
    closedSessionIds: [],
    releasedLeaseIds: [],
    cancelledReleaseRequestIds: [],
    expiredConfirmationIds: [],
    closedSessionCount: 0,
    releasedLeaseCount: 0,
    cancelledReleaseRequestCount: 0,
    expiredConfirmationCount: 0,
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-controller-"));
  temporaryDirectories.push(directory);
  return directory;
}
