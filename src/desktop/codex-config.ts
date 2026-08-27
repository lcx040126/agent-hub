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

export interface CodexMcpRemovalSpec {
  connectionId: string;
  /** Expected Agent Hub executable used by the installed MCP bridge. */
  command: string;
  /** Exact installed bridge arguments, including --connection-id. */
  args: string[];
  /** Expected command used by Agent Hub's shared Codex hooks. */
  hookCommand?: string;
  /** Arguments before --codex-hook in Agent Hub's shared hook command. */
  hookArgs?: string[];
  /** Shared hooks are retained unless the caller explicitly opts into last-server cleanup. */
  removeManagedHooksWhenLastServer?: boolean;
}

export interface RemovedCodexMcpConfig {
  config: string;
  changed: boolean;
  mcpServerName: string;
  removedMcpServer: boolean;
  removedManagedHooks: boolean;
}

export interface UninstalledCodexConfig extends Omit<RemovedCodexMcpConfig, "config"> {
  configPath: string;
  backupPath?: string;
  restartRequired: boolean;
}

interface ManagedMcpIdentity {
  connectionId: string;
  name: string;
  command: string;
  args: string[];
  connectionArgumentIndex: number;
}

interface HookDefinition {
  event: "SessionStart" | "PreToolUse" | "PostToolUse" | "SessionEnd";
  matcher?: string;
  timeout: number;
}

const MANAGED_HOOK_DEFINITIONS: HookDefinition[] = [
  { event: "SessionStart", matcher: "^(startup|resume|clear|compact)$", timeout: 10 },
  { event: "PreToolUse", matcher: "^(Bash|apply_patch)$", timeout: 20 },
  { event: "PostToolUse", matcher: "^(Bash|apply_patch)$", timeout: 20 },
  { event: "SessionEnd", timeout: 60 },
];

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

/**
 * Remove only the bridge entry that still has the exact identity Agent Hub
 * installed. A key collision or user-edited command is deliberately left
 * untouched.
 */
