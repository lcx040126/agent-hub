import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStore } from "../desktop/connection-store.js";
import type { SavedRoomConnection } from "../desktop/contracts.js";
import { IntegrationOperationTracker } from "./integration-operations.js";
import { PausePreparationQueue } from "./pause-preparation.js";
import type { RepositorySnapshot } from "./repository.js";
import { createBackgroundScanPayload, startRepositoryScanScheduler } from "./scan-scheduler.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("repository scan lifecycle", () => {
  it("keeps a delayed scan registered but does not upload after the connection is paused", async () => {
    const userDataPath = await temporaryDirectory();
    let connection = savedConnection(userDataPath);
    const store = {
      filePath: path.join(userDataPath, "connections.json"),
      list: vi.fn(async () => [connection]),
      get: vi.fn(async () => connection),
      readMemberToken: vi.fn(async () => "member-token"),
    } as unknown as ConnectionStore;
    let releaseInspection: ((snapshot: RepositorySnapshot) => void) | undefined;
    const inspect = vi.fn(() => new Promise<RepositorySnapshot>((resolve) => {
      releaseInspection = resolve;
    }));
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/sessions") return jsonResponse({ session: { id: "late-scan-session" } });
      if (pathname.endsWith("/scan")) return jsonResponse({ scan: { id: "scan-a" } });
      throw new Error(`Unexpected scan request: ${pathname}`);
    });
    const scheduler = startRepositoryScanScheduler({
      store,
      inspect,
      fetchImpl,
      intervalMs: 60_000,
    });
    await vi.waitFor(() => expect(releaseInspection).toBeTypeOf("function"));

    connection = { ...connection, integrationEnabled: false };
    let drained = false;
    const drain = new IntegrationOperationTracker(userDataPath).drain(connection.id, { pollIntervalMs: 5 })
      .then(() => { drained = true; });
    await vi.waitFor(() => expect(drained).toBe(false));
    releaseInspection?.(repositorySnapshot(userDataPath));

    await scheduler.stop();
    await drain;
    expect(drained).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rechecks a connection after registering and skips one already paused", async () => {
    const userDataPath = await temporaryDirectory();
    let connection = savedConnection(userDataPath);
    let releaseRegistration: (() => void) | undefined;
    const operationTracker = {
      run: vi.fn(async (_connectionId: string, operation: () => Promise<void>) => {
        await new Promise<void>((resolve) => { releaseRegistration = resolve; });
        return operation();
      }),
    };
    const store = {
      filePath: path.join(userDataPath, "connections.json"),
      list: vi.fn(async () => [connection]),
      get: vi.fn(async () => connection),
      readMemberToken: vi.fn(async () => "member-token"),
    } as unknown as ConnectionStore;
    const inspect = vi.fn(async () => repositorySnapshot(userDataPath));
    const fetchImpl = vi.fn<typeof fetch>();
    const scheduler = startRepositoryScanScheduler({
      store,
      inspect,
      fetchImpl,
      operationTracker,
      intervalMs: 60_000,
    });
    await vi.waitFor(() => expect(releaseRegistration).toBeTypeOf("function"));

    connection = { ...connection, integrationEnabled: false };
    releaseRegistration?.();
    await scheduler.stop();

    expect(inspect).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rechecks the local gate before every room request", async () => {
    const userDataPath = await temporaryDirectory();
    let connection = savedConnection(userDataPath);
    const store = {
      filePath: path.join(userDataPath, "connections.json"),
      list: vi.fn(async () => [connection]),
      get: vi.fn(async () => connection),
      readMemberToken: vi.fn(async () => "member-token"),
    } as unknown as ConnectionStore;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/sessions") {
        connection = { ...connection, integrationEnabled: false };
        return jsonResponse({ session: { id: "scan-session" } });
      }
      throw new Error(`Unexpected request after pause: ${pathname}`);
    });
    const scheduler = startRepositoryScanScheduler({
      store,
      inspect: vi.fn(async () => repositorySnapshot(userDataPath)),
      fetchImpl,
      intervalMs: 60_000,
    });

    await scheduler.stop();

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).pathname).toBe("/api/sessions");
  });

  it("does not upload or read credentials while exit cleanup is pending", async () => {
    const userDataPath = await temporaryDirectory();
    const connection = savedConnection(userDataPath);
    await new PausePreparationQueue({
      filePath: path.join(userDataPath, "pause-preparation.json"),
    }).enqueue({
      connectionId: connection.id,
      reason: "app-shutdown",
      requestId: "pending-scan-cleanup",
    });
    const store = {
      filePath: path.join(userDataPath, "connections.json"),
      list: vi.fn(async () => [connection]),
      get: vi.fn(async () => connection),
      readMemberToken: vi.fn(async () => "member-token"),
    } as unknown as ConnectionStore;
    const inspect = vi.fn(async () => repositorySnapshot(userDataPath));
    const fetchImpl = vi.fn<typeof fetch>();
    const scheduler = startRepositoryScanScheduler({
      store,
      inspect,
      fetchImpl,
      intervalMs: 60_000,
    });

    await scheduler.stop();

    expect(inspect).toHaveBeenCalledOnce();
    expect(store.readMemberToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds a repository inspection so shutdown cannot wait forever", async () => {
    const userDataPath = await temporaryDirectory();
    const connection = savedConnection(userDataPath);
    const store = {
      filePath: path.join(userDataPath, "connections.json"),
      list: vi.fn(async () => [connection]),
      get: vi.fn(async () => connection),
      readMemberToken: vi.fn(async () => "member-token"),
    } as unknown as ConnectionStore;
    const onError = vi.fn();
    const scheduler = startRepositoryScanScheduler({
      store,
      inspect: vi.fn(() => new Promise<RepositorySnapshot>(() => undefined)),
      inspectTimeoutMs: 20,
      fetchImpl: vi.fn(),
      onError,
      intervalMs: 60_000,
    });

    await scheduler.stop();

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Repository inspection did not finish within 20 ms." }),
      connection,
    );
  });
});

