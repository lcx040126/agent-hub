import { describe, expect, it, vi } from "vitest";
import type { SavedRoomConnection } from "./contracts.js";
import {
  activateDesktopRoomConnection,
  deleteDesktopRoomConnection,
  enterDesktopMaintenance,
  pauseDesktopRoomConnection,
  recoverDesktopMaintenance,
  saveAndActivateDesktopRoomConnection,
  shouldStartLocalRoomService,
  shutdownDesktopIntegration,
} from "./integration-lifecycle.js";

describe("desktop integration lifecycle", () => {
  it("uses the pause transaction's host role before stopping the local room service", async () => {
    const calls: string[] = [];
    let connection = { ...savedConnection(true), memberRole: "member" as const };
    const pauseConnection = vi.fn(async (_id: string, reason: string) => {
      calls.push(`pause:${reason}`);
      connection = { ...connection, integrationEnabled: false };
      return {
        queued: false,
        requestId: "pause-host",
        response: pauseResponse("host", "pause-host"),
      };
    });
    const stop = vi.fn(async () => { calls.push("server:stop"); });
    const store = lifecycleStore(() => connection, (paused) => { connection = paused; });

    await expect(pauseDesktopRoomConnection({
      connectionId: connection.id,
      controller: { pauseConnection } as never,
      store,
      localServer: { url: "http://127.0.0.1:4173", stop },
    })).resolves.toMatchObject({
      connection: { integrationEnabled: false },
      localRoomServerStopped: true,
    });

    expect(calls).toEqual(["pause:leave-room", "server:stop"]);
  });

  it("does not let a remote member stop the local service", async () => {
    let connection = savedConnection(true, "http://192.168.1.20:4173");
    const pauseConnection = vi.fn(async () => {
      connection = { ...connection, integrationEnabled: false };
      return {
        queued: false,
        requestId: "pause-member",
        response: pauseResponse("host", "pause-member"),
      };
    });
    const stop = vi.fn(async () => undefined);

    await expect(pauseDesktopRoomConnection({
      connectionId: connection.id,
      controller: { pauseConnection } as never,
      store: lifecycleStore(() => connection),
      localServer: { url: "http://127.0.0.1:4173", stop },
    })).resolves.toMatchObject({ queued: false, localRoomServerStopped: false });
    expect(pauseConnection).toHaveBeenCalledWith(connection.id, "leave-room");
    expect(stop).not.toHaveBeenCalled();
  });

  it("keeps a local host service running while another active connection still uses it", async () => {
    let connection = savedConnection(true);
    const otherConnection = {
      ...savedConnection(true),
      id: "connection-b",
      repositoryPath: "C:\\other-project",
    };
    const pauseConnection = vi.fn(async () => {
      connection = { ...connection, integrationEnabled: false };
      return {
        queued: false,
        requestId: "pause-shared-local-service",
        response: pauseResponse("host", "pause-shared-local-service"),
      };
    });
    const stop = vi.fn(async () => undefined);

    await expect(pauseDesktopRoomConnection({
      connectionId: connection.id,
      controller: { pauseConnection } as never,
      store: lifecycleStore(
        () => connection,
        () => undefined,
        () => [connection, otherConnection],
      ),
      localServer: { url: connection.serverUrl, stop },
    })).resolves.toMatchObject({ localRoomServerStopped: false });

    expect(stop).not.toHaveBeenCalled();
  });

  it("does not infer that a legacy role-less local connection is the host", async () => {
    let connection = { ...savedConnection(true), memberRole: undefined };
    const pauseConnection = vi.fn(async () => {
      connection = { ...connection, integrationEnabled: false };
      return {
        queued: false,
        requestId: "pause-legacy-member",
        response: pauseResponse("member", "pause-legacy-member"),
      };
    });
    const stop = vi.fn(async () => undefined);

    await expect(pauseDesktopRoomConnection({
      connectionId: connection.id,
      controller: { pauseConnection } as never,
      store: lifecycleStore(() => connection),
      localServer: { url: "http://127.0.0.1:4173", stop },
    })).resolves.toMatchObject({ localRoomServerStopped: false });
    expect(pauseConnection).toHaveBeenCalledWith(connection.id, "leave-room");
    expect(stop).not.toHaveBeenCalled();
  });

  it("keeps the local service running after ownership was transferred", async () => {
    let connection = savedConnection(true);
    const pauseConnection = vi.fn(async () => {
      connection = { ...connection, integrationEnabled: false };
      return {
        queued: false,
        requestId: "pause-old-host",
        response: pauseResponse("member", "pause-old-host"),
      };
    });
    const stop = vi.fn(async () => undefined);

    await expect(pauseDesktopRoomConnection({
      connectionId: connection.id,
      controller: { pauseConnection } as never,
      store: lifecycleStore(() => connection),
      localServer: { url: connection.serverUrl, stop },
    })).resolves.toMatchObject({ localRoomServerStopped: false });
    expect(pauseConnection).toHaveBeenCalledWith(connection.id, "leave-room");
    expect(stop).not.toHaveBeenCalled();
  });

  it("keeps the local service running when pause cleanup is queued", async () => {
    const calls: string[] = [];
    let connection = savedConnection(true);
    const store = lifecycleStore(() => connection, (paused) => {
      calls.push("connection:paused");
      connection = paused;
    });
    const pauseConnection = vi.fn(async () => {
      connection = { ...connection, integrationEnabled: false };
      calls.push("cleanup:requested");
      return {
        queued: true,
        requestId: "pause-offline",
        response: pauseResponse("host", "pause-offline"),
      };
    });
    const stop = vi.fn(async () => undefined);

    await expect(pauseDesktopRoomConnection({
      connectionId: connection.id,
      controller: { pauseConnection } as never,
      store,
      localServer: { url: connection.serverUrl, stop },
    })).resolves.toMatchObject({
      connection: { integrationEnabled: false },
      queued: true,
      localRoomServerStopped: false,
    });
    expect(calls).toEqual(["cleanup:requested"]);
    expect(pauseConnection).toHaveBeenCalledWith(connection.id, "leave-room");
    expect(stop).not.toHaveBeenCalled();
  });

  it("propagates a cleanup error without stopping a host room", async () => {
    let connection = savedConnection(true);
    const stop = vi.fn(async () => undefined);
    const pauseConnection = vi.fn(async () => {
      connection = { ...connection, integrationEnabled: false };
      return {
        queued: false,
        requestId: "pause-auth-failed",
        cleanupError: "The member token is invalid.",
        response: pauseResponse("host", "pause-auth-failed"),
      };
    });

    await expect(pauseDesktopRoomConnection({
      connectionId: connection.id,
      controller: { pauseConnection } as never,
      store: lifecycleStore(() => connection, (paused) => { connection = paused; }),
      localServer: { url: connection.serverUrl, stop },
    })).resolves.toMatchObject({
      connection: { integrationEnabled: false },
      cleanupError: "The member token is invalid.",
      localRoomServerStopped: false,
    });
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not leave the room when the local paused state was not persisted", async () => {
    const connection = savedConnection(true);
    const stop = vi.fn(async () => undefined);

    await expect(pauseDesktopRoomConnection({
      connectionId: connection.id,
      controller: {
        pauseConnection: vi.fn(async () => ({
          queued: false,
          requestId: "pause-local-write-failed",
          cleanupError: "Agent Hub could not persist cleanup before pausing.",
        })),
      } as never,
      store: lifecycleStore(() => connection),
      localServer: { url: connection.serverUrl, stop },
    })).rejects.toThrow("could not persist cleanup before pausing");

    expect(stop).not.toHaveBeenCalled();
  });

  it("keeps the local service running when a pause response has no role", async () => {
    let connection = savedConnection(true);
    const stop = vi.fn(async () => undefined);
    const pauseConnection = vi.fn(async () => {
      connection = { ...connection, integrationEnabled: false };
      return { queued: false, requestId: "pause-missing-response" };
    });

    await expect(pauseDesktopRoomConnection({
      connectionId: connection.id,
      controller: { pauseConnection } as never,
      store: lifecycleStore(() => connection, (paused) => { connection = paused; }),
      localServer: { url: connection.serverUrl, stop },
    })).resolves.toMatchObject({ localRoomServerStopped: false });
    expect(stop).not.toHaveBeenCalled();
  });

  it("restarts the local service before reactivating a saved room", async () => {
    const calls: string[] = [];
    const connection = savedConnection(false);
    const activated = {
      connection: { ...connection, integrationEnabled: true },
      pausedConnectionIds: ["connection-old"],
      warnings: ["previous room is offline"],
    };
    const startServer = vi.fn(async () => { calls.push("server:start"); });
    const activateExclusiveConnection = vi.fn(async () => {
      calls.push("connection:activate");
      return activated;
    });
    const startController = vi.fn(async () => { calls.push("integration:start"); });

    await expect(activateDesktopRoomConnection({
      connectionId: connection.id,
      controller: { activateExclusiveConnection, start: startController },
      localServer: { start: startServer },
    })).resolves.toEqual(activated);

    expect(calls).toEqual(["server:start", "connection:activate", "integration:start"]);
  });

  it("persists a new room paused before activating it exclusively", async () => {
    const calls: string[] = [];
    const paused = savedConnection(false);
    const activated = {
      connection: { ...paused, integrationEnabled: true },
      pausedConnectionIds: ["connection-old"],
      warnings: [],
    };
    const save = vi.fn(async (input) => {
      calls.push(`connection:save:${input.integrationEnabled}`);
      return paused;
    });
    const rememberConnectionState = vi.fn((connectionId: string, enabled: boolean) => {
      calls.push(`connection:remember:${connectionId}:${enabled}`);
    });
    const activateExclusiveConnection = vi.fn(async () => {
      calls.push("connection:activate");
      return activated;
    });

    await expect(saveAndActivateDesktopRoomConnection({
      input: {
        serverUrl: paused.serverUrl,
        memberToken: "member-token",
        repositoryPath: paused.repositoryPath,
        integrationEnabled: true,
      },
      store: { save } as never,
      controller: {
        rememberConnectionState,
        activateExclusiveConnection,
        start: vi.fn(async () => { calls.push("integration:start"); }),
      },
      localServer: { start: vi.fn(async () => { calls.push("server:start"); }) },
    })).resolves.toEqual(activated);

    expect(calls).toEqual([
      "connection:save:false",
      `connection:remember:${paused.id}:false`,
      "server:start",
      "connection:activate",
      "integration:start",
    ]);
  });

  it("deletes one local room without stopping a service used by another active connection", async () => {
    const selected = savedConnection(true);
    const remaining = {
      ...savedConnection(true),
      id: "connection-b",
      repositoryPath: "C:\\other-project",
    };
    let deleted = false;
    const uninstallCodexIntegration = vi.fn(async () => ({
      changed: true,
      restartRequired: true,
    }));
    const deleteConnection = vi.fn(async (_connectionId, cleanup) => {
      const cleanupResult = await cleanup({ connection: selected, isLastConnection: false });
      deleted = true;
      return {
        deletedConnectionId: selected.id,
        remoteCleanup: "completed" as const,
        memberRole: "host" as const,
        warnings: [],
        cleanup: cleanupResult,
      };
    });
    const stop = vi.fn(async () => undefined);

    await expect(deleteDesktopRoomConnection({
      connectionId: selected.id,
      controller: { deleteConnection } as never,
      store: {
        get: vi.fn(async () => selected),
        list: vi.fn(async () => deleted ? [remaining] : [selected, remaining]),
      },
      localServer: { url: selected.serverUrl, stop },
      uninstallCodexIntegration,
    })).resolves.toEqual({
      deletedConnectionId: selected.id,
      remoteCleanup: "completed",
      codexConfigChanged: true,
      codexRestartRequired: true,
      warnings: [],
    });

    expect(uninstallCodexIntegration).toHaveBeenCalledWith({
      connection: selected,
      isLastConnection: false,
    });
    expect(stop).not.toHaveBeenCalled();
  });

  it("reports a warning when a deleted host room service cannot be stopped", async () => {
    const selected = savedConnection(true);
    const uninstallCodexIntegration = vi.fn(async () => ({
      changed: true,
      restartRequired: true,
    }));
    const deleteConnection = vi.fn(async (_connectionId, cleanup) => ({
      deletedConnectionId: selected.id,
      remoteCleanup: "completed" as const,
      memberRole: "host" as const,
      warnings: [],
      cleanup: await cleanup({ connection: selected, isLastConnection: true }),
    }));
    const stop = vi.fn(async () => {
      throw new Error("service did not exit");
    });

    await expect(deleteDesktopRoomConnection({
      connectionId: selected.id,
      controller: { deleteConnection } as never,
      store: {
        get: vi.fn(async () => selected),
        list: vi.fn(async () => []),
      },
      localServer: { url: selected.serverUrl, stop },
      uninstallCodexIntegration,
    })).resolves.toEqual({
      deletedConnectionId: selected.id,
      remoteCleanup: "completed",
      codexConfigChanged: true,
      codexRestartRequired: true,
      warnings: [
        "The room was removed from this computer, but Agent Hub could not stop the local room service: service did not exit",
      ],
    });

    expect(uninstallCodexIntegration).toHaveBeenCalledWith({
      connection: selected,
      isLastConnection: true,
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("closes the local gate before draining producers and stops the room service last", async () => {
    const calls: string[] = [];
    await shutdownDesktopIntegration({
      schedulers: [
        { stop: vi.fn(async () => { calls.push("scanner:stop"); }) },
        { stop: vi.fn(async () => { calls.push("heartbeat:stop"); }) },
      ],
      controller: {
        deactivateLocalGate: vi.fn(async () => { calls.push("integration:inactive"); }),
        shutdown: vi.fn(async () => { calls.push("integration:shutdown"); }),
      } as never,
      localServer: { stop: vi.fn(async () => { calls.push("server:stop"); }) },
    });

    expect(calls[0]).toBe("integration:inactive");
    expect(calls.slice(-2)).toEqual(["integration:shutdown", "server:stop"]);
    expect(calls.slice(1, 3).sort()).toEqual(["heartbeat:stop", "scanner:stop"]);
  });

  it("still stops the local room service when integration cleanup fails", async () => {
    const calls: string[] = [];
    const cleanupFailure = new Error("cleanup failed");

    await expect(shutdownDesktopIntegration({
      schedulers: [{ stop: vi.fn(async () => { calls.push("scanner:stop"); }) }],
      controller: {
        deactivateLocalGate: vi.fn(async () => { calls.push("integration:inactive"); }),
        shutdown: vi.fn(async () => {
          calls.push("integration:shutdown");
          throw cleanupFailure;
        }),
      } as never,
      localServer: { stop: vi.fn(async () => { calls.push("server:stop"); }) },
    })).rejects.toBe(cleanupFailure);

    expect(calls).toEqual([
      "integration:inactive",
      "scanner:stop",
      "integration:shutdown",
      "server:stop",
    ]);
  });

  it("uses maintenance without shutdown and restores service before integration", async () => {
    const calls: string[] = [];
    const controller = {
      enterMaintenance: vi.fn(async () => { calls.push("maintenance:enter"); }),
      resumeAfterMaintenance: vi.fn(async () => { calls.push("maintenance:resume"); }),
    };
    const localServer = {
      stop: vi.fn(async () => { calls.push("server:stop"); }),
      start: vi.fn(async () => { calls.push("server:start"); }),
    };
    await enterDesktopMaintenance({
      controller,
      scanner: { stop: vi.fn(async () => { calls.push("scanner:stop"); }) },
      localServer,
    });
    await recoverDesktopMaintenance({ controller, localServer });

    expect(calls).toEqual([
      "maintenance:enter",
      "scanner:stop",
      "server:stop",
      "server:start",
      "maintenance:resume",
    ]);
  });

  it("stops every maintenance component when a later transition fails", async () => {
    const calls: string[] = [];
    const serviceFailure = new Error("room service stop failed");

    await expect(enterDesktopMaintenance({
      controller: {
        enterMaintenance: vi.fn(async () => { calls.push("maintenance:enter"); }),
      },
      scanner: {
        stop: vi.fn(async () => { calls.push("scanner:stop"); }),
      },
      localServer: {
        stop: vi.fn(async () => {
          calls.push("server:stop");
          throw serviceFailure;
        }),
      },
    })).rejects.toBe(serviceFailure);

    expect(calls).toEqual(["maintenance:enter", "scanner:stop", "server:stop"]);
  });

  it("resumes integration and schedulers even when the local room service cannot restart", async () => {
    const calls: string[] = [];
    const serviceFailure = new Error("room service failed");
    const controller = {
      resumeAfterMaintenance: vi.fn(async () => { calls.push("maintenance:resume"); }),
    };
    const localServer = {
      start: vi.fn(async () => {
        calls.push("server:start");
        throw serviceFailure;
      }),
    };

    await expect(recoverDesktopMaintenance({
      controller,
      localServer,
      restartSchedulers: [
        () => { calls.push("scanner:start"); },
        () => { calls.push("heartbeat:start"); },
      ],
    })).rejects.toBe(serviceFailure);

    expect(calls).toEqual([
      "server:start",
      "maintenance:resume",
      "scanner:start",
      "heartbeat:start",
    ]);
  });

  it("restarts a stopped host service only for explicit local create or join", () => {
    const local = "http://127.0.0.1:4173";
    expect(shouldStartLocalRoomService({
      method: "POST",
      path: "/api/rooms",
      serverUrl: local,
    }, local)).toBe(true);
    expect(shouldStartLocalRoomService({
      method: "POST",
      path: "/api/rooms/join",
      serverUrl: "http://localhost:4173",
    }, local)).toBe(false);
    expect(shouldStartLocalRoomService({
      connectionId: "connection-a",
      method: "GET",
      path: "/api/dashboard",
    }, local)).toBe(false);
    expect(shouldStartLocalRoomService({
      connectionId: "connection-a",
      method: "POST",
      path: "/api/records",
    }, local)).toBe(false);
  });
});

function savedConnection(
  integrationEnabled: boolean,
  serverUrl = "http://127.0.0.1:4173",
): SavedRoomConnection {
  return {
    id: "connection-a",
    serverUrl,
    repositoryPath: "C:\\project",
    memberRole: "host",
    integrationEnabled,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

function lifecycleStore(
  readConnection: () => SavedRoomConnection,
  onPause: (connection: SavedRoomConnection) => void = () => undefined,
  listConnections: () => SavedRoomConnection[] = () => [readConnection()],
) {
  return {
    get: vi.fn(async () => readConnection()),
    list: vi.fn(async () => listConnections()),
    pauseIntegration: vi.fn(async () => {
      const paused = { ...readConnection(), integrationEnabled: false };
      onPause(paused);
      return paused;
    }),
    readMemberToken: vi.fn(async () => "member-token"),
  };
}

function pauseResponse(memberRole: "host" | "member", requestId: string) {
  return {
    requestId,
    roomId: "room-a",
    memberId: "member-a",
    memberRole,
    reason: "leave-room",
    cutoffAt: "2026-08-27T00:00:00.000Z",
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
  };
}
