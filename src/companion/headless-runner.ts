import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseHeadlessInvocation } from "../desktop/cli-invocation.js";
import { runCodexHook } from "./codex-hook.js";
import { runMcpBridge } from "./mcp-bridge.js";
import { WindowsDpapiProtector } from "./windows-dpapi.js";

export async function runHeadlessRunner(argv = process.argv): Promise<number> {
  const invocation = parseHeadlessInvocation(argv);
  if (!invocation) throw new Error("Agent Hub headless runner requires an MCP bridge or Codex hook mode.");
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
