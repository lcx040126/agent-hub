import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PauseRetryQueue, requestMemberPause } from "./pause-retry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("pause retry queue", () => {
  it("retains authentication failures for later cleanup", async () => {
    const directory = await temporaryDirectory();
    const onError = vi.fn();
    const queue = new PauseRetryQueue({
      filePath: path.join(directory, "pause-retry.json"),
      store: createStore(),
      fetchImpl: async () => response(403, { error: "member_removed", message: "Member removed." }),
      now: () => new Date("2026-08-27T00:00:00.000Z"),
      onError,
    });
    await queue.enqueue(entry());

    await queue.flush();

    await expect(queue.list()).resolves.toMatchObject([{
      requestId: "pause-a",
      attempts: 1,
      lastError: "Member removed.",
    }]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("retains transient failures for a later retry and reports once", async () => {
    const directory = await temporaryDirectory();
    const onError = vi.fn();
    const queue = new PauseRetryQueue({
      filePath: path.join(directory, "pause-retry.json"),
      store: createStore(),
      fetchImpl: async () => response(503, { error: "unavailable", message: "Try again." }),
      now: () => new Date("2026-08-27T00:00:00.000Z"),
      onError,
    });
    await queue.enqueue(entry({ requestId: "retry-me" }));

    await queue.flush();

    const pending = await queue.list();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ requestId: "retry-me", attempts: 1 });
    expect(onError).toHaveBeenCalledOnce();
  });

  it("retains protected requests while flushing other due cleanup", async () => {
    const directory = await temporaryDirectory();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) =>
      response(200, pauseResponseFromRequest(init)));
    const queue = new PauseRetryQueue({
      filePath: path.join(directory, "pause-retry.json"),
      store: createStore(),
      fetchImpl,
      now: () => new Date("2026-08-27T00:00:00.000Z"),
    });
    await queue.enqueue(entry({ requestId: "protected-request" }));
    await queue.enqueue(entry({ requestId: "ready-request" }));

    await queue.flush({
      shouldRetain: (pending) => pending.requestId === "protected-request",
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      requestId: "ready-request",
    });
    await expect(queue.list()).resolves.toMatchObject([{
      requestId: "protected-request",
      cutoffAt: "2026-08-27T00:00:00.000Z",
    }]);
  });

  it("saturates retry attempts at the persisted maximum", async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, "pause-retry.json");
    const queue = new PauseRetryQueue({
      filePath,
      store: createStore(),
      fetchImpl: async () => response(503, { error: "unavailable", message: "Try again." }),
      now: () => new Date("2026-08-27T00:00:00.000Z"),
    });
    await queue.enqueue(entry({ requestId: "retry-saturated" }));
    const document = JSON.parse(await readFile(filePath, "utf8")) as { requests: Array<Record<string, unknown>> };
    document.requests[0]!.attempts = 1_000;
    await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

    await queue.flush();

    await expect(queue.list()).resolves.toMatchObject([{
      requestId: "retry-saturated",
      attempts: 1_000,
    }]);
  });

  it("removes only retries owned by one connection", async () => {
    const directory = await temporaryDirectory();
    const queue = new PauseRetryQueue({
      filePath: path.join(directory, "pause-retry.json"),
      store: createStore(),
    });
    await queue.enqueue(entry({ requestId: "connection-a-request" }));
    await queue.enqueue({
      ...entry({ requestId: "connection-b-request" }),
      connectionId: "connection-b",
    });

    await expect(queue.removeForConnection("connection-a")).resolves.toBe(1);
    await expect(queue.list()).resolves.toMatchObject([{
      connectionId: "connection-b",
      requestId: "connection-b-request",
    }]);
  });

  it("returns a fully parsed pause response including the transactional member role", async () => {
    const result = await requestMemberPause(createStore(), "connection-a", "leave-room", {
      requestId: "pause-host",
      now: () => new Date("2026-08-27T00:00:00.000Z"),
      fetchImpl: async () => response(200, pauseResponse("host", "pause-host")),
    });

    expect(result).toMatchObject({
      queued: false,
      requestId: "pause-host",
      response: {
        requestId: "pause-host",
        memberRole: "host",
        closedSessionCount: 0,
      },
    });
  });

  it("can retain a completed fixed retry for caller-managed cleanup ordering", async () => {
    const directory = await temporaryDirectory();
    const queue = new PauseRetryQueue({
      filePath: path.join(directory, "pause-retry.json"),
      store: createStore(),
      now: () => new Date("2026-08-27T00:00:00.000Z"),
    });

    await expect(requestMemberPause(createStore(), "connection-a", "leave-room", {
      requestId: "pause-retained",
      now: () => new Date("2026-08-27T00:00:00.000Z"),
      queue,
      queueCompletion: "retain",
      fetchImpl: async (_input, init) => response(
        200,
        pauseResponseFromRequest(init),
      ),
    })).resolves.toMatchObject({ queued: false, requestId: "pause-retained" });

    await expect(queue.list()).resolves.toMatchObject([{
      requestId: "pause-retained",
      cutoffAt: "2026-08-27T00:00:00.000Z",
    }]);
  });

  it("can retain a terminal-conflict retry for caller-managed cleanup ordering", async () => {
    const directory = await temporaryDirectory();
    const queue = new PauseRetryQueue({
      filePath: path.join(directory, "pause-retry.json"),
      store: createStore(),
      now: () => new Date("2026-08-27T00:00:00.000Z"),
    });

    await expect(requestMemberPause(createStore(), "connection-a", "leave-room", {
      requestId: "pause-conflict-retained",
      now: () => new Date("2026-08-27T00:00:00.000Z"),
      queue,
      queueCompletion: "retain",
      fetchImpl: async () => response(409, {
        error: "pause_request_conflict",
        message: "This request ID was already used with different parameters.",
      }),
    })).resolves.toEqual({
      queued: false,
      requestId: "pause-conflict-retained",
    });

    await expect(queue.list()).resolves.toMatchObject([{
      requestId: "pause-conflict-retained",
      cutoffAt: "2026-08-27T00:00:00.000Z",
    }]);
  });

  it("rejects a successful response that omits the transactional member role", async () => {
    const withoutRole: Record<string, unknown> = { ...pauseResponse("host", "pause-no-role") };
    delete withoutRole.memberRole;

    await expect(requestMemberPause(createStore(), "connection-a", "leave-room", {
      requestId: "pause-no-role",
      now: () => new Date("2026-08-27T00:00:00.000Z"),
      fetchImpl: async () => response(200, withoutRole),
    })).rejects.toThrow("invalid member pause response: memberRole must be host or member");
  });
});

function createStore() {
  return {
    get: async () => ({
      id: "connection-a",
      serverUrl: "http://127.0.0.1:4173",
      repositoryPath: path.resolve("project"),
      integrationEnabled: false,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    }),
    readMemberToken: async () => "member-token",
  };
}

function entry(overrides: Record<string, string> = {}) {
  return {
    connectionId: "connection-a",
    reason: "app-shutdown" as const,
    cutoffAt: "2026-08-27T00:00:00.000Z",
    requestId: "pause-a",
    ...overrides,
  };
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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

function pauseResponseFromRequest(init?: RequestInit) {
  const request = JSON.parse(String(init?.body)) as {
    requestId: string;
    reason: string;
    cutoffAt: string;
  };
  return {
    ...pauseResponse("member", request.requestId),
    reason: request.reason,
    cutoffAt: request.cutoffAt,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-pause-retry-"));
  temporaryDirectories.push(directory);
  return directory;
}
