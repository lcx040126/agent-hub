import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseHeadlessInvocation } from "../desktop/cli-invocation.js";
import { AGENT_HUB_VERSION } from "../shared/version.js";
import { extractWriteIntent, runCodexHook } from "./codex-hook.js";
import { createMcpProxyServer, runMcpBridge } from "./mcp-bridge.js";
import { WindowsDpapiProtector } from "./windows-dpapi.js";

export interface LocalIntegrationHealth {
  status: "ok";
  version: string;
  mcpBridge: "ok";
  codexHook: "ok";
}

export async function runHeadlessRunner(
  argv = process.argv,
  stdout: Writable = process.stdout,
): Promise<number> {
  const invocation = parseHeadlessInvocation(argv);
  if (!invocation) throw new Error("Agent Hub headless runner requires an MCP bridge or Codex hook mode.");
  if (invocation.mode === "health-probe") {
    stdout.write(`${JSON.stringify(await probeLocalIntegration())}\n`);
    return 0;
  }
  const userDataPath = argumentValue(argv, "--user-data");
  const protector = new WindowsDpapiProtector();
  if (invocation.mode === "mcp-bridge") {
    await runMcpBridge({
      connectionId: invocation.connectionId,
      userDataPath,
      protector,
    });
    return 0;
  }
  return runCodexHook({
    eventName: invocation.eventName,
    userDataPath,
    cwd: process.cwd(),
    protector,
  });
}

export async function probeLocalIntegration(): Promise<LocalIntegrationHealth> {
  const sentinelTool = "agent_hub_health_probe";
  const server = createMcpProxyServer({
    getInstructions: () => "Agent Hub local integration health probe.",
    listTools: async () => ({
      tools: [{
        name: sentinelTool,
        description: "Verifies the local MCP bridge handshake.",
        inputSchema: { type: "object" as const, properties: {} },
      }],
    }),
    callTool: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  });
  const client = new Client(
    { name: "agent-hub-health-probe", version: AGENT_HUB_VERSION },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === sentinelTool)) {
      throw new Error("The MCP bridge did not expose its health sentinel tool.");
    }
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }

  const hookIntent = extractWriteIntent("apply_patch", {
    command: [
      "*** Begin Patch",
      "*** Update File: health-probe.ts",
      "@@",
      "-before",
      "+after",
      "*** End Patch",
    ].join("\n"),
  });
  if (!hookIntent.writes || !hookIntent.pathCandidates.includes("health-probe.ts")) {
    throw new Error("The Codex Hook could not parse a minimal apply_patch write intent.");
  }

  return {
    status: "ok",
    version: AGENT_HUB_VERSION,
    mcpBridge: "ok",
    codexHook: "ok",
  };
}

function argumentValue(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1]?.trim() : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  runHeadlessRunner()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`Agent Hub: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    });
}
