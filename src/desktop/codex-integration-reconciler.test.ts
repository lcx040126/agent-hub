import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatWindowsCommand } from "./codex-config.js";
import {
  codexHookLauncher,
  reconcileDesktopCodexIntegrations,
  reconcileDesktopCodexIntegrationsAtStartup,
  withDesktopCodexIntegrationLifecycle,
} from "./codex-integration-reconciler.js";
import type { SavedRoomConnection } from "./contracts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("desktop Codex integration reconciliation", () => {
  it("adopts a legacy MCP entry and replaces the 60 second SessionEnd hook", async () => {
    const directory = await temporaryDirectory();
    const userDataPath = path.join(directory, "user-data");
    const configPath = path.join(directory, ".codex", "config.toml");
    const connection = savedConnection("legacy-room", undefined);
    const store = memoryStore([connection]);
    const launcher = codexHookLauncher(userDataPath);
    const oldHookCommand = formatWindowsCommand(launcher.command, [
      ...launcher.args,
      "--codex-hook",
      "SessionEnd",
    ]);
    const oldRunner = path.join(directory, "old", "dist", "companion", "headless-runner.js");
    const source = [
      'model = "gpt-example"',
      "",
      "[mcp_servers.agent_hub_legacyroom]",
      `command = ${JSON.stringify(path.join(directory, "old", "Agent Hub.exe"))}`,
      `args = ${JSON.stringify([oldRunner, "--user-data", userDataPath, "--mcp-bridge", "--connection-id", connection.id])}`,
      "enabled = true",
      "[mcp_servers.agent_hub_legacyroom.env]",
      'ELECTRON_RUN_AS_NODE = "1"',
      "",
      "[[hooks.SessionEnd]]",
      "[[hooks.SessionEnd.hooks]]",
      'type = "command"',
      `command = ${JSON.stringify(oldHookCommand)}`,
      `commandWindows = ${JSON.stringify(oldHookCommand)}`,
      "timeout = 60",
      "",
      "[[hooks.SessionEnd]]",
      "[[hooks.SessionEnd.hooks]]",
      'type = "command"',
      'command = "custom-session-end.exe"',
      "timeout = 2",
      "",
    ].join("\n");
    await writeConfig(configPath, source);

    const result = await reconcileDesktopCodexIntegrations({
      store,
      configPath,
      userDataPath,
      electronExecutable: path.join(directory, "Agent Hub.exe"),
      runnerPath: path.join(directory, "current", "dist", "companion", "headless-runner.js"),
    });

    expect(result.changed).toBe(true);
    expect(result.adoptedLegacyConnectionIds).toEqual([connection.id]);
    expect(store.connections[0]?.codexIntegrationInstalled).toBe(true);
    expect(result.backupPath && await readFile(result.backupPath, "utf8")).toBe(source);
    await expect(readFile(result.launcherPath!, "utf8")).resolves.toContain("$env:ELECTRON_RUN_AS_NODE = '1'");

    const parsed = parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(parsed.model).toBe("gpt-example");
    const servers = parsed.mcp_servers as Record<string, Record<string, unknown>>;
    expect(servers.agent_hub_legacyroom.command).toBe(path.join(directory, "Agent Hub.exe"));
    const groups = (parsed.hooks as Record<string, Array<Record<string, unknown>>>).SessionEnd;
    const handlers = groups.flatMap((group) => group.hooks as Array<Record<string, unknown>>);
    expect(handlers.filter((handler) => String(handler.command).includes("--codex-hook SessionEnd")))
      .toEqual([expect.objectContaining({ timeout: 3 })]);
    expect(handlers).toContainEqual(expect.objectContaining({ command: "custom-session-end.exe" }));
  });

  it("restores a missing config for a previously installed connection", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, ".codex", "config.toml");
    const store = memoryStore([savedConnection("installed-room", true)]);

    const result = await reconcileDesktopCodexIntegrations({
      store,
      configPath,
      userDataPath: path.join(directory, "user-data"),
      electronExecutable: path.join(directory, "Agent Hub.exe"),
      runnerPath: path.join(directory, "dist", "companion", "headless-runner.js"),
    });

    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeUndefined();
    expect(result.installedConnectionIds).toEqual(["installed-room"]);
    const parsed = parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect((parsed.mcp_servers as Record<string, unknown>).agent_hub_installedroom).toBeDefined();
  });

  it("does not install Codex integration for a connection without prior authorization", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, ".codex", "config.toml");
    const userDataPath = path.join(directory, "user-data");
    const store = memoryStore([savedConnection("not-installed", false)]);

    const result = await reconcileDesktopCodexIntegrations({
      store,
      configPath,
      userDataPath,
      electronExecutable: path.join(directory, "Agent Hub.exe"),
      runnerPath: path.join(directory, "dist", "companion", "headless-runner.js"),
    });

    expect(result.changed).toBe(false);
    expect(result.installedConnectionIds).toEqual([]);
    await expect(stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(codexHookLauncher(userDataPath).path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves an ambiguous same-name MCP when the connection was never installed", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, ".codex", "config.toml");
    const source = [
      "[mcp_servers.agent_hub_notinstalled]",
      'command = "user-owned.exe"',
      'args = ["runner.js", "--mcp-bridge", "--connection-id", "not-installed"]',
      "",
    ].join("\n");
    await writeConfig(configPath, source);

    const result = await reconcileDesktopCodexIntegrations({
      store: memoryStore([savedConnection("not-installed", false)]),
      configPath,
      userDataPath: path.join(directory, "user-data"),
      electronExecutable: path.join(directory, "Agent Hub.exe"),
      runnerPath: path.join(directory, "dist", "companion", "headless-runner.js"),
    });

    expect(result.changed).toBe(false);
    await expect(readFile(configPath, "utf8")).resolves.toBe(source);
  });

  it("removes one connection while retaining other authorized integrations", async () => {
    const directory = await temporaryDirectory();
    const options = {
      configPath: path.join(directory, ".codex", "config.toml"),
      userDataPath: path.join(directory, "user-data"),
      electronExecutable: path.join(directory, "Agent Hub.exe"),
      runnerPath: path.join(directory, "dist", "companion", "headless-runner.js"),
    };
    const store = memoryStore([
      savedConnection("room-a", true),
      savedConnection("room-b", true),
    ]);
    await reconcileDesktopCodexIntegrations({ store, ...options });

    const result = await reconcileDesktopCodexIntegrations({
      store,
      ...options,
      removeConnectionId: "room-a",
    });

    expect(result.installedConnectionIds).toEqual(["room-b"]);
    const parsed = parse(await readFile(options.configPath, "utf8")) as Record<string, unknown>;
    const servers = parsed.mcp_servers as Record<string, unknown>;
    expect(servers.agent_hub_rooma).toBeUndefined();
    expect(servers.agent_hub_roomb).toBeDefined();
  });

  it("reports malformed user TOML without blocking startup or changing the file", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, ".codex", "config.toml");
    const source = "[mcp_servers";
    await writeConfig(configPath, source);
    const onError = vi.fn();
    const onChanged = vi.fn();

    const result = await reconcileDesktopCodexIntegrationsAtStartup({
      store: memoryStore([savedConnection("installed-room", true)]),
      configPath,
      userDataPath: path.join(directory, "user-data"),
      electronExecutable: path.join(directory, "Agent Hub.exe"),
      runnerPath: path.join(directory, "dist", "companion", "headless-runner.js"),
      onError,
      onChanged,
    });

    expect(result).toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
    expect(onChanged).not.toHaveBeenCalled();
    await expect(readFile(configPath, "utf8")).resolves.toBe(source);
  });

  it("persists install intent before a config failure so startup can retry", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, ".codex", "config.toml");
    await writeConfig(configPath, "[mcp_servers");
    const store = memoryStore([savedConnection("install-room", false)]);

    await expect(reconcileDesktopCodexIntegrations({
      store,
      configPath,
      userDataPath: path.join(directory, "user-data"),
      electronExecutable: path.join(directory, "Agent Hub.exe"),
      runnerPath: path.join(directory, "dist", "companion", "headless-runner.js"),
      installConnectionId: "install-room",
    })).rejects.toThrow();

    expect(store.connections[0]?.codexIntegrationInstalled).toBe(true);
    await expect(readFile(configPath, "utf8")).resolves.toBe("[mcp_servers");
  });

  it("persists removal intent and does not resurrect the MCP after an interrupted delete", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, ".codex", "config.toml");
    const userDataPath = path.join(directory, "user-data");
    const electronExecutable = path.join(directory, "Agent Hub.exe");
    const runnerPath = path.join(directory, "old", "dist", "companion", "headless-runner.js");
    const store = memoryStore([savedConnection("remove-room", true)]);
    await writeConfig(configPath, "[mcp_servers");

    await expect(reconcileDesktopCodexIntegrations({
      store,
      configPath,
      userDataPath,
      electronExecutable,
      runnerPath,
      removeConnectionId: "remove-room",
    })).rejects.toThrow();
    expect(store.connections[0]?.codexIntegrationInstalled).toBe(false);

    await writeConfig(configPath, managedMcpSource({
      connectionId: "remove-room",
      electronExecutable,
      runnerPath,
      userDataPath,
    }));
    const recovered = await reconcileDesktopCodexIntegrations({
      store,
      configPath,
      userDataPath,
      electronExecutable,
      runnerPath,
    });

    expect(recovered.adoptedLegacyConnectionIds).toEqual([]);
    expect(recovered.installedConnectionIds).toEqual([]);
    expect(store.connections[0]?.codexIntegrationInstalled).toBe(false);
    const parsed = parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    expect(parsed.mcp_servers).toBeUndefined();
  });

  it("serializes complete install and delete lifecycles", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const first = withDesktopCodexIntegrationLifecycle(async () => {
      events.push("delete:start");
      firstStarted();
      await firstMayFinish;
      events.push("delete:end");
    });
    await firstDidStart;
    const second = withDesktopCodexIntegrationLifecycle(async () => {
      events.push("install:start");
      events.push("install:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["delete:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["delete:start", "delete:end", "install:start", "install:end"]);
  });
});

