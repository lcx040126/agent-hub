import type { Readable, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsRequest,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { SecretProtector } from "../desktop/connection-store.js";
import { AGENT_HUB_VERSION } from "../shared/version.js";
import { resolveConnectionById } from "./connection-runtime.js";

export interface RunMcpBridgeOptions {
  connectionId: string;
  userDataPath: string;
  protector?: SecretProtector;
  stdin?: Readable;
  stdout?: Writable;
  fetchImpl?: typeof fetch;
}

interface RemoteMcpTools {
  getInstructions(): string | undefined;
  listTools(params?: ListToolsRequest["params"]): Promise<ListToolsResult>;
  callTool(params: CallToolRequest["params"]): Promise<CallToolResult | { toolResult: unknown }>;
}

export function createMcpProxyServer(remote: RemoteMcpTools): Server {
  const server = new Server(
    { name: "agent-hub-local-bridge", version: AGENT_HUB_VERSION },
    {
      capabilities: { tools: {} },
      instructions: remote.getInstructions(),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, (request) => remote.listTools(request.params));
  server.setRequestHandler(CallToolRequestSchema, (request) => remote.callTool(request.params));
  return server;
}

export async function runMcpBridge(options: RunMcpBridgeOptions): Promise<void> {
  if (!options.connectionId.trim()) throw new Error("An Agent Hub connection ID is required.");
  const resolved = await resolveConnectionById(
    options.userDataPath,
    options.connectionId.trim(),
    options.protector,
  );
  const endpoint = new URL(`${resolved.connection.serverUrl.replace(/\/+$/, "")}/mcp`);
  const remoteTransport = new StreamableHTTPClientTransport(endpoint, {
    fetch: options.fetchImpl,
    requestInit: {
      headers: { Authorization: `Bearer ${resolved.memberToken}` },
    },
  });
  const remoteClient = new Client(
    { name: "agent-hub-desktop-bridge", version: AGENT_HUB_VERSION },
    { capabilities: {} },
  );
  await remoteClient.connect(remoteTransport);

  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const localTransport = new StdioServerTransport(input, output);
  const localServer = createMcpProxyServer(remoteClient as RemoteMcpTools);
  const closed = streamClosed(input);

  try {
    await localServer.connect(localTransport);
    await closed;
  } finally {
    await localServer.close().catch(() => undefined);
    await remoteClient.close().catch(() => undefined);
  }
}

function streamClosed(stream: Readable): Promise<void> {
  if (stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("end", finish);
      stream.off("close", finish);
      stream.off("error", fail);
    };
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", fail);
  });
}
