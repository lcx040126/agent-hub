import { describe, expect, it, vi } from "vitest";
import { createRequestPlan, requestRoomServer } from "./room-server-proxy.js";

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
    const allowedRequests = [
      { method: "GET", path: "/api/release-requests?status=pending" },
      { method: "GET", path: "/api/sessions" },
      { method: "GET", path: "/api/features/feature_01/history" },
      { method: "POST", path: "/api/release-requests/request_01/resolve", body: {} },
      { method: "POST", path: "/api/features/query", body: {} },
      { method: "POST", path: "/api/features/revisions", body: {} },
      { method: "POST", path: "/api/features/feature_01/rollback", body: {} },
      { method: "POST", path: "/api/feature-confirmations/confirmation_01/resolve", body: {} },
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
});