function savedConnection(
  id: string,
  codexIntegrationInstalled: boolean | undefined,
): SavedRoomConnection {
  return {
    id,
    serverUrl: "http://127.0.0.1:4173",
    repositoryPath: "C:\\repository",
    memberName: "Member",
    memberRole: "member",
    integrationEnabled: true,
    codexIntegrationInstalled,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

function memoryStore(initial: SavedRoomConnection[]) {
  const connections = initial.map((connection) => ({ ...connection }));
  return {
    connections,
    async list() {
      return connections.map((connection) => ({ ...connection }));
    },
    async setCodexIntegrationInstalled(connectionId: string, installed: boolean) {
      const connection = connections.find((candidate) => candidate.id === connectionId);
      if (!connection) throw new Error("missing connection");
      connection.codexIntegrationInstalled = installed;
      return { ...connection };
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-codex-reconcile-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeConfig(configPath: string, source: string): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, source, "utf8");
}

function managedMcpSource(options: {
  connectionId: string;
  electronExecutable: string;
  runnerPath: string;
  userDataPath: string;
}): string {
  const name = `agent_hub_${options.connectionId.replace(/[^a-z0-9_]/g, "")}`;
  return [
    `[mcp_servers.${name}]`,
    `command = ${JSON.stringify(options.electronExecutable)}`,
    `args = ${JSON.stringify([
      options.runnerPath,
      "--user-data",
      options.userDataPath,
      "--mcp-bridge",
      "--connection-id",
      options.connectionId,
    ])}`,
    `[mcp_servers.${name}.env]`,
    'ELECTRON_RUN_AS_NODE = "1"',
    "",
  ].join("\n");
}
