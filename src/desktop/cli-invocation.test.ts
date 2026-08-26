import { describe, expect, it } from "vitest";
import { parseHeadlessInvocation } from "./cli-invocation.js";

describe("parseHeadlessInvocation", () => {
  it("returns null for the desktop UI mode", () => {
    expect(parseHeadlessInvocation(["AgentHub.exe", "--no-tray"])).toBeNull();
  });

  it("parses the saved connection for the stdio MCP bridge", () => {
    expect(
      parseHeadlessInvocation([
        "AgentHub.exe",
        "--mcp-bridge",
        "--connection-id",
        "connection-123",
      ]),
    ).toEqual({ mode: "mcp-bridge", connectionId: "connection-123" });
  });

  it("parses each supported Codex hook event", () => {
    for (const eventName of ["SessionStart", "PreToolUse", "PostToolUse", "SessionEnd"] as const) {
      expect(parseHeadlessInvocation(["AgentHub.exe", "--codex-hook", eventName])).toEqual({
        mode: "codex-hook",
        eventName,
      });
    }
  });

  it("parses the isolated local integration health probe", () => {
    expect(parseHeadlessInvocation(["AgentHub.exe", "--health-probe"])).toEqual({
      mode: "health-probe",
    });
  });

  it("rejects incomplete, unknown, or conflicting modes", () => {
    expect(() => parseHeadlessInvocation(["AgentHub.exe", "--mcp-bridge"])).toThrow(
      /connection-id/i,
    );
    expect(() => parseHeadlessInvocation(["AgentHub.exe", "--codex-hook", "Unknown"])).toThrow(
      /hook event/i,
    );
    expect(() =>
      parseHeadlessInvocation([
        "AgentHub.exe",
        "--mcp-bridge",
        "--connection-id",
        "one",
        "--codex-hook",
        "SessionStart",
      ]),
    ).toThrow(/same process/i);
    expect(() =>
      parseHeadlessInvocation([
        "AgentHub.exe",
        "--health-probe",
        "--codex-hook",
        "SessionStart",
      ]),
    ).toThrow(/same process/i);
  });
});
