import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationOperationTracker } from "../companion/integration-operations.js";
import { PausePreparationQueue } from "../companion/pause-preparation.js";
import { createRequestPlan, requestRoomServer } from "./room-server-proxy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("createRequestPlan", () => {
  it("allows only health, create, and join during bootstrap", () => {
    expect(
      createRequestPlan(
        { method: "GET", path: "/api/health" },
        "http://192.168.1.10:4173",
        undefined,
        false,
      ).url,
    ).toBe("http://192.168.1.10:4173/api/health");
    expect(() =>
      createRequestPlan(
        { method: "GET", path: "/api/dashboard" },
        "http://192.168.1.10:4173",
        undefined,
        false,
      ),
    ).toThrow(/not allowed before/i);
  });

  it("blocks MCP, cross-origin URLs, encoded traversal, and URL credentials", () => {
    expect(() =>
      createRequestPlan(
        { method: "POST", path: "/mcp", body: {} },
        "http://192.168.1.10:4173",
        undefined,
        true,
      ),
    ).toThrow();
    expect(() =>
      createRequestPlan(
        { method: "GET", path: "https://evil.example/api/health" },
        "http://192.168.1.10:4173",
        undefined,
        true,
      ),
    ).toThrow(/selected server/i);
    expect(() =>
      createRequestPlan(
        { method: "GET", path: "/api/%2e%2e/secret" },
        "http://192.168.1.10:4173",
        undefined,
        true,
      ),
    ).toThrow();
    expect(() =>
      createRequestPlan(
        { method: "GET", path: "/api/health" },
        "http://user:secret@192.168.1.10:4173",
        undefined,
        true,
      ),
    ).toThrow(/credentials/i);
  });

  it("allows a saved connection to use only known dashboard API routes", () => {
    expect(
      createRequestPlan(
        { method: "GET", path: "/api/context?paths=Assets%2FGame" },
        "https://hub.example",
        "secret",
        true,
      ),
    ).toMatchObject({ method: "GET", memberToken: "secret" });
    expect(() =>
      createRequestPlan(
        { method: "POST", path: "/api/admin/delete", body: {} },
        "https://hub.example",
        "secret",
        true,
      ),
    ).toThrow(/not allowed/i);
  });

  it("allows v0.2 collaboration routes without opening arbitrary API access", () => {
    expect(createRequestPlan(
      { method: "GET", path: "/api/release-requests?status=pending" },
      "https://hub.example",
      "secret",
      true,
    ).url).toBe("https://hub.example/api/release-requests?status=pending");
    const allowedRequests = [
      { method: "GET", path: "/api/release-requests?status=pending" },
      { method: "GET", path: "/api/sessions" },
      { method: "GET", path: "/api/features/feature_01/history" },
      { method: "POST", path: "/api/release-requests/request_01/resolve", body: {} },
      { method: "POST", path: "/api/features/query", body: {} },
      { method: "POST", path: "/api/features/revisions", body: {} },
      { method: "POST", path: "/api/features/feature_01/rollback", body: {} },
      { method: "POST", path: "/api/feature-confirmations/confirmation_01/resolve", body: {} },
      { method: "POST", path: "/api/decisions/decision_01/supersede", body: {} },
      { method: "POST", path: "/api/decisions/decision_01-abc/supersede", body: {} },
      { method: "POST", path: "/api/sessions/session_01/heartbeat", body: {} },
    ];

    for (const request of allowedRequests) {
      expect(() =>
        createRequestPlan(request, "https://hub.example", "secret", true),
      ).not.toThrow();
    }
    expect(() =>
      createRequestPlan(
        { method: "GET", path: "/api/release-requests?memberToken=leak" },
        "https://hub.example",
        "secret",
        true,
      ),
    ).toThrow(/query parameter/i);
    expect(() =>
      createRequestPlan(
        { method: "POST", path: "/api/features/feature_01/delete", body: {} },
        "https://hub.example",
        "secret",
        true,
      ),
    ).toThrow(/not allowed/i);
    expect(() =>
      createRequestPlan(
        { method: "POST", path: `/api/decisions/${"x".repeat(129)}/supersede`, body: {} },
        "https://hub.example",
        "secret",
        true,
      ),
    ).toThrow(/not allowed/i);
  });

  it("allows only strict decision supersession paths", () => {
    expect(createRequestPlan(
      { method: "POST", path: "/api/decisions/decision_01-abc/supersede", body: {} },
      "https://hub.example",
      "secret",
      true,
    ).url).toBe("https://hub.example/api/decisions/decision_01-abc/supersede");

    const rejectedPaths = [
      "/api/decisions/%2e%2e/supersede",
      "/api/decisions/decision_01/supersede?force=true",
      `/api/decisions/${"a".repeat(129)}/supersede`,
    ];
    for (const path of rejectedPaths) {
      expect(() => createRequestPlan(
        { method: "POST", path, body: {} },
        "https://hub.example",
        "secret",
        true,
      )).toThrow();
    }
  });

  it("rejects tokens and oversized JSON in request bodies", () => {
    expect(() =>
      createRequestPlan(
        { method: "POST", path: "/api/records", body: { memberToken: "leak" } },
        "https://hub.example",
        "secret",
        true,
      ),
    ).toThrow(/tokens cannot/i);
    expect(() =>
      createRequestPlan(
        { method: "POST", path: "/api/records", body: { text: "x".repeat(300_000) } },
        "https://hub.example",
        "secret",
        true,
      ),
    ).toThrow(/too large/i);
  });
});

