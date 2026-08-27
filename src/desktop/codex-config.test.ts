import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexServerName,
  formatWindowsCommand,
  installCodexMcpConfig,
  mergeCodexMcpConfig,
  reconcileCodexConfig,
  reconcileCodexConfigFile,
  removeCodexMcpConfig,
  uninstallCodexMcpConfig,
  type CodexMcpRemovalSpec,
} from "./codex-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const MANAGED_COMMAND = "AgentHub.exe";
const MANAGED_HOOK_COMMAND = "AgentHubHook.exe";
const MANAGED_RUNNER = "C:\\Program Files\\Agent Hub\\resources\\app.asar\\dist\\companion\\headless-runner.js";
const MANAGED_USER_DATA = "C:\\Users\\Member\\AppData\\Roaming\\agent-hub";

function managedArgs(connectionId: string): string[] {
  return [
    MANAGED_RUNNER,
    "--user-data",
    MANAGED_USER_DATA,
    "--mcp-bridge",
    "--connection-id",
    connectionId,
  ];
}

function managedInstallSpec(connectionId: string) {
  return {
    name: codexServerName(connectionId),
    command: MANAGED_COMMAND,
    args: managedArgs(connectionId),
    env: { ELECTRON_RUN_AS_NODE: "1" },
    hookCommand: MANAGED_HOOK_COMMAND,
    hookArgs: [],
  };
}

function managedRemovalSpec(connectionId: string): CodexMcpRemovalSpec {
  return {
    connectionId,
    command: MANAGED_COMMAND,
    args: managedArgs(connectionId),
    hookCommand: MANAGED_HOOK_COMMAND,
    hookArgs: [],
  };
}

function reconciliationSpec(connectionIds: string[]) {
  return {
    mcpServers: connectionIds.map(managedInstallSpec),
    managedMcpSignature: {
      executableName: MANAGED_COMMAND,
      userDataPath: MANAGED_USER_DATA,
    },
    hookCommand: MANAGED_HOOK_COMMAND,
    hookArgs: [],
  };
}

function managedServerSource(connectionId: string, command: string, args: string[]): string {
  return [
    `[mcp_servers.${codexServerName(connectionId)}]`,
    `command = ${JSON.stringify(command)}`,
    `args = ${JSON.stringify(args)}`,
    "",
  ].join("\n");
}