describe("background repository scan attribution", () => {
  it("keeps manual, IDE, and Unity changed paths off the room server", () => {
    const snapshot = repositorySnapshot("C:/project");
    snapshot.changedPaths = ["Assets/Scenes/Manual.unity", "src/ide-save.ts"];
    snapshot.impactedSystemIds = ["manual", "ide-save"];
    snapshot.analysis.trackedFileCount = 2;
    snapshot.analysis.unityReferenceCount = 1;
    snapshot.analysis.historyCommitCount = 1;

    const payload = createBackgroundScanPayload(snapshot);
    expect(payload.changedPaths).toEqual([]);
    expect(payload.metadata).toMatchObject({ externalChangesExcluded: true });
    expect(payload.metadata).not.toHaveProperty("impactedSystemIds");
    expect(payload.metadata).not.toHaveProperty("changedPathCount");
  });
});

function savedConnection(repositoryPath: string): SavedRoomConnection {
  return {
    id: "connection-a",
    serverUrl: "http://agent-hub.test:4173",
    repositoryPath,
    memberRole: "member",
    integrationEnabled: true,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

function repositorySnapshot(root: string): RepositorySnapshot {
  return {
    repository: {
      root,
      name: "project",
      remote: null,
      branch: "main",
      headCommit: "0123456789abcdef",
      rootCommit: "0123456789abcdef",
      fingerprint: "fingerprint-a",
    },
    generatedAt: "2026-08-27T00:00:00.000Z",
    changedPaths: [],
    ruleFiles: [],
    systems: [],
    dependencies: [],
    impactedSystemIds: [],
    analysis: {
      trackedFileCount: 0,
      parsedCSharpFileCount: 0,
      unityReferenceCount: 0,
      historyCommitCount: 0,
      truncated: false,
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-scanner-"));
  temporaryDirectories.push(directory);
  return directory;
}
