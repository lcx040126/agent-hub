import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { codexServerName, formatWindowsCommand, mergeCodexMcpConfig } from "./codex-config.js";

describe("mergeCodexMcpConfig", () => {
  it("adds an Agent Hub stdio bridge without embedding a token", () => {
    const result = mergeCodexMcpConfig("", {
      name: "agent_hub_1234",
      command: "C:\\Program Files\\Agent Hub\\Agent Hub.exe",
      args: ["C:\\Program Files\\Agent Hub\\resources\\app.asar\\dist\\companion\\headless-runner.js", "--mcp-bridge", "--connection-id", "1234"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
    const parsed = parse(result) as Record<string, unknown>;
    const servers = parsed.mcp_servers as Record<string, Record<string, unknown>>;

    expect(servers.agent_hub_1234).toMatchObject({
      command: "C:\\Program Files\\Agent Hub\\Agent Hub.exe",
      args: ["C:\\Program Files\\Agent Hub\\resources\\app.asar\\dist\\companion\\headless-runner.js", "--mcp-bridge", "--connection-id", "1234"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      enabled: true,
      required: false,
    });
    expect(result).not.toContain("member-token");
    expect(result).not.toContain("Bearer");
  });

  it("preserves unrelated configuration and other MCP servers", () => {
    const source = [
      'model = "gpt-example"',
      "",
      "[mcp_servers.docs]",
      'url = "https://developers.example/mcp"',
      "enabled = false",
      "",
    ].join("\n");
    const result = mergeCodexMcpConfig(source, {
      name: "agent_hub_abcd",
      command: "AgentHub.exe",
      args: ["--mcp-bridge", "--connection-id", "abcd"],
    });
    const parsed = parse(result) as Record<string, unknown>;
    const servers = parsed.mcp_servers as Record<string, Record<string, unknown>>;

    expect(parsed.model).toBe("gpt-example");
    expect(servers.docs).toEqual({ url: "https://developers.example/mcp", enabled: false });
    expect(servers.agent_hub_abcd.command).toBe("AgentHub.exe");
  });

  it("replaces only the selected Agent Hub entry", () => {
    const source = [
      "[mcp_servers.agent_hub_abcd]",
      'command = "old.exe"',
      'args = ["old"]',
      "",
      "[mcp_servers.other]",
      'command = "other.exe"',
      "",
    ].join("\n");
    const result = mergeCodexMcpConfig(source, {
      name: "agent_hub_abcd",
      command: "new.exe",
      args: ["--mcp-bridge", "--connection-id", "abcd"],
    });
    const parsed = parse(result) as Record<string, unknown>;
    const servers = parsed.mcp_servers as Record<string, Record<string, unknown>>;

    expect(servers.agent_hub_abcd.command).toBe("new.exe");
    expect(servers.other.command).toBe("other.exe");
  });

  it("rejects malformed TOML without producing replacement output", () => {
    expect(() =>
      mergeCodexMcpConfig("[mcp_servers", {
        name: "agent_hub_abcd",
        command: "AgentHub.exe",
        args: [],
      }),
    ).toThrow();
  });

  it("installs four idempotent lifecycle hooks while preserving user hooks", () => {
    const source = [
      "[[hooks.PreToolUse]]",
      'matcher = "^custom$"',
      "[[hooks.PreToolUse.hooks]]",
      'type = "command"',
      'command = "custom-check.exe"',
      "",
    ].join("\n");
    const spec = {
      name: "agent_hub_abcd",
      command: "AgentHub.exe",
      args: ["--mcp-bridge", "--connection-id", "abcd"],
      hookCommand: "C:\\Program Files\\Agent Hub\\Agent Hub.exe",
      hookArgs: [],
    };
    const once = mergeCodexMcpConfig(source, spec);
    const twice = mergeCodexMcpConfig(once, spec);
    const parsed = parse(twice) as Record<string, unknown>;
    const hooks = parsed.hooks as Record<string, Array<Record<string, unknown>>>;
    const preHandlers = hooks.PreToolUse.flatMap(
      (group) => group.hooks as Array<Record<string, unknown>>,
    );

    expect((parsed.features as Record<string, unknown>).hooks).toBe(true);
    expect(Object.keys(hooks)).toEqual(
      expect.arrayContaining(["SessionStart", "PreToolUse", "PostToolUse", "SessionEnd"]),
    );
    expect(preHandlers.filter((handler) => handler.command === "custom-check.exe")).toHaveLength(1);
    expect(
      preHandlers.filter((handler) => String(handler.command).includes("--codex-hook PreToolUse")),
    ).toHaveLength(1);
    expect(hooks.PreToolUse.at(-1)?.matcher).toBe("^(Bash|apply_patch)$");
    expect(hooks.PostToolUse.at(-1)?.matcher).toBe("^(Bash|apply_patch)$");
    expect((hooks.PostToolUse.at(-1)?.hooks as Array<Record<string, unknown>>)[0].async).toBeUndefined();
    expect(twice).not.toContain("member-token");
  });
});

describe("codexServerName", () => {
  it("creates a stable safe TOML key", () => {
    expect(codexServerName("2E5A-6F9C-1000")).toBe("agent_hub_2e5a6f9c1000");
  });
});

describe("formatWindowsCommand", () => {
  it("quotes executable paths without placing secrets in the command", () => {
    expect(
      formatWindowsCommand("C:\\Program Files\\Agent Hub\\Agent Hub.exe", [
        "--codex-hook",
        "SessionStart",
      ]),
    ).toBe('"C:\\Program Files\\Agent Hub\\Agent Hub.exe" --codex-hook SessionStart');
  });
});
