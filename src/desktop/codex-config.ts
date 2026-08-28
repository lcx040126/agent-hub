import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
  restartRequired: boolean;
}

export interface CodexConfigReconciliationSpec {
  /** Complete desired Agent Hub MCP set for this Codex installation. */
  mcpServers: CodexMcpServerSpec[];
  /** Signature required before an existing MCP is adopted or removed as Agent Hub-owned. */
  managedMcpSignature?: CodexManagedMcpSignature;
  /** Shared Agent Hub launcher used by all managed lifecycle hooks. */
  hookCommand?: string;
  /** Arguments before --codex-hook in the shared launcher command. */
  hookArgs?: string[];
}

export interface CodexManagedMcpSignature {
  executableName: string;
  userDataPath: string;
}

export type CodexConfigReconciliationSpecResolver = (
  source: string,
) => CodexConfigReconciliationSpec | Promise<CodexConfigReconciliationSpec>;

export interface ReconciledCodexConfig {
  config: string;
  changed: boolean;
  discoveredManagedConnectionIds: string[];
  desiredMcpServerNames: string[];
  updatedMcpServerNames: string[];
  removedMcpServerNames: string[];
  managedHooksChanged: boolean;
}

export interface ReconciledCodexConfigFile extends Omit<ReconciledCodexConfig, "config"> {
  configPath: string;
  backupPath?: string;
  restartRequired: boolean;
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
  event: "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop" | "SessionEnd";
  matcher?: string;
  timeout: number;
}

const MANAGED_HOOK_DEFINITIONS: HookDefinition[] = [
  { event: "SessionStart", matcher: "^(startup|resume|clear|compact)$", timeout: 10 },
  { event: "UserPromptSubmit", timeout: 5 },
  { event: "PreToolUse", matcher: "^(Bash|apply_patch)$", timeout: 20 },
  { event: "PostToolUse", matcher: "^(Bash|apply_patch)$", timeout: 20 },
  { event: "Stop", timeout: 3 },
  { event: "SessionEnd", timeout: 3 },
];

const configMutationQueues = new Map<string, Promise<void>>();
const MAX_CONFIG_MUTATION_ATTEMPTS = 3;

class CodexConfigChangedDuringMutationError extends Error {}

export function codexServerName(connectionId: string): string {
  const suffix = connectionId.toLocaleLowerCase("en-US").replace(/[^a-z0-9_]/g, "").slice(0, 24);
  if (!suffix) throw new Error("A valid connection ID is required.");
  return `agent_hub_${suffix}`;
}

export function mergeCodexMcpConfig(source: string, spec: CodexMcpServerSpec): string {
  validateMcpServerSpec(spec);
  const root = parseCodexRoot(source);
  const existingServers = root.mcp_servers;
  const servers = existingServers === undefined ? {} : requireTable(existingServers, "mcp_servers");
  const desiredServer = canonicalMcpServer(spec);
  let changed = !isDeepStrictEqual(servers[spec.name], desiredServer);
  if (changed) {
    servers[spec.name] = desiredServer;
    root.mcp_servers = servers;
  }
  if (spec.hookCommand) {
    const hookResult = reconcileAgentHubHooks(root, spec.hookCommand, spec.hookArgs ?? []);
    changed = hookResult.changed || changed;
  }
  return changed ? serializeCodexRoot(root) : source;
}

/**
 * Reconcile the complete Agent Hub-owned Codex surface in one parse. Existing
 * entries are considered managed only when their name and Agent Hub-specific
 * bridge arguments prove the connection identity.
 */
