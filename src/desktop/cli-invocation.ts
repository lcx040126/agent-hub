export type CodexHookEventName = "SessionStart" | "PreToolUse" | "PostToolUse" | "SessionEnd";

export type HeadlessInvocation =
  | { mode: "mcp-bridge"; connectionId: string }
  | { mode: "codex-hook"; eventName: CodexHookEventName }
  | { mode: "health-probe" };

const HOOK_EVENTS = new Set<CodexHookEventName>([
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "SessionEnd",
]);

export function parseHeadlessInvocation(argv: string[]): HeadlessInvocation | null {
  const bridgeIndex = argv.indexOf("--mcp-bridge");
  const hookIndex = argv.indexOf("--codex-hook");
  const healthIndex = argv.indexOf("--health-probe");
  if ([bridgeIndex, hookIndex, healthIndex].filter((index) => index >= 0).length > 1) {
    throw new Error(
      "Agent Hub cannot run the MCP bridge, a Codex hook, or a health probe in the same process.",
    );
  }
  if (healthIndex >= 0) return { mode: "health-probe" };
  if (bridgeIndex >= 0) {
    const connectionIndex = argv.indexOf("--connection-id", bridgeIndex + 1);
    const connectionId = connectionIndex >= 0 ? argv[connectionIndex + 1]?.trim() : undefined;
    if (!connectionId || connectionId.startsWith("--")) {
      throw new Error("The MCP bridge requires --connection-id <saved-connection-id>.");
    }
    return { mode: "mcp-bridge", connectionId };
  }
  if (hookIndex >= 0) {
    const eventName = argv[hookIndex + 1] as CodexHookEventName | undefined;
    if (!eventName || !HOOK_EVENTS.has(eventName)) {
      throw new Error(
        "The Codex hook event must be SessionStart, PreToolUse, PostToolUse, or SessionEnd.",
      );
    }
    return { mode: "codex-hook", eventName };
  }
  return null;
}
