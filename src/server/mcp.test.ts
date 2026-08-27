import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMcpRouter,
  type AgentHubMemberIdentity,
  type AgentHubServiceLike,
} from "./mcp.js";

const MEMBER_TOKEN = "member_test_token";
const MEMBER: AgentHubMemberIdentity = {
  id: "member-1",
  roomId: "room-1",
  displayName: "Test member",
  role: "member",
  agent: "Codex",
};

function createService() {
  const operations: Array<{ name: string; input: unknown }> = [];
  const record = (name: string, input: unknown) => {
    operations.push({ name, input });
    return { ok: true, operation: name };
  };

  const service: AgentHubServiceLike = {
    authenticateMemberToken: vi.fn((token: string) =>
      token === MEMBER_TOKEN ? MEMBER : null,
    ),
    sessionOpen: vi.fn((_context, input) => record("session_open", input)),
    contextQuery: vi.fn((_context, input) => record("context_query", input)),
    leaseAcquire: vi.fn((_context, input) => record("lease_acquire", input)),
    leaseRenew: vi.fn((_context, input) => record("lease_renew", input)),
    editCheck: vi.fn((_context, input) => record("edit_check", input)),
    featureContextQuery: vi.fn((_context, input) => record("feature_context_query", input)),
    featureHistory: vi.fn((_context, input) => record("feature_history", input)),
    featureRevisionSubmit: vi.fn((_context, input) => record("feature_revision_submit", input)),
    featureRollback: vi.fn((_context, input) => record("feature_revision_rollback", input)),
    featureChangeConfirm: vi.fn((_context, input) => record("feature_change_confirm", input)),
    eventAppend: vi.fn((_context, input) => record("event_append", input)),
    sessionClose: vi.fn((_context, input) => record("session_close", input)),
  };

  return { service, operations };
}

async function listen(service: AgentHubServiceLike) {
  const app = express();
  app.use("/mcp", createMcpRouter(service));
  const httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const { port } = httpServer.address() as AddressInfo;
  return {
    httpServer,
    url: new URL(`http://127.0.0.1:${port}/mcp`),
  };
}

