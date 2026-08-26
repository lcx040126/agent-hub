import { copyFile, mkdir, readFile, rename, stat, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { parse, stringify, type TomlTable, type TomlValue } from "smol-toml";

export interface CodexMcpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  hookCommand?: string;
  hookArgs?: string[];
}

export interface InstalledCodexConfig {
  configPath: string;
  backupPath?: string;
  mcpServerName: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  restartRequired: true;
}

export function codexServerName(connectionId: string): string {
  const suffix = connectionId.toLocaleLowerCase("en-US").replace(/[^a-z0-9_]/g, "").slice(0, 24);
  if (!suffix) throw new Error("A valid connection ID is required.");
  return `agent_hub_${suffix}`;
}

export function mergeCodexMcpConfig(source: string, spec: CodexMcpServerSpec): string {
  if (!/^[A-Za-z0-9_-]+$/.test(spec.name)) {
    throw new Error("The MCP server name may only contain letters, numbers, underscores, and hyphens.");
  }
  if (!spec.command.trim()) throw new Error("The MCP bridge command is required.");
  if (spec.args.some((argument) => typeof argument !== "string")) {
    throw new Error("Every MCP bridge argument must be a string.");
  }
  if (spec.env && Object.entries(spec.env).some(
    ([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string",
  )) {
    throw new Error("Every MCP bridge environment variable must have a valid name and string value.");
  }

  const root = source.trim() ? (parse(source) as TomlTable) : {};
  const existingServers = root.mcp_servers;
  const servers = existingServers === undefined ? {} : requireTable(existingServers, "mcp_servers");
  servers[spec.name] = {
    command: spec.command,
    args: [...spec.args],
    enabled: true,
    required: false,
    startup_timeout_sec: 20,
    tool_timeout_sec: 120,
    ...(spec.env ? { env: { ...spec.env } } : {}),
  };
  root.mcp_servers = servers;
  if (spec.hookCommand) {
    mergeAgentHubHooks(root, spec.hookCommand, spec.hookArgs ?? []);
  }
  return `${stringify(root).trimEnd()}\n`;
}

export async function installCodexMcpConfig(
  configPath: string,
  spec: CodexMcpServerSpec,
): Promise<InstalledCodexConfig> {
  let source = "";
  let existing = false;
  try {
    source = await readFile(configPath, "utf8");
    existing = true;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  // Parse and merge before creating a backup or touching the user's live config.
  const merged = mergeCodexMcpConfig(source, spec);
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await restrictPermissions(path.dirname(configPath), 0o700);

  let backupPath: string | undefined;
  if (existing) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = `${configPath}.agent-hub-${timestamp}.bak`;
    await copyFile(configPath, backupPath);
    await restrictPermissions(backupPath, 0o600);
  }

  const temporaryPath = `${configPath}.agent-hub-${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, merged, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, configPath);
    await restrictPermissions(configPath, 0o600);
  } catch (error) {
    await removeTemporaryFile(temporaryPath);
    throw error;
  }

  return {
    configPath,
    backupPath,
    mcpServerName: spec.name,
    command: spec.command,
    args: [...spec.args],
    env: spec.env ? { ...spec.env } : undefined,
    restartRequired: true,
  };
}

function requireTable(value: TomlValue, name: string): TomlTable {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The existing ${name} value is not a TOML table.`);
  }
  return value as TomlTable;
}

function mergeAgentHubHooks(root: TomlTable, command: string, prefixArgs: string[]): void {
  const existingHooks = root.hooks;
  const hooks = existingHooks === undefined ? {} : requireTable(existingHooks, "hooks");
  const features = root.features === undefined ? {} : requireTable(root.features, "features");
  features.hooks = true;
  root.features = features;

  const definitions: Array<{
    event: "SessionStart" | "PreToolUse" | "PostToolUse" | "SessionEnd";
    matcher?: string;
    timeout: number;
  }> = [
    { event: "SessionStart", matcher: "^(startup|resume|clear|compact)$", timeout: 10 },
    { event: "PreToolUse", matcher: "^(Bash|apply_patch)$", timeout: 20 },
    { event: "PostToolUse", matcher: "^(Bash|apply_patch)$", timeout: 20 },
    { event: "SessionEnd", timeout: 3 },
  ];

  for (const definition of definitions) {
    const currentGroups = hooks[definition.event];
    const groups = currentGroups === undefined
      ? []
      : requireTableArray(currentGroups, `hooks.${definition.event}`);
    const preserved = removeManagedHookHandlers(groups);
    const hookCommand = formatWindowsCommand(command, [
      ...prefixArgs,
      "--codex-hook",
      definition.event,
    ]);
    const handler: TomlTable = {
      type: "command",
      command: hookCommand,
      commandWindows: hookCommand,
      timeout: definition.timeout,
    };
    const group: TomlTable = { hooks: [handler] };
    if (definition.matcher) group.matcher = definition.matcher;
    preserved.push(group);
    hooks[definition.event] = preserved;
  }
  root.hooks = hooks;
}

function removeManagedHookHandlers(groups: TomlTable[]): TomlTable[] {
  const result: TomlTable[] = [];
  for (const group of groups) {
    const rawHandlers = group.hooks;
    if (rawHandlers === undefined) {
      result.push(group);
      continue;
    }
    const handlers = requireTableArray(rawHandlers, "hook handlers").filter((handler) => {
      const command = handler.command;
      const windowsCommand = handler.commandWindows ?? handler.command_windows;
      return ![command, windowsCommand].some(
        (value) => typeof value === "string" && value.includes("--codex-hook"),
      );
    });
    if (handlers.length > 0) result.push({ ...group, hooks: handlers });
  }
  return result;
}

function requireTableArray(value: TomlValue, name: string): TomlTable[] {
  if (!Array.isArray(value)) throw new Error(`The existing ${name} value is not an array.`);
  return value.map((entry) => requireTable(entry, name));
}

export function formatWindowsCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteWindowsShellArgument).join(" ");
}

function quoteWindowsShellArgument(value: string): string {
  if (!value) return '""';
  if (!/[\s"&|<>^()%!]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

async function restrictPermissions(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // Windows primarily protects the token with DPAPI; chmod is best effort there.
  }
}

async function removeTemporaryFile(target: string): Promise<void> {
  try {
    if ((await stat(target)).isFile()) {
      const { unlink } = await import("node:fs/promises");
      await unlink(target);
    }
  } catch {
    // The temporary file may not have been created.
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
