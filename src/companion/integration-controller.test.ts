import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStore } from "../desktop/connection-store.js";
import {
  IntegrationController,
} from "./integration-controller.js";
import { getLocalIntegrationStatus } from "./integration-gate.js";
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
    store.activateIntegration = vi.fn(async () => {
      calls.push("connection:activate");
      return (await store.get("connection-a"))!;
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
    store.activateIntegration = vi.fn(async () => {
      calls.push("connection:activate");
      return (await store.get("connection-a"))!;
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
    expect(store.activateIntegration).not.toHaveBeenCalled();

    releaseDrain?.();
    await pause;
    await activate;
    expect(calls).toEqual(["drain:start", "remote:pause", "connection:activate"]);
  });

  it("persists a shutdown drain failure without sending an unsafe cutoff", async () => {
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
  } as unknown as ConnectionStore;
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