describe("Agent Hub Streamable HTTP MCP", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("rejects requests without a valid Bearer member token", async () => {
    const { service } = createService();
    const { httpServer, url } = await listen(service);
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        }),
    );

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "unauthorized-test", version: "1.0.0" },
        },
      }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32_001 },
      id: null,
    });
  });

  it("initializes, lists annotated tools, and dispatches calls through the service adapter", async () => {
    const { service, operations } = createService();
    const { httpServer, url } = await listen(service);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: { Authorization: `Bearer ${MEMBER_TOKEN}` },
      },
    });
    const client = new Client({ name: "agent-hub-test", version: "1.0.0" });

    cleanups.push(async () => {
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    });

    await client.connect(transport);

    expect(client.getServerVersion()).toMatchObject({
      name: "agent-hub",
      version: "0.2.3",
    });
    expect(client.getInstructions()).toContain("reuse that exact Hook session");
    expect(client.getInstructions()).toContain("do not call session_open");

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "session_open",
      "context_query",
      "lease_acquire",
      "lease_renew",
      "edit_check",
      "feature_context_query",
      "feature_history",
      "feature_revision_submit",
      "feature_revision_rollback",
      "feature_change_confirm",
      "event_append",
      "session_close",
    ]);

    const tools = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
    expect(tools.context_query.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(tools.lease_acquire.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    for (const name of [
      "lease_acquire",
      "lease_renew",
      "edit_check",
      "feature_context_query",
      "feature_history",
      "feature_revision_submit",
      "feature_revision_rollback",
      "feature_change_confirm",
      "event_append",
    ] as const) {
      expect(tools[name].inputSchema).toMatchObject({
        required: expect.arrayContaining(["sessionId"]),
      });
    }
    expect(tools.session_close.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(tools.session_close.inputSchema).toMatchObject({
      required: expect.arrayContaining(["sessionId"]),
    });

    const missingSessionId = await client.callTool({
      name: "session_close",
      arguments: { status: "cancelled" },
    });
    expect(missingSessionId.isError).toBe(true);
    expect(service.sessionClose).not.toHaveBeenCalled();

    const missingEventSessionId = await client.callTool({
      name: "event_append",
      arguments: {
        eventType: "verification",
        kind: "automated_test",
        result: "passed",
        summary: "Missing session ownership.",
      },
    });
    expect(missingEventSessionId.isError).toBe(true);
    expect(service.eventAppend).not.toHaveBeenCalled();

    const results = [];
    results.push(
      await client.callTool({
        name: "session_open",
        arguments: { objective: "Add a compatible inventory feature", paths: ["Assets/Inventory"] },
      }),
    );
    results.push(
      await client.callTool({
        name: "context_query",
        arguments: { paths: ["Assets/Inventory"], kinds: ["rule", "dependency"] },
      }),
    );
    results.push(
      await client.callTool({
        name: "lease_acquire",
        arguments: {
          sessionId: "session-1",
          title: "Inventory feature",
          paths: ["Assets/Inventory"],
        },
      }),
    );
    results.push(
      await client.callTool({
        name: "lease_renew",
        arguments: { sessionId: "session-1", leaseId: "lease-1", ttlSeconds: 600 },
      }),
    );
    results.push(
      await client.callTool({
        name: "edit_check",
        arguments: {
          sessionId: "session-1",
          leaseId: "lease-1",
          paths: ["Assets/Inventory/Feature.cs"],
          proposedEdits: [{
            path: "Assets/Inventory/Feature.cs",
            precision: "symbol",
            symbols: ["InventoryFeature.Apply"],
            operation: "update",
          }],
        },
      }),
    );
    results.push(
      await client.callTool({
        name: "feature_context_query",
        arguments: {
          sessionId: "session-1",
          paths: ["Assets/Inventory/Feature.cs"],
          level: "cards",
        },
      }),
    );
    results.push(
      await client.callTool({
        name: "feature_history",
        arguments: { sessionId: "session-1", featureId: "feature-1" },
      }),
    );
    results.push(
      await client.callTool({
        name: "feature_revision_submit",
        arguments: {
          sessionId: "session-1",
          featureKey: "inventory.apply",
          name: "Inventory apply",
          systemId: "inventory",
          objective: "Apply an item without breaking existing inventory contracts.",
          changeSummary: "Added the compatible apply path.",
          contractChanges: [{
            operation: "add",
            key: "inventory.apply.compatible",
            behavior: "Applies compatible items and preserves unrelated slots.",
          }],
          targets: [{
            kind: "symbol",
            role: "implementation",
            path: "Assets/Inventory/Feature.cs",
            symbol: "InventoryFeature.Apply",
          }],
          finalCommit: "abcd1234",
          completed: true,
          verifications: [{
            testKey: "inventory-regression",
            result: "passed",
            summary: "Inventory regression tests passed.",
          }],
        },
      }),
    );
    results.push(
      await client.callTool({
        name: "feature_revision_rollback",
        arguments: {
          sessionId: "session-1",
          featureId: "feature-1",
          targetRevisionId: "revision-1",
          changeSummary: "Restore the last verified behavior.",
          finalCommit: "dcba4321",
          completed: true,
          verifications: [{
            testKey: "inventory-regression",
            result: "passed",
            summary: "Rollback regression tests passed.",
          }],
        },
      }),
    );
    results.push(
      await client.callTool({
        name: "feature_change_confirm",
        arguments: {
          sessionId: "session-1",
          confirmationId: "confirmation-1",
          decision: "approved",
          reason: "The behavior change is intentional and regression coverage is ready.",
        },
      }),
    );
    results.push(
      await client.callTool({
        name: "event_append",
        arguments: {
          sessionId: "session-1",
          eventType: "verification",
          leaseId: "lease-1",
          kind: "automated_test",
          result: "passed",
          summary: "Inventory regression tests passed.",
          command: "pnpm test",
          evidence: "63 tests passed.",
        },
      }),
    );
    results.push(
      await client.callTool({
        name: "session_close",
        arguments: {
          sessionId: "session-1",
          leaseId: "lease-1",
          status: "completed",
          summary: "Feature verified.",
        },
      }),
    );

    for (const result of results) {
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: true });
    }

    expect(operations.map((operation) => operation.name)).toEqual([
      "session_open",
      "context_query",
      "lease_acquire",
      "lease_renew",
      "edit_check",
      "feature_context_query",
      "feature_history",
      "feature_revision_submit",
      "feature_revision_rollback",
      "feature_change_confirm",
      "event_append",
      "session_close",
    ]);
    expect(service.authenticateMemberToken).toHaveBeenCalledWith(MEMBER_TOKEN);
    expect(service.editCheck).toHaveBeenCalledWith(
      { memberToken: MEMBER_TOKEN, member: MEMBER },
      {
        sessionId: "session-1",
        leaseId: "lease-1",
        paths: ["Assets/Inventory/Feature.cs"],
        proposedEdits: [{
          path: "Assets/Inventory/Feature.cs",
          precision: "symbol",
          symbols: ["InventoryFeature.Apply"],
          operation: "update",
        }],
      },
    );
    expect(service.eventAppend).toHaveBeenCalledWith(
      { memberToken: MEMBER_TOKEN, member: MEMBER },
      {
        sessionId: "session-1",
        eventType: "verification",
        leaseId: "lease-1",
        kind: "automated_test",
        result: "passed",
        summary: "Inventory regression tests passed.",
        command: "pnpm test",
        evidence: "63 tests passed.",
      },
    );
    expect(service.sessionClose).toHaveBeenCalledWith(
      { memberToken: MEMBER_TOKEN, member: MEMBER },
      {
        sessionId: "session-1",
        leaseId: "lease-1",
        status: "completed",
        summary: "Feature verified.",
      },
    );
  });
});
