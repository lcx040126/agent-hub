import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpProxyServer } from "./mcp-bridge.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("Agent Hub stdio bridge server", () => {
  it("forwards tool discovery and calls without exposing credentials", async () => {
    const remote = {
      getInstructions: () => "Use Agent Hub before editing.",
      listTools: vi.fn(async () => ({
        tools: [{
          name: "context_query",
          description: "Read shared context",
          inputSchema: { type: "object" as const, properties: {} },
        }],
      })),
      callTool: vi.fn(async (params: { name: string; arguments?: Record<string, unknown> }) => ({
        content: [{ type: "text" as const, text: JSON.stringify(params.arguments ?? {}) }],
        structuredContent: { forwarded: true },
      })),
    };
    const server = createMcpProxyServer(remote);
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(() => client.close(), () => server.close());

    await expect(client.listTools()).resolves.toMatchObject({
      tools: [{ name: "context_query" }],
    });
    await expect(client.callTool({
      name: "context_query",
      arguments: { paths: ["src/app.ts"] },
    })).resolves.toMatchObject({ structuredContent: { forwarded: true } });
    expect(remote.callTool).toHaveBeenCalledWith({
      name: "context_query",
      arguments: { paths: ["src/app.ts"] },
    });
    expect(client.getInstructions()).toBe("Use Agent Hub before editing.");
  });
});
