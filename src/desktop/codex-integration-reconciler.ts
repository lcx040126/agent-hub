import path from "node:path";
import {
  codexServerName,
  reconcileCodexConfig,
  reconcileCodexConfigFile,
  type CodexMcpServerSpec,
  type ReconciledCodexConfigFile,
} from "./codex-config.js";
import type { ConnectionStore } from "./connection-store.js";
import type { SavedRoomConnection } from "./contracts.js";
import {
  installHeadlessLauncher,
  type InstallHeadlessLauncherOptions,
} from "./headless-launcher.js";

interface CodexIntegrationStore {
  list(): Promise<SavedRoomConnection[]>;
  setCodexIntegrationInstalled(
    connectionId: string,
    installed: boolean,
  ): Promise<SavedRoomConnection>;
}

export interface DesktopCodexReconciliationOptions {
  store: Pick<ConnectionStore, "list" | "setCodexIntegrationInstalled"> | CodexIntegrationStore;
  configPath: string;
  userDataPath: string;
  electronExecutable: string;
  runnerPath: string;
  installConnectionId?: string;
  removeConnectionId?: string;
  installLauncher?: (options: InstallHeadlessLauncherOptions) => Promise<string>;
}

export interface DesktopCodexReconciliationResult extends ReconciledCodexConfigFile {
  launcherPath?: string;
  installedConnectionIds: string[];
  adoptedLegacyConnectionIds: string[];
}

export interface StartupCodexReconciliationOptions extends DesktopCodexReconciliationOptions {
  onChanged?(result: DesktopCodexReconciliationResult): void;
  onError?(error: Error): void;
}

let reconciliationQueue: Promise<void> = Promise.resolve();
let lifecycleQueue: Promise<void> = Promise.resolve();

/** Serialize complete install/delete workflows, including connection-store removal. */
export async function withDesktopCodexIntegrationLifecycle<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const run = lifecycleQueue.then(operation);
  lifecycleQueue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Rebuild the complete Agent Hub-owned Codex surface from durable connection
 * intent. The process-wide queue keeps discovery, migration and config writes
 * in one order when startup, install and delete overlap.
 */
export async function reconcileDesktopCodexIntegrations(
  options: DesktopCodexReconciliationOptions,
): Promise<DesktopCodexReconciliationResult> {
  return withReconciliationLock(async () => {
    if (
      options.installConnectionId
      && options.installConnectionId === options.removeConnectionId
    ) {
      throw new Error("The same Codex integration cannot be installed and removed together.");
    }

    const connections = await options.store.list();
    const initialById = new Map(connections.map((connection) => [connection.id, connection]));
    for (const connectionId of [options.installConnectionId, options.removeConnectionId]) {
      if (connectionId && !initialById.has(connectionId)) {
        throw new Error("The selected room connection does not exist.");
      }
    }

    // Persist intent before touching config. A crash can then be repaired on the
    // next startup instead of undoing a completed install or resurrecting a delete.
    if (options.installConnectionId) {
      await options.store.setCodexIntegrationInstalled(options.installConnectionId, true);
    }
    if (options.removeConnectionId) {
      await options.store.setCodexIntegrationInstalled(options.removeConnectionId, false);
    }
    const currentConnections = await options.store.list();
    const byId = new Map(currentConnections.map((connection) => [connection.id, connection]));
    const launcher = codexHookLauncher(options.userDataPath);
    const managedMcpSignature = {
      executableName: path.win32.basename(options.electronExecutable),
      userDataPath: options.userDataPath,
    };
    let installedConnectionIds: string[] = [];
    let adoptedLegacyConnectionIds: string[] = [];
    let launcherPath: string | undefined;
    const reconciled = await reconcileCodexConfigFile(options.configPath, async (source) => {
      const discovered = reconcileCodexConfig(source, {
        mcpServers: [],
        managedMcpSignature,
      }).discoveredManagedConnectionIds;
      const discoveredSavedIds = discovered.filter((connectionId) => byId.has(connectionId));
      const desiredIds = new Set(
        currentConnections
          .filter((connection) => connection.codexIntegrationInstalled === true)
          .map((connection) => connection.id),
      );
      adoptedLegacyConnectionIds = discoveredSavedIds
        .filter((connectionId) => byId.get(connectionId)?.codexIntegrationInstalled === undefined)
        .filter((connectionId) => connectionId !== options.removeConnectionId)
        .sort();
      for (const connectionId of adoptedLegacyConnectionIds) desiredIds.add(connectionId);
      if (options.removeConnectionId) desiredIds.delete(options.removeConnectionId);

      installedConnectionIds = [...desiredIds].sort();
      const mcpServers = installedConnectionIds.map((connectionId) =>
        codexMcpServerSpec(options, connectionId));
      launcherPath = undefined;
      if (mcpServers.length > 0) {
        launcherPath = await (options.installLauncher ?? installHeadlessLauncher)({
          launcherPath: launcher.path,
          electronExecutable: options.electronExecutable,
          runnerPath: options.runnerPath,
          userDataPath: options.userDataPath,
        });
      }
      return {
        mcpServers,
        managedMcpSignature,
        hookCommand: launcher.command,
        hookArgs: launcher.args,
      };
    });
    for (const connectionId of adoptedLegacyConnectionIds) {
      await options.store.setCodexIntegrationInstalled(connectionId, true);
    }

    return {
      ...reconciled,
      launcherPath,
      installedConnectionIds,
      adoptedLegacyConnectionIds,
    };
  });
}

/** Startup reconciliation is intentionally best effort and cannot invalidate an update. */
export async function reconcileDesktopCodexIntegrationsAtStartup(
  options: StartupCodexReconciliationOptions,
): Promise<DesktopCodexReconciliationResult | undefined> {
  try {
    const result = await reconcileDesktopCodexIntegrations(options);
    if (result.changed) options.onChanged?.(result);
    return result;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    options.onError?.(failure);
    return undefined;
  }
}

export function codexMcpServerSpec(
  options: Pick<
    DesktopCodexReconciliationOptions,
    "electronExecutable" | "runnerPath" | "userDataPath"
  >,
  connectionId: string,
): CodexMcpServerSpec {
  return {
    name: codexServerName(connectionId),
    command: options.electronExecutable,
    args: [
      options.runnerPath,
      "--user-data",
      options.userDataPath,
      "--mcp-bridge",
      "--connection-id",
      connectionId,
    ],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

export function codexHookLauncher(userDataPath: string): {
  path: string;
  command: string;
  args: string[];
} {
  const launcherPath = path.join(userDataPath, "codex", "agent-hub-headless.ps1");
  return {
    path: launcherPath,
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
    ],
  };
}

async function withReconciliationLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = reconciliationQueue.then(operation);
  reconciliationQueue = run.then(() => undefined, () => undefined);
  return run;
}