function canonicalServerExpectation(connectionId: string) {
  return {
    command: MANAGED_COMMAND,
    args: managedArgs(connectionId),
    enabled: true,
    required: false,
    startup_timeout_sec: 20,
    tool_timeout_sec: 120,
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-codex-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

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

  it("installs five idempotent lifecycle hooks while preserving user hooks", () => {
    const source = [
      "[[hooks.PreToolUse]]",
      'matcher = "^custom$"',
      "[[hooks.PreToolUse.hooks]]",
      'type = "command"',
      'command = "custom-check.exe"',
      "",
      "[[hooks.Stop]]",
      "[[hooks.Stop.hooks]]",
      'type = "command"',
      'command = "custom-stop.exe"',
      "timeout = 9",
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
      expect.arrayContaining(["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]),
    );
    expect(preHandlers.filter((handler) => handler.command === "custom-check.exe")).toHaveLength(1);
    expect(
      preHandlers.filter((handler) => String(handler.command).includes("--codex-hook PreToolUse")),
    ).toHaveLength(1);
    expect(hooks.PreToolUse.at(-1)?.matcher).toBe("^(Bash|apply_patch)$");
    expect(hooks.PostToolUse.at(-1)?.matcher).toBe("^(Bash|apply_patch)$");
    expect((hooks.PostToolUse.at(-1)?.hooks as Array<Record<string, unknown>>)[0].async).toBeUndefined();
    expect(hooks.Stop.some((group) =>
      (group.hooks as Array<Record<string, unknown>>).some((handler) => handler.command === "custom-stop.exe")))
      .toBe(true);
    expect(hooks.Stop.at(-1)?.matcher).toBeUndefined();
    expect((hooks.Stop.at(-1)?.hooks as Array<Record<string, unknown>>)[0].timeout).toBe(3);
    expect((hooks.SessionEnd.at(-1)?.hooks as Array<Record<string, unknown>>)[0].timeout).toBe(3);
    expect(twice).not.toContain("member-token");
  });
});

describe("reconcileCodexConfig", () => {
  it("upgrades the v0.2.2 SessionEnd handler from 60 seconds to one 3 second handler", () => {
    const current = mergeCodexMcpConfig("", managedInstallSpec("abcd"));
    const legacy = current.replace("timeout = 3", "timeout = 60");

    const reconciled = reconcileCodexConfig(legacy, reconciliationSpec(["abcd"]));
    const parsed = parse(reconciled.config) as Record<string, unknown>;
    const hooks = parsed.hooks as Record<string, Array<Record<string, unknown>>>;
    const handlers = hooks.SessionEnd.flatMap(
      (group) => group.hooks as Array<Record<string, unknown>>,
    );

    expect(reconciled.changed).toBe(true);
    expect(reconciled.managedHooksChanged).toBe(true);
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toMatchObject({
      type: "command",
      command: `${MANAGED_HOOK_COMMAND} --codex-hook SessionEnd`,
      commandWindows: `${MANAGED_HOOK_COMMAND} --codex-hook SessionEnd`,
      timeout: 3,
    });

    const repeated = reconcileCodexConfig(reconciled.config, reconciliationSpec(["abcd"]));
    expect(repeated.changed).toBe(false);
    expect(repeated.config).toBe(reconciled.config);
  });

  it("replaces managed handlers with wrong matchers or missing fields while preserving user hooks", () => {
    const source = [
      "[[hooks.SessionStart]]",
      'matcher = "^wrong$"',
      "[[hooks.SessionStart.hooks]]",
      `commandWindows = "${MANAGED_HOOK_COMMAND} --codex-hook SessionStart"`,
      "timeout = 90",
      "",
      "[[hooks.PreToolUse]]",
      'matcher = "^wrong$"',
      "[[hooks.PreToolUse.hooks]]",
      'type = "broken"',
      `command = "${MANAGED_HOOK_COMMAND} --codex-hook PreToolUse"`,
      'commandWindows = "stale.exe"',
      "",
      "[[hooks.PreToolUse]]",
      'matcher = "^custom$"',
      "[[hooks.PreToolUse.hooks]]",
      'type = "command"',
      'command = "custom-check.exe --codex-hook PreToolUse"',
      "",
    ].join("\n");

    const reconciled = reconcileCodexConfig(source, reconciliationSpec(["abcd"]));
    const parsed = parse(reconciled.config) as Record<string, unknown>;
    const hooks = parsed.hooks as Record<string, Array<Record<string, unknown>>>;
    const allHandlers = Object.values(hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks as Array<Record<string, unknown>>),
    );

    for (const event of ["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]) {
      const expected = `${MANAGED_HOOK_COMMAND} --codex-hook ${event}`;
      expect(allHandlers.filter((handler) => handler.command === expected)).toHaveLength(1);
    }
    expect(allHandlers.some((handler) => handler.command === "custom-check.exe --codex-hook PreToolUse"))
      .toBe(true);
  });

  it("removes a historical Agent Hub launcher invocation with stale flags and a quoted path", () => {
    const launcherPath = "C:\\Old Agent Hub\\codex\\agent-hub-headless.ps1";
    const hookArgs = ["-NoProfile", "-File", launcherPath];
    const oldCommand = [
      "powershell.exe",
      "-OldFlag",
      "-File",
      `"${launcherPath}"`,
      "--codex-hook",
      "SessionEnd",
    ].join(" ");
    const source = [
      "[[hooks.SessionEnd]]",
      "[[hooks.SessionEnd.hooks]]",
      'type = "command"',
      `command = ${JSON.stringify(oldCommand)}`,
      "timeout = 60",
      "",
    ].join("\n");

    const reconciled = reconcileCodexConfig(source, {
      ...reconciliationSpec(["abcd"]),
      hookCommand: "powershell.exe",
      hookArgs,
    });
    const parsed = parse(reconciled.config) as Record<string, unknown>;
    const handlers = (parsed.hooks as Record<string, Array<Record<string, unknown>>>).SessionEnd
      .flatMap((group) => group.hooks as Array<Record<string, unknown>>);

    expect(handlers.some((handler) => handler.command === oldCommand)).toBe(false);
    expect(handlers).toEqual([
      expect.objectContaining({
        command: formatWindowsCommand("powershell.exe", [
          ...hookArgs,
          "--codex-hook",
          "SessionEnd",
        ]),
        timeout: 3,
      }),
    ]);
  });

  it("preserves Hook commands that only resemble an Agent Hub launcher", () => {
    const launcherPath = "C:\\custom\\agent-hub-headless.ps1";
    const backupLauncher = "powershell.exe -File C:\\custom\\agent-hub-headless.ps1.backup --codex-hook SessionEnd";
    const extendedEvent = "powershell.exe -File C:\\custom\\agent-hub-headless.ps1 --codex-hook SessionEndExtra";
    const wrappedText = 'wrapper.exe "agent-hub-headless.ps1 --codex-hook SessionEnd"';
    const nonPowerShellLauncher = "custom-runner.exe -File C:\\custom\\agent-hub-headless.ps1 --codex-hook SessionEnd";
    const unterminatedCommand = 'powershell.exe -File C:\\custom\\agent-hub-headless.ps1 --codex-hook SessionEnd "';
    const similarCommands = [
      backupLauncher,
      extendedEvent,
      wrappedText,
      nonPowerShellLauncher,
      unterminatedCommand,
    ];
    const source = similarCommands.flatMap((command) => [
      "[[hooks.SessionEnd]]",
      "[[hooks.SessionEnd.hooks]]",
      'type = "command"',
      `command = ${JSON.stringify(command)}`,
      "timeout = 2",
      "",
    ]).join("\n");

    const reconciled = reconcileCodexConfig(source, {
      ...reconciliationSpec(["abcd"]),
      hookCommand: "powershell.exe",
      hookArgs: ["-File", launcherPath],
    });
    const parsed = parse(reconciled.config) as Record<string, unknown>;
    const handlers = (parsed.hooks as Record<string, Array<Record<string, unknown>>>).SessionEnd
      .flatMap((group) => group.hooks as Array<Record<string, unknown>>);

    for (const command of similarCommands) {
      expect(handlers.some((handler) => handler.command === command)).toBe(true);
    }
  });

  it("repairs desired MCPs, adds missing MCPs, removes proven orphans, and preserves ambiguous entries", () => {
    const oldRunner = "C:\\Old Agent Hub\\resources\\app.asar\\dist\\companion\\headless-runner.js";
    const source = [
      'model = "gpt-example"',
      "",
      "[mcp_servers.docs]",
      'url = "https://developers.example/mcp"',
      "enabled = false",
      "",
      "[mcp_servers.agent_hub_abcd]",
      `command = ${JSON.stringify(path.join("C:\\Old Agent Hub", MANAGED_COMMAND))}`,
      `args = ${JSON.stringify([oldRunner, "--user-data", MANAGED_USER_DATA, "--mcp-bridge", "--connection-id", "abcd"])}`,
      "[mcp_servers.agent_hub_abcd.env]",
      'ELECTRON_RUN_AS_NODE = "1"',
      "",
      "[mcp_servers.agent_hub_efgh]",
      `command = ${JSON.stringify(path.join("C:\\Old Agent Hub", MANAGED_COMMAND))}`,
      `args = ${JSON.stringify([oldRunner, "--user-data", MANAGED_USER_DATA, "--mcp-bridge", "--connection-id", "efgh"])}`,
      "[mcp_servers.agent_hub_efgh.env]",
      'ELECTRON_RUN_AS_NODE = "1"',
      "",
      "[mcp_servers.agent_hub_legacy]",
      'command = "user-owned.exe"',
      'args = ["runner.js", "--mcp-bridge", "--connection-id", "legacy"]',
      "",
      "[[hooks.PreToolUse]]",
      'matcher = "^custom$"',
      "[[hooks.PreToolUse.hooks]]",
      'type = "command"',
      'command = "custom-check.exe"',
      "",
    ].join("\n");

    const reconciled = reconcileCodexConfig(source, reconciliationSpec(["abcd", "ijkl"]));
    const parsed = parse(reconciled.config) as Record<string, unknown>;
    const servers = parsed.mcp_servers as Record<string, Record<string, unknown>>;
    const hooks = parsed.hooks as Record<string, Array<Record<string, unknown>>>;
    const preHandlers = hooks.PreToolUse.flatMap(
      (group) => group.hooks as Array<Record<string, unknown>>,
    );

    expect(reconciled.discoveredManagedConnectionIds).toEqual(["abcd", "efgh"]);
    expect(reconciled.updatedMcpServerNames).toEqual(["agent_hub_abcd", "agent_hub_ijkl"]);
    expect(reconciled.removedMcpServerNames).toEqual(["agent_hub_efgh"]);
    expect(servers.agent_hub_abcd).toMatchObject(canonicalServerExpectation("abcd"));
    expect(servers.agent_hub_ijkl).toMatchObject(canonicalServerExpectation("ijkl"));
    expect(servers.agent_hub_efgh).toBeUndefined();
    expect(servers.agent_hub_legacy.command).toBe("user-owned.exe");
    expect(servers.docs).toEqual({ url: "https://developers.example/mcp", enabled: false });
    expect(parsed.model).toBe("gpt-example");
    expect(preHandlers.some((handler) => handler.command === "custom-check.exe")).toBe(true);
  });

  it("preserves same-name MCPs that fail the executable, user-data, or environment signature", () => {
    const nearMatch = (name: string, command: string, userDataPath: string, includeEnv: boolean) => [
      `[mcp_servers.${name}]`,
      `command = ${JSON.stringify(command)}`,
      `args = ${JSON.stringify([MANAGED_RUNNER, "--user-data", userDataPath, "--mcp-bridge", "--connection-id", name.replace("agent_hub_", "")])}`,
      ...(includeEnv ? [
        `[mcp_servers.${name}.env]`,
        'ELECTRON_RUN_AS_NODE = "1"',
      ] : []),
      "",
    ];
    const source = [
      ...nearMatch("agent_hub_wrongcommand", "user-owned.exe", MANAGED_USER_DATA, true),
      ...nearMatch("agent_hub_wrongdata", MANAGED_COMMAND, "C:\\Other App", true),
      ...nearMatch("agent_hub_noenv", MANAGED_COMMAND, MANAGED_USER_DATA, false),
    ].join("\n");

    const reconciled = reconcileCodexConfig(source, reconciliationSpec([]));

    expect(reconciled.changed).toBe(false);
    expect(reconciled.discoveredManagedConnectionIds).toEqual([]);
    expect(reconciled.removedMcpServerNames).toEqual([]);
    expect(reconciled.config).toBe(source);
  });

  it("removes proven MCPs and shared managed hooks when the desired set is empty", () => {
    const source = mergeCodexMcpConfig("", managedInstallSpec("abcd"));

    const reconciled = reconcileCodexConfig(source, reconciliationSpec([]));
    const parsed = parse(reconciled.config) as Record<string, unknown>;

    expect(reconciled.removedMcpServerNames).toEqual(["agent_hub_abcd"]);
    expect(reconciled.managedHooksChanged).toBe(true);
    expect(parsed.mcp_servers).toBeUndefined();
    expect(parsed.hooks).toBeUndefined();
  });
});

describe("reconcileCodexConfigFile", () => {
  it("does not rewrite or back up an already reconciled config", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "config.toml");
    const source = reconcileCodexConfig("", reconciliationSpec(["abcd"])).config;
    await writeFile(configPath, source, "utf8");

    const result = await reconcileCodexConfigFile(configPath, reconciliationSpec(["abcd"]));

    expect(result.changed).toBe(false);
    expect(result.backupPath).toBeUndefined();
    expect(result.restartRequired).toBe(false);
    expect(await readFile(configPath, "utf8")).toBe(source);
    expect(await readdir(directory)).toEqual(["config.toml"]);
  });

  it("leaves malformed TOML untouched and creates no backup", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "config.toml");
    const source = "[mcp_servers";
    await writeFile(configPath, source, "utf8");

    await expect(reconcileCodexConfigFile(configPath, reconciliationSpec(["abcd"]))).rejects.toThrow();

    expect(await readFile(configPath, "utf8")).toBe(source);
    expect(await readdir(directory)).toEqual(["config.toml"]);
  });

  it("serializes concurrent mutations for the same config path", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "config.toml");
    await writeFile(configPath, 'model = "gpt-example"\n', "utf8");

    await Promise.all([
      installCodexMcpConfig(configPath, managedInstallSpec("abcd")),
      installCodexMcpConfig(configPath, managedInstallSpec("efgh")),
    ]);

    const parsed = parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const servers = parsed.mcp_servers as Record<string, unknown>;
    const files = await readdir(directory);
    expect(servers.agent_hub_abcd).toBeDefined();
    expect(servers.agent_hub_efgh).toBeDefined();
    expect(files.filter((file) => file.endsWith(".bak"))).toHaveLength(2);
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
  });

  it("re-reads and merges an external edit that arrives during replacement", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "config.toml");
    const padding = "x".repeat(1_000_000);
    await writeFile(configPath, `model = "before"\nnotes = ${JSON.stringify(padding)}\n`, "utf8");

    let injected = false;
    let pollError: unknown;
    const poll = setInterval(() => {
      if (injected || pollError) return;
      void readdir(directory).then(async (files) => {
        if (!files.some((file) => file.endsWith(".tmp")) || injected) return;
        injected = true;
        await writeFile(
          configPath,
          `model = "external"\nnotes = ${JSON.stringify(padding)}\n`,
          "utf8",
        );
      }).catch((error: unknown) => {
        pollError = error;
      });
    }, 0);

    try {
      await reconcileCodexConfigFile(configPath, reconciliationSpec(["abcd"]));
    } finally {
      clearInterval(poll);
    }

    if (pollError) throw pollError;
    expect(injected).toBe(true);
    const parsed = parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(parsed.model).toBe("external");
    expect((parsed.mcp_servers as Record<string, unknown>).agent_hub_abcd).toBeDefined();
  });

  it("recomputes a reconciliation resolver from the same retried file snapshot", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "config.toml");
    await writeFile(configPath, 'model = "before"\n', "utf8");
    const observedModels: string[] = [];

    await reconcileCodexConfigFile(configPath, async (source) => {
      const parsed = parse(source) as Record<string, unknown>;
      observedModels.push(String(parsed.model));
      if (observedModels.length === 1) {
        await writeFile(configPath, 'model = "external"\n', "utf8");
      }
      return reconciliationSpec(["abcd"]);
    });

    const parsed = parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(observedModels).toEqual(["before", "external"]);
    expect(parsed.model).toBe("external");
    expect((parsed.mcp_servers as Record<string, unknown>).agent_hub_abcd).toBeDefined();
  });

  it("retries when an external edit invalidates an apparent no-op snapshot", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "config.toml");
    const source = reconcileCodexConfig("", reconciliationSpec(["abcd"])).config;
    await writeFile(configPath, source, "utf8");
    let resolverCalls = 0;

    const result = await reconcileCodexConfigFile(configPath, async () => {
      resolverCalls += 1;
      if (resolverCalls === 1) await writeFile(configPath, 'model = "external"\n', "utf8");
      return reconciliationSpec(["abcd"]);
    });

    const parsed = parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(resolverCalls).toBe(2);
    expect(result.changed).toBe(true);
    expect(parsed.model).toBe("external");
    expect((parsed.mcp_servers as Record<string, unknown>).agent_hub_abcd).toBeDefined();
  });
});