export function reconcileCodexConfig(
  source: string,
  spec: CodexConfigReconciliationSpec,
): ReconciledCodexConfig {
  if (!Array.isArray(spec.mcpServers)) throw new Error("The desired MCP server list is required.");
  const desiredServers = new Map<string, CodexMcpServerSpec>();
  for (const desired of spec.mcpServers) {
    validateMcpServerSpec(desired);
    if (desiredServers.has(desired.name)) {
      throw new Error(`The desired MCP server name ${desired.name} is duplicated.`);
    }
    desiredServers.set(desired.name, desired);
  }
  validateHookInvocation(spec.hookCommand, spec.hookArgs);
  validateManagedMcpSignature(spec.managedMcpSignature);

  const root = parseCodexRoot(source);
  const existingServers = root.mcp_servers;
  const servers = existingServers === undefined ? {} : requireTable(existingServers, "mcp_servers");
  const discoveredConnectionIds = new Set<string>();
  const updatedMcpServerNames: string[] = [];
  const removedMcpServerNames: string[] = [];
  let changed = false;

  for (const [name, value] of Object.entries(servers)) {
    const connectionId = managedMcpConnectionId(name, value, spec.managedMcpSignature);
    if (!connectionId) continue;
    discoveredConnectionIds.add(connectionId);
    if (!desiredServers.has(name)) {
      delete servers[name];
      removedMcpServerNames.push(name);
      changed = true;
    }
  }

  for (const [name, desired] of desiredServers) {
    const desiredServer = canonicalMcpServer(desired);
    if (!isDeepStrictEqual(servers[name], desiredServer)) {
      servers[name] = desiredServer;
      updatedMcpServerNames.push(name);
      changed = true;
    }
  }

  if (changed) {
    if (Object.keys(servers).length === 0) delete root.mcp_servers;
    else root.mcp_servers = servers;
  }

  let managedHooksChanged = false;
  if (spec.hookCommand) {
    if (desiredServers.size > 0) {
      const hookResult = reconcileAgentHubHooks(root, spec.hookCommand, spec.hookArgs ?? []);
      managedHooksChanged = hookResult.changed;
    } else {
      managedHooksChanged = !hasPotentialManagedMcpServer(servers)
        && removeAgentHubHooks(
          root,
          spec.hookCommand,
          spec.hookArgs ?? [],
        ) > 0;
    }
    changed = managedHooksChanged || changed;
  }

  return {
    config: changed ? serializeCodexRoot(root) : source,
    changed,
    discoveredManagedConnectionIds: [...discoveredConnectionIds].sort(),
    desiredMcpServerNames: [...desiredServers.keys()].sort(),
    updatedMcpServerNames: updatedMcpServerNames.sort(),
    removedMcpServerNames: removedMcpServerNames.sort(),
    managedHooksChanged,
  };
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
  const root = parseCodexRoot(source);
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
    config: serializeCodexRoot(root),
    changed: true,
    mcpServerName: identity.name,
    removedMcpServer: true,
    removedManagedHooks,
  };
}

export async function reconcileCodexConfigFile(
  configPath: string,
  specOrResolver: CodexConfigReconciliationSpec | CodexConfigReconciliationSpecResolver,
): Promise<ReconciledCodexConfigFile> {
  return withConfigMutation(configPath, async () => {
    for (let attempt = 0; attempt < MAX_CONFIG_MUTATION_ATTEMPTS; attempt += 1) {
      const snapshot = await readCodexConfig(configPath);
      const spec = typeof specOrResolver === "function"
        ? await specOrResolver(snapshot.source)
        : specOrResolver;
      const reconciled = reconcileCodexConfig(snapshot.source, spec);
      const { config: _config, ...result } = reconciled;
      if (!reconciled.changed) {
        try {
          await assertCodexConfigSnapshot(configPath, snapshot);
          return {
            ...result,
            configPath,
            restartRequired: false,
          };
        } catch (error) {
          if (!(error instanceof CodexConfigChangedDuringMutationError)
            || attempt === MAX_CONFIG_MUTATION_ATTEMPTS - 1) throw error;
          continue;
        }
      }
      try {
        const backupPath = await replaceCodexConfig(configPath, reconciled.config, snapshot);
        return {
          ...result,
          configPath,
          backupPath,
          restartRequired: true,
        };
      } catch (error) {
        if (!(error instanceof CodexConfigChangedDuringMutationError)
          || attempt === MAX_CONFIG_MUTATION_ATTEMPTS - 1) throw error;
      }
    }
    throw new Error("Agent Hub could not reconcile the Codex config after repeated concurrent changes.");
  });
}

export async function installCodexMcpConfig(
  configPath: string,
  spec: CodexMcpServerSpec,
): Promise<InstalledCodexConfig> {
  return withConfigMutation(configPath, async () => {
    for (let attempt = 0; attempt < MAX_CONFIG_MUTATION_ATTEMPTS; attempt += 1) {
      const snapshot = await readCodexConfig(configPath);
      // Parse and merge before creating a backup or touching the user's live config.
      const merged = mergeCodexMcpConfig(snapshot.source, spec);
      const changed = merged !== snapshot.source;
      try {
        const backupPath = changed
          ? await replaceCodexConfig(configPath, merged, snapshot)
          : undefined;
        return {
          configPath,
          backupPath,
          mcpServerName: spec.name,
          command: spec.command,
          args: [...spec.args],
          env: spec.env ? { ...spec.env } : undefined,
          restartRequired: changed,
        };
      } catch (error) {
        if (!(error instanceof CodexConfigChangedDuringMutationError)
          || attempt === MAX_CONFIG_MUTATION_ATTEMPTS - 1) throw error;
      }
    }
    throw new Error("Agent Hub could not install the Codex config after repeated concurrent changes.");
  });
}