describe("requestRoomServer", () => {
  it("injects a saved token without returning it to the renderer", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      return new Response(JSON.stringify({ received: authorization }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const connections = {
      get: vi.fn(async () => ({
        id: "connection-1",
        serverUrl: "http://192.168.1.10:4173",
        repositoryPath: "C:\\repo",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z",
      })),
      readMemberToken: vi.fn(async () => "private-member-token"),
    };

    const response = await requestRoomServer(
      { connectionId: "connection-1", method: "GET", path: "/api/dashboard" },
      connections,
      fetchMock as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response).toEqual({ status: 200, body: { received: "Bearer [redacted]" } });
    expect(JSON.stringify(response)).not.toContain("private-member-token");
  });

  it("rejects redirects and non-JSON responses", async () => {
    const connections = {
      get: vi.fn(async () => undefined),
      readMemberToken: vi.fn(async () => "unused"),
    };
    const fetchMock = vi.fn(async () =>
      new Response("not json", { status: 200, headers: { "Content-Type": "text/html" } }),
    );
    await expect(
      requestRoomServer(
        { serverUrl: "https://hub.example", method: "GET", path: "/api/health" },
        connections,
        fetchMock as typeof fetch,
      ),
    ).rejects.toThrow(/non-JSON/i);
  });

  it("keeps the one MiB response limit for saved room requests", async () => {
    const connections = {
      get: vi.fn(async () => ({
        id: "connection-1",
        serverUrl: "https://hub.example",
        repositoryPath: "C:\\repo",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z",
      })),
      readMemberToken: vi.fn(async () => "private-member-token"),
    };
    const oversizedBody = JSON.stringify({ payload: "x".repeat(1024 * 1024) });
    const fetchMock = vi.fn(async () => new Response(oversizedBody, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(oversizedBody, "utf8")),
      },
    }));

    await expect(requestRoomServer(
      { connectionId: "connection-1", method: "GET", path: "/api/dashboard" },
      connections,
      fetchMock as typeof fetch,
    )).rejects.toThrow(/response is too large/i);
  });

  it("accepts a multibyte dashboard response inside the server budget", async () => {
    const connections = {
      get: vi.fn(async () => ({
        id: "connection-1",
        serverUrl: "https://hub.example",
        repositoryPath: "C:\\repo",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z",
      })),
      readMemberToken: vi.fn(async () => "private-member-token"),
    };
    const budgetedBody = JSON.stringify({ payload: "测".repeat(250_000) });
    const fetchMock = vi.fn(async () => new Response(budgetedBody, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(budgetedBody, "utf8")),
      },
    }));

    await expect(requestRoomServer(
      { connectionId: "connection-1", method: "GET", path: "/api/dashboard" },
      connections,
      fetchMock as typeof fetch,
    )).resolves.toMatchObject({ status: 200, body: { payload: expect.any(String) } });
  });

  it("accepts an empty 204 response from owner management routes", async () => {
    const connections = {
      get: vi.fn(async () => ({
        id: "connection-1",
        serverUrl: "https://hub.example",
        repositoryPath: "C:\\repo",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z",
      })),
      readMemberToken: vi.fn(async () => "private-member-token"),
    };
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

    await expect(
      requestRoomServer(
        {
          connectionId: "connection-1",
          method: "POST",
          path: "/api/room/dissolve",
          body: {},
        },
        connections,
        fetchMock as typeof fetch,
      ),
    ).resolves.toEqual({ status: 204, body: null });
  });

  it("allows reads but blocks desktop mutations while exit cleanup is pending", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-proxy-pending-"));
    temporaryDirectories.push(directory);
    const connectionId = "connection-pending";
    await new PausePreparationQueue({
      filePath: path.join(directory, "pause-preparation.json"),
    }).enqueue({
      connectionId,
      reason: "app-shutdown",
      requestId: "pending-proxy-cleanup",
    });
    const connections = {
      filePath: path.join(directory, "connections.json"),
      get: vi.fn(async () => ({
        id: connectionId,
        serverUrl: "https://hub.example",
        repositoryPath: "C:\\repo",
        integrationEnabled: true,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      })),
      readMemberToken: vi.fn(async () => "private-member-token"),
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(requestRoomServer(
      { connectionId, method: "GET", path: "/api/dashboard" },
      connections,
      fetchMock as typeof fetch,
    )).resolves.toEqual({ status: 200, body: { ok: true } });
    await expect(requestRoomServer(
      { connectionId, method: "POST", path: "/api/records", body: { title: "blocked" } },
      connections,
      fetchMock as typeof fetch,
    )).rejects.toThrow(/finishing the previous shutdown cleanup/i);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("blocks saved mutations after a connection is paused", async () => {
    const connections = {
      get: vi.fn(async () => ({
        id: "connection-paused",
        serverUrl: "https://hub.example",
        repositoryPath: "C:\\repo",
        integrationEnabled: false,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      })),
      readMemberToken: vi.fn(async () => "must-not-be-read"),
    };
    const fetchMock = vi.fn<typeof fetch>();

    await expect(requestRoomServer(
      {
        connectionId: "connection-paused",
        method: "POST",
        path: "/api/records",
        body: { title: "blocked" },
      },
      connections,
      fetchMock,
    )).rejects.toThrow(/connection is paused/i);

    expect(connections.readMemberToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps an in-flight saved mutation registered until pause can drain it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-proxy-drain-"));
    temporaryDirectories.push(directory);
    const connectionId = "connection-drain";
    const connections = {
      filePath: path.join(directory, "connections.json"),
      get: vi.fn(async () => ({
        id: connectionId,
        serverUrl: "https://hub.example",
        repositoryPath: "C:\\repo",
        integrationEnabled: true,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      })),
      readMemberToken: vi.fn(async () => "private-member-token"),
    };
    let releaseRequest: (() => void) | undefined;
    const fetchMock = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseRequest = resolve; });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const request = requestRoomServer(
      {
        connectionId,
        method: "POST",
        path: "/api/records",
        body: { title: "registered" },
      },
      connections,
      fetchMock as typeof fetch,
    );
    await vi.waitFor(() => expect(releaseRequest).toBeTypeOf("function"));
    let drained = false;
    const drain = new IntegrationOperationTracker(directory).drain(connectionId, { pollIntervalMs: 5 })
      .then(() => { drained = true; });
    await vi.waitFor(() => expect(drained).toBe(false));

    releaseRequest?.();
    await expect(request).resolves.toEqual({ status: 200, body: { ok: true } });
    await drain;
    expect(drained).toBe(true);
  });
});