describe("codexServerName", () => {
  it("creates a stable safe TOML key", () => {
    expect(codexServerName("2E5A-6F9C-1000")).toBe("agent_hub_2e5a6f9c1000");
  });
});

describe("removeCodexMcpConfig", () => {
  it("removes the exact target while preserving unrelated MCP servers and user hooks", () => {
    const source = mergeCodexMcpConfig([
      'model = "gpt-example"',
      "",
      "[mcp_servers.docs]",
      'url = "https://developers.example/mcp"',
      "enabled = false",
      "",
      "[[hooks.PreToolUse]]",
      'matcher = "^custom$"',
      "[[hooks.PreToolUse.hooks]]",
      'type = "command"',
      'command = "custom-check.exe"',
      "",
    ].join("\n"), managedInstallSpec("abcd"));

    const result = removeCodexMcpConfig(source, managedRemovalSpec("abcd"));
    const parsed = parse(result.config) as Record<string, unknown>;
    const servers = parsed.mcp_servers as Record<string, Record<string, unknown>>;
    const hooks = parsed.hooks as Record<string, Array<Record<string, unknown>>>;
    const preHandlers = hooks.PreToolUse.flatMap(
      (group) => group.hooks as Array<Record<string, unknown>>,
    );

    expect(result).toMatchObject({
      changed: true,
      mcpServerName: "agent_hub_abcd",
      removedMcpServer: true,
      removedManagedHooks: false,
    });
    expect(parsed.model).toBe("gpt-example");
    expect(servers.agent_hub_abcd).toBeUndefined();
    expect(servers.docs).toEqual({ url: "https://developers.example/mcp", enabled: false });
    expect(preHandlers.some((handler) => handler.command === "custom-check.exe")).toBe(true);
  });

  it.each([
    ["a different connection ID", ["runner.js", "--mcp-bridge", "--connection-id", "other"]],
    ["a missing connection ID", ["runner.js", "--mcp-bridge", "--connection-id"]],
  ])("leaves a target key with %s byte-for-byte unchanged", (_description, installedArgs) => {
    const source = managedServerSource("abcd", MANAGED_COMMAND, installedArgs);

    const result = removeCodexMcpConfig(source, managedRemovalSpec("abcd"));

    expect(result.changed).toBe(false);
    expect(result.removedMcpServer).toBe(false);
    expect(result.config).toBe(source);
  });

  it.each([
    ["a different command", "other.exe", managedArgs("abcd")],
    ["different bridge arguments", MANAGED_COMMAND, ["other-runner.js", "--mcp-bridge", "--connection-id", "abcd"]],
    ["no bridge marker", MANAGED_COMMAND, ["runner.js", "--connection-id", "abcd"]],
  ])("leaves a target with %s byte-for-byte unchanged", (_description, command, installedArgs) => {
    const source = managedServerSource("abcd", command, installedArgs);

    const result = removeCodexMcpConfig(source, managedRemovalSpec("abcd"));

    expect(result.changed).toBe(false);
    expect(result.config).toBe(source);
  });

  it("rejects malformed TOML", () => {
    expect(() => removeCodexMcpConfig("[mcp_servers", managedRemovalSpec("abcd"))).toThrow();
  });

  it("retains shared hooks when another Agent Hub MCP server remains", () => {
    const first = mergeCodexMcpConfig("", managedInstallSpec("abcd"));
    const source = mergeCodexMcpConfig(first, managedInstallSpec("efgh"));

    const result = removeCodexMcpConfig(source, {
      ...managedRemovalSpec("abcd"),
      removeManagedHooksWhenLastServer: true,
    });
    const parsed = parse(result.config) as Record<string, unknown>;
    const servers = parsed.mcp_servers as Record<string, Record<string, unknown>>;
    const hooks = parsed.hooks as Record<string, unknown>;

    expect(result.removedManagedHooks).toBe(false);
    expect(servers.agent_hub_abcd).toBeUndefined();
    expect(servers.agent_hub_efgh).toBeDefined();
    expect(Object.keys(hooks)).toEqual(
      expect.arrayContaining(["SessionStart", "PreToolUse", "PostToolUse", "Stop", "SessionEnd"]),
    );
  });

  it("conservatively retains shared hooks for an unknown Agent Hub entry", () => {
    const source = mergeCodexMcpConfig([
      "[mcp_servers.agent_hub_legacy]",
      'command = "legacy-agent-hub.exe"',
      'args = ["legacy-bridge"]',
      "",
    ].join("\n"), managedInstallSpec("abcd"));

    const result = removeCodexMcpConfig(source, {
      ...managedRemovalSpec("abcd"),
      removeManagedHooksWhenLastServer: true,
    });
    const parsed = parse(result.config) as Record<string, unknown>;

    expect(result.removedManagedHooks).toBe(false);
    expect((parsed.mcp_servers as Record<string, unknown>).agent_hub_legacy).toBeDefined();
    expect(parsed.hooks).toBeDefined();
  });

  it("removes only the five exact managed hook handlers with the last managed server", () => {
    const source = mergeCodexMcpConfig([
      "[[hooks.PreToolUse]]",
      'matcher = "^(Bash|apply_patch)$"',
      "[[hooks.PreToolUse.hooks]]",
      'type = "command"',
      'command = "custom-check.exe --codex-hook PreToolUse"',
      'commandWindows = "custom-check.exe --codex-hook PreToolUse"',
      "timeout = 20",
      "",
      "[[hooks.SessionEnd]]",
      "[[hooks.SessionEnd.hooks]]",
      'type = "command"',
      'command = "custom-session-end.exe --codex-hook SessionEnd"',
      'commandWindows = "custom-session-end.exe --codex-hook SessionEnd"',
      "timeout = 61",
      "",
    ].join("\n"), managedInstallSpec("abcd"));

    const result = removeCodexMcpConfig(source, {
      ...managedRemovalSpec("abcd"),
      removeManagedHooksWhenLastServer: true,
    });
    const parsed = parse(result.config) as Record<string, unknown>;
    const hooks = parsed.hooks as Record<string, Array<Record<string, unknown>>>;
    const allHandlers = Object.values(hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks as Array<Record<string, unknown>>),
    );

    expect(result.removedManagedHooks).toBe(true);
    expect(parsed.mcp_servers).toBeUndefined();
    expect((parsed.features as Record<string, unknown>).hooks).toBe(true);
    expect(allHandlers).toHaveLength(2);
    expect(allHandlers.map((handler) => handler.command)).toEqual(
      expect.arrayContaining([
        "custom-check.exe --codex-hook PreToolUse",
        "custom-session-end.exe --codex-hook SessionEnd",
      ]),
    );
  });
});