export function removeCodexMcpConfig(
  source: string,
  spec: CodexMcpRemovalSpec,
): RemovedCodexMcpConfig {
  const identity = managedMcpIdentity(spec);
  const root = source.trim() ? (parse(source) as TomlTable) : {};
  const existingServers = root.mcp_servers;
  if (existingServers === undefined) return unchangedRemoval(source, identity.name);
  const servers = requireTable(existingServers, "mcp_servers");
  const target = servers[identity.name];
  if (target === undefined || !isManagedMcpServer(identity.name, target, identity)) {
    return unchangedRemoval(source, identity.name);
  }

  delete servers[identity.name];
  if (Object.keys(servers).length === 0) delete root.mcp_servers;
  else root.mcp_servers = servers;

  let removedManagedHooks = false;
  if (
    spec.removeManagedHooksWhenLastServer === true
    && spec.hookCommand
    && !hasPotentialManagedMcpServer(servers)
  ) {
    removedManagedHooks = removeAgentHubHooks(root, spec.hookCommand, spec.hookArgs ?? []) > 0;
  }

  return {
    config: `${stringify(root).trimEnd()}\n`,
    changed: true,
    mcpServerName: identity.name,
    removedMcpServer: true,
    removedManagedHooks,
  };
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
  const backupPath = await replaceCodexConfig(configPath, merged, existing);

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

export async function uninstallCodexMcpConfig(
  configPath: string,
  spec: CodexMcpRemovalSpec,
): Promise<UninstalledCodexConfig> {
  let source = "";
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const identity = managedMcpIdentity(spec);
    return {
      configPath,
      changed: false,
      mcpServerName: identity.name,
      removedMcpServer: false,
      removedManagedHooks: false,
      restartRequired: false,
    };
  }

  // Validate and transform before creating a backup or touching the live file.
  const removed = removeCodexMcpConfig(source, spec);
  if (!removed.changed) {
    return {
      configPath,
      changed: false,
      mcpServerName: removed.mcpServerName,
      removedMcpServer: false,
      removedManagedHooks: false,
      restartRequired: false,
    };
  }
  const backupPath = await replaceCodexConfig(configPath, removed.config, true);
  return {
    configPath,
    backupPath,
    changed: true,
    mcpServerName: removed.mcpServerName,
    removedMcpServer: removed.removedMcpServer,
    removedManagedHooks: removed.removedManagedHooks,
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

  for (const definition of MANAGED_HOOK_DEFINITIONS) {
    const currentGroups = hooks[definition.event];
    const groups = currentGroups === undefined
      ? []
      : requireTableArray(currentGroups, `hooks.${definition.event}`);
    const preserved = removeManagedHookHandlers(groups, definition, command, prefixArgs).groups;
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

function removeAgentHubHooks(root: TomlTable, command: string, prefixArgs: string[]): number {
  if (root.hooks === undefined) return 0;
  const hooks = requireTable(root.hooks, "hooks");
  let removed = 0;
  for (const definition of MANAGED_HOOK_DEFINITIONS) {
    const currentGroups = hooks[definition.event];
    if (currentGroups === undefined) continue;
    const result = removeManagedHookHandlers(
      requireTableArray(currentGroups, `hooks.${definition.event}`),
      definition,
      command,
      prefixArgs,
    );
    removed += result.removed;
    if (result.groups.length === 0) delete hooks[definition.event];
    else hooks[definition.event] = result.groups;
  }
  if (removed > 0) {
    if (Object.keys(hooks).length === 0) delete root.hooks;
    else root.hooks = hooks;
  }
  return removed;
}

function removeManagedHookHandlers(
  groups: TomlTable[],
  definition: HookDefinition,
  command: string,
  prefixArgs: string[],
): { groups: TomlTable[]; removed: number } {
  const result: TomlTable[] = [];
  let removed = 0;
  const expectedCommand = formatWindowsCommand(command, [
    ...prefixArgs,
    "--codex-hook",
    definition.event,
  ]);
  for (const group of groups) {
    const rawHandlers = group.hooks;
    if (rawHandlers === undefined) {
      result.push(group);
      continue;
    }
    const matcherMatches = definition.matcher === undefined
      ? group.matcher === undefined
      : group.matcher === definition.matcher;
    const handlers = requireTableArray(rawHandlers, "hook handlers").filter((handler) => {
      const managed = matcherMatches && isExactManagedHookHandler(
        handler,
        expectedCommand,
        definition.timeout,
      );
      if (managed) removed += 1;
      return !managed;
    });
    if (handlers.length > 0) result.push({ ...group, hooks: handlers });
  }
  return { groups: result, removed };
}

function isExactManagedHookHandler(
  handler: TomlTable,
  expectedCommand: string,
  expectedTimeout: number,
): boolean {
  return handler.type === "command"
    && handler.command === expectedCommand
    && handler.commandWindows === expectedCommand
    && handler.timeout === expectedTimeout;
}

function managedMcpIdentity(spec: CodexMcpRemovalSpec): ManagedMcpIdentity {
  const connectionId = requiredText(spec.connectionId, "connection ID");
  const command = requiredText(spec.command, "MCP bridge command");
  if (!Array.isArray(spec.args) || spec.args.some((argument) => typeof argument !== "string")) {
    throw new Error("Every expected MCP bridge argument must be a string.");
  }
  const bridgeIndexes = indexesOf(spec.args, "--mcp-bridge");
  if (bridgeIndexes.length !== 1) {
    throw new Error("The expected Agent Hub MCP bridge arguments must contain --mcp-bridge exactly once.");
  }
  const connectionIndexes = indexesOf(spec.args, "--connection-id");
  if (connectionIndexes.length !== 1) {
    throw new Error("The expected Agent Hub MCP bridge arguments must contain --connection-id exactly once.");
  }
  const connectionArgumentIndex = connectionIndexes[0]! + 1;
  if (spec.args[connectionArgumentIndex] !== connectionId) {
    throw new Error("The expected Agent Hub MCP bridge connection ID does not match the removal request.");
  }
  return {
    connectionId,
    name: codexServerName(connectionId),
    command,
    args: [...spec.args],
    connectionArgumentIndex,
  };
}

function isManagedMcpServer(
  name: string,
  value: TomlValue,
  identity: ManagedMcpIdentity,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const server = value as TomlTable;
  if (server.command !== identity.command) return false;
  const args = stringArray(server.args);
  if (!args || args.length !== identity.args.length) return false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== identity.args[index]) return false;
  }
  const connectionId = args[identity.connectionArgumentIndex];
  if (!connectionId || name !== codexServerName(connectionId)) return false;
  return connectionId === identity.connectionId;
}

function hasPotentialManagedMcpServer(servers: TomlTable): boolean {
  // An unknown agent_hub_* entry may belong to another installed version.
  // Retaining shared hooks is safer than breaking that connection.
  return Object.keys(servers).some((name) => name.startsWith("agent_hub_"));
}

function unchangedRemoval(source: string, mcpServerName: string): RemovedCodexMcpConfig {
  return {
    config: source,
    changed: false,
    mcpServerName,
    removedMcpServer: false,
    removedManagedHooks: false,
  };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`A valid ${label} is required.`);
  return value.trim();
}

function indexesOf(values: string[], expected: string): number[] {
  const indexes: number[] = [];
  values.forEach((value, index) => {
    if (value === expected) indexes.push(index);
  });
  return indexes;
}

function stringArray(value: TomlValue | undefined): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return undefined;
  return value as string[];
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

async function replaceCodexConfig(
  configPath: string,
  content: string,
  existing: boolean,
): Promise<string | undefined> {
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
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, configPath);
    await restrictPermissions(configPath, 0o600);
  } catch (error) {
    await removeTemporaryFile(temporaryPath);
    throw error;
  }
  return backupPath;
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