export async function uninstallCodexMcpConfig(
  configPath: string,
  spec: CodexMcpRemovalSpec,
): Promise<UninstalledCodexConfig> {
  return withConfigMutation(configPath, async () => {
    for (let attempt = 0; attempt < MAX_CONFIG_MUTATION_ATTEMPTS; attempt += 1) {
      const snapshot = await readCodexConfig(configPath);
      if (!snapshot.existing) {
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
      const removed = removeCodexMcpConfig(snapshot.source, spec);
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
      try {
        const backupPath = await replaceCodexConfig(configPath, removed.config, snapshot);
        return {
          configPath,
          backupPath,
          changed: true,
          mcpServerName: removed.mcpServerName,
          removedMcpServer: removed.removedMcpServer,
          removedManagedHooks: removed.removedManagedHooks,
          restartRequired: true,
        };
      } catch (error) {
        if (!(error instanceof CodexConfigChangedDuringMutationError)
          || attempt === MAX_CONFIG_MUTATION_ATTEMPTS - 1) throw error;
      }
    }
    throw new Error("Agent Hub could not uninstall the Codex config after repeated concurrent changes.");
  });
}

function validateMcpServerSpec(spec: CodexMcpServerSpec): void {
  if (!spec || typeof spec !== "object") throw new Error("An MCP server specification is required.");
  if (typeof spec.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(spec.name)) {
    throw new Error("The MCP server name may only contain letters, numbers, underscores, and hyphens.");
  }
  if (typeof spec.command !== "string" || !spec.command.trim()) {
    throw new Error("The MCP bridge command is required.");
  }
  if (!Array.isArray(spec.args) || spec.args.some((argument) => typeof argument !== "string")) {
    throw new Error("Every MCP bridge argument must be a string.");
  }
  if (
    spec.env !== undefined
    && (
      !spec.env
      || typeof spec.env !== "object"
      || Array.isArray(spec.env)
      || Object.entries(spec.env).some(
        ([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string",
      )
    )
  ) {
    throw new Error("Every MCP bridge environment variable must have a valid name and string value.");
  }
  validateHookInvocation(spec.hookCommand, spec.hookArgs);
}

function canonicalMcpServer(spec: CodexMcpServerSpec): TomlTable {
  return {
    command: spec.command,
    args: [...spec.args],
    enabled: true,
    required: false,
    startup_timeout_sec: 20,
    tool_timeout_sec: 120,
    ...(spec.env ? { env: { ...spec.env } } : {}),
  };
}

function managedMcpConnectionId(
  name: string,
  value: TomlValue,
  signature: CodexManagedMcpSignature | undefined,
): string | undefined {
  if (
    !signature
    || !name.startsWith("agent_hub_")
    || !value
    || typeof value !== "object"
    || Array.isArray(value)
  ) {
    return undefined;
  }
  const server = value as TomlTable;
  if (typeof server.command !== "string" || !server.command.trim()) return undefined;
  if (
    path.win32.basename(server.command).toLocaleLowerCase("en-US")
    !== signature.executableName.toLocaleLowerCase("en-US")
  ) return undefined;
  const env = server.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return undefined;
  if ((env as TomlTable).ELECTRON_RUN_AS_NODE !== "1") return undefined;
  const args = stringArray(server.args);
  if (!args) return undefined;
  const runnerIndexes = args
    .map((argument, index) => ({ argument, index }))
    .filter(({ argument }) =>
    argument.replace(/\\/g, "/").toLocaleLowerCase("en-US")
      .endsWith("/dist/companion/headless-runner.js"))
    .map(({ index }) => index);
  if (runnerIndexes.length !== 1) return undefined;
  const userDataIndexes = indexesOf(args, "--user-data");
  if (userDataIndexes.length !== 1) return undefined;
  const configuredUserDataPath = args[userDataIndexes[0]! + 1];
  if (
    !configuredUserDataPath
    || windowsPathIdentity(configuredUserDataPath) !== windowsPathIdentity(signature.userDataPath)
  ) return undefined;
  if (indexesOf(args, "--mcp-bridge").length !== 1) return undefined;
  const connectionIndexes = indexesOf(args, "--connection-id");
  if (connectionIndexes.length !== 1) return undefined;
  const connectionId = args[connectionIndexes[0]! + 1];
  if (!connectionId || connectionId !== connectionId.trim()) return undefined;
  try {
    return codexServerName(connectionId) === name ? connectionId : undefined;
  } catch {
    return undefined;
  }
}

function validateManagedMcpSignature(signature: CodexManagedMcpSignature | undefined): void {
  if (signature === undefined) return;
  if (
    typeof signature.executableName !== "string"
    || !signature.executableName.trim()
    || path.win32.basename(signature.executableName) !== signature.executableName
  ) {
    throw new Error("The managed MCP executable name must be a file name.");
  }
  if (typeof signature.userDataPath !== "string" || !signature.userDataPath.trim()) {
    throw new Error("The managed MCP user-data path is required.");
  }
}

function validateHookInvocation(command: string | undefined, args: string[] | undefined): void {
  if (command === undefined) {
    if (args !== undefined && args.length > 0) {
      throw new Error("Hook launcher arguments require a hook command.");
    }
    return;
  }
  if (typeof command !== "string" || !command.trim()) {
    throw new Error("The Hook launcher command is required.");
  }
  if (args !== undefined && (!Array.isArray(args) || args.some((argument) => typeof argument !== "string"))) {
    throw new Error("Every Hook launcher argument must be a string.");
  }
}

function parseCodexRoot(source: string): TomlTable {
  return source.trim() ? (parse(source) as TomlTable) : {};
}

function serializeCodexRoot(root: TomlTable): string {
  return `${stringify(root).trimEnd()}\n`;
}

function requireTable(value: TomlValue, name: string): TomlTable {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The existing ${name} value is not a TOML table.`);
  }
  return value as TomlTable;
}

function reconcileAgentHubHooks(
  root: TomlTable,
  command: string,
  prefixArgs: string[],
): { changed: boolean; removed: number } {
  validateHookInvocation(command, prefixArgs);
  const existingHooks = root.hooks;
  const hooks = existingHooks === undefined ? {} : requireTable(existingHooks, "hooks");
  const features = root.features === undefined ? {} : requireTable(root.features, "features");
  let changed = false;
  let removed = 0;
  if (features.hooks !== true) {
    features.hooks = true;
    root.features = features;
    changed = true;
  }

  for (const definition of MANAGED_HOOK_DEFINITIONS) {
    const currentGroups = hooks[definition.event];
    const groups = currentGroups === undefined
      ? []
      : requireTableArray(currentGroups, `hooks.${definition.event}`);
    const result = removeManagedHookHandlers(groups, definition, command, prefixArgs);
    const nextGroups = [...result.groups, canonicalHookGroup(definition, command, prefixArgs)];
    removed += result.removed;
    if (!isDeepStrictEqual(groups, nextGroups)) {
      hooks[definition.event] = nextGroups;
      changed = true;
    }
  }
  if (changed) root.hooks = hooks;
  return { changed, removed };
}

function removeAgentHubHooks(root: TomlTable, command: string, prefixArgs: string[]): number {
  validateHookInvocation(command, prefixArgs);
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
    const handlers = requireTableArray(rawHandlers, "hook handlers").filter((handler) => {
      const managed = isManagedHookHandler(handler, expectedCommand, definition.event);
      if (managed) removed += 1;
      return !managed;
    });
    if (handlers.length > 0) result.push({ ...group, hooks: handlers });
  }
  return { groups: result, removed };
}

function canonicalHookGroup(
  definition: HookDefinition,
  command: string,
  prefixArgs: string[],
): TomlTable {
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
  return group;
}

function isManagedHookHandler(
  handler: TomlTable,
  expectedCommand: string,
  event: HookDefinition["event"],
): boolean {
  const expectedIdentity = managedHookInvocationIdentity(expectedCommand, event);
  return [handler.command, handler.commandWindows, handler.command_windows]
    .some((value) => {
      if (value === expectedCommand) return true;
      if (typeof value !== "string" || !expectedIdentity) return false;
      const identity = managedHookInvocationIdentity(value, event);
      return Boolean(
        identity
        && identity.executableName === expectedIdentity.executableName
        && windowsPathIdentity(identity.launcherPath)
          === windowsPathIdentity(expectedIdentity.launcherPath),
      );
    });
}

function managedHookInvocationIdentity(
  command: string,
  event: HookDefinition["event"],
): { executableName: string; launcherPath: string } | undefined {
  const args = splitWindowsCommandLine(command);
  if (!args) return undefined;
  const normalizedArgs = args.map((argument) => argument.toLocaleLowerCase("en-US"));
  const fileIndexes = indexesOf(normalizedArgs, "-file");
  const hookIndexes = indexesOf(normalizedArgs, "--codex-hook");
  if (fileIndexes.length !== 1 || hookIndexes.length !== 1) return undefined;
  const launcherPath = args[fileIndexes[0]! + 1];
  const hookEvent = args[hookIndexes[0]! + 1];
  if (!launcherPath || hookEvent?.toLocaleLowerCase("en-US") !== event.toLocaleLowerCase("en-US")) {
    return undefined;
  }
  return {
    executableName: path.win32.basename(args[0] ?? "").toLocaleLowerCase("en-US"),
    launcherPath,
  };
}

/** Parse the quoting shape emitted by formatWindowsCommand and prior launchers. */
function splitWindowsCommandLine(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quoted = false;
  let index = 0;
  while (index < command.length) {
    const character = command[index]!;
    if (!quoted && /\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
      index += 1;
      continue;
    }
    tokenStarted = true;
    if (character === '"') {
      quoted = !quoted;
      index += 1;
      continue;
    }
    if (character !== "\\") {
      token += character;
      index += 1;
      continue;
    }

    let slashCount = 0;
    while (command[index + slashCount] === "\\") slashCount += 1;
    const nextCharacter = command[index + slashCount];
    if (nextCharacter !== '"') {
      token += "\\".repeat(slashCount);
      index += slashCount;
      continue;
    }
    token += "\\".repeat(Math.floor(slashCount / 2));
    if (slashCount % 2 === 1) token += '"';
    else quoted = !quoted;
    index += slashCount + 1;
  }
  if (quoted) return undefined;
  if (tokenStarted) tokens.push(token);
  return tokens.length > 0 ? tokens : undefined;
}

function windowsPathIdentity(value: string): string {
  return path.win32.normalize(value.replaceAll("/", "\\")).toLocaleLowerCase("en-US");
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

async function readCodexConfig(
  configPath: string,
): Promise<{ source: string; existing: boolean }> {
  try {
    return { source: await readFile(configPath, "utf8"), existing: true };
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return { source: "", existing: false };
  }
}

async function withConfigMutation<T>(configPath: string, operation: () => Promise<T>): Promise<T> {
  const resolved = path.resolve(configPath);
  const key = process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  const previous = configMutationQueues.get(key) ?? Promise.resolve();
  const run = previous.then(operation);
  const tracked = run.then(() => undefined, () => undefined);
  configMutationQueues.set(key, tracked);
  try {
    return await run;
  } finally {
    if (configMutationQueues.get(key) === tracked) configMutationQueues.delete(key);
  }
}

async function replaceCodexConfig(
  configPath: string,
  content: string,
  snapshot: { source: string; existing: boolean },
): Promise<string | undefined> {
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  await restrictPermissions(path.dirname(configPath), 0o700);

  let backupPath: string | undefined;
  const temporaryPath = `${configPath}.agent-hub-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await assertCodexConfigSnapshot(configPath, snapshot);
    if (snapshot.existing) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = `${configPath}.agent-hub-${timestamp}-${randomUUID()}.bak`;
      await writeFile(backupPath, snapshot.source, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await restrictPermissions(backupPath, 0o600);
      await assertCodexConfigSnapshot(configPath, snapshot);
    }
    await rename(temporaryPath, configPath);
    await restrictPermissions(configPath, 0o600);
  } catch (error) {
    await removeTemporaryFile(temporaryPath);
    if (error instanceof CodexConfigChangedDuringMutationError && backupPath) {
      await removeTemporaryFile(backupPath);
    }
    throw error;
  }
  return backupPath;
}

async function assertCodexConfigSnapshot(
  configPath: string,
  expected: { source: string; existing: boolean },
): Promise<void> {
  const current = await readCodexConfig(configPath);
  if (current.existing !== expected.existing || current.source !== expected.source) {
    throw new CodexConfigChangedDuringMutationError(
      "The Codex config changed while Agent Hub was preparing an update.",
    );
  }
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