describe("uninstallCodexMcpConfig", () => {
  it("backs up the original file and atomically writes the cleaned config", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "config.toml");
    const source = mergeCodexMcpConfig('model = "gpt-example"\n', managedInstallSpec("abcd"));
    await writeFile(configPath, source, "utf8");

    const result = await uninstallCodexMcpConfig(configPath, managedRemovalSpec("abcd"));
    const current = await readFile(configPath, "utf8");
    const files = await readdir(directory);

    expect(result).toMatchObject({
      configPath,
      changed: true,
      removedMcpServer: true,
      removedManagedHooks: false,
      restartRequired: true,
    });
    expect(result.backupPath).toMatch(/\.agent-hub-.*\.bak$/);
    expect(await readFile(result.backupPath!, "utf8")).toBe(source);
    expect((parse(current) as Record<string, unknown>).mcp_servers).toBeUndefined();
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
  });

  it("does not create a backup or rewrite the file when no exact match exists", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "config.toml");
    const source = managedServerSource("abcd", "user-owned.exe", managedArgs("abcd"));
    await writeFile(configPath, source, "utf8");

    const result = await uninstallCodexMcpConfig(configPath, managedRemovalSpec("abcd"));

    expect(result).toMatchObject({
      changed: false,
      removedMcpServer: false,
      removedManagedHooks: false,
      restartRequired: false,
    });
    expect(result.backupPath).toBeUndefined();
    expect(await readFile(configPath, "utf8")).toBe(source);
    expect(await readdir(directory)).toEqual(["config.toml"]);
  });

  it("leaves a malformed file untouched and creates no backup", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "config.toml");
    const source = "[mcp_servers";
    await writeFile(configPath, source, "utf8");

    await expect(uninstallCodexMcpConfig(configPath, managedRemovalSpec("abcd"))).rejects.toThrow();

    expect(await readFile(configPath, "utf8")).toBe(source);
    expect(await readdir(directory)).toEqual(["config.toml"]);
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
