import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  app as electronApp,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";
import { inspectRepository } from "../companion/repository.js";
import { IntegrationController } from "../companion/integration-controller.js";
import {
  startCodexSessionHeartbeatScheduler,
  type CodexSessionHeartbeatScheduler,
} from "../companion/codex-session-heartbeat.js";
import { WindowsDpapiProtector } from "../companion/windows-dpapi.js";
import {
  startRepositoryScanScheduler,
  type RepositoryScanScheduler,
} from "../companion/scan-scheduler.js";
import {
  AGENT_HUB_PROTOCOL_VERSION,
  AGENT_HUB_RELEASE_OWNER,
  AGENT_HUB_RELEASE_REPOSITORY,
  AGENT_HUB_SCHEMA_VERSION,
  AGENT_HUB_VERSION,
} from "../shared/version.js";
import { createConsistentSqliteBackup } from "../server/sqlite-backup.js";
import { DesktopAppUpdater, type ElectronUpdateEngine } from "./app-updater.js";
import { installCodexMcpConfig, codexServerName } from "./codex-config.js";
import { CONNECTION_STORE_FILENAME, ConnectionStore } from "./connection-store.js";
import { DESKTOP_IPC, type SaveRoomConnectionInput, type DesktopServerInfo } from "./contracts.js";
import { installHeadlessLauncher } from "./headless-launcher.js";
import {
  activateDesktopRoomConnection,
  enterDesktopMaintenance,
  pauseDesktopRoomConnection,
  recoverDesktopMaintenance,
  shouldStartLocalRoomService,
  shutdownDesktopIntegration,
} from "./integration-lifecycle.js";
import { candidatePorts, collectLanUrls } from "./network.js";
import { requestRoomServer } from "./room-server-proxy.js";
import {
  startReleaseRequestNotificationScheduler,
  type ReleaseRequestNotificationScheduler,
} from "./release-request-notifier.js";
import { createServiceSupervisor, type ServiceSupervisor } from "./service-supervisor.js";
import { verifyStartupHealthAndMark } from "./startup-health.js";
import { FileDesktopUpdateRecovery } from "./update-recovery.js";
import { reconcilePendingUpdateAtStartup } from "./update-startup-recovery.js";
import { WindowsUpdateRecoveryExecutor } from "./windows-update-watchdog.js";

const HOST = "0.0.0.0";
const PREFERRED_PORT = 4173;
const noTray = process.argv.includes("--no-tray");

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let hostServer: ServiceSupervisor | null = null;
let scanScheduler: RepositoryScanScheduler | null = null;
let hookHeartbeatScheduler: CodexSessionHeartbeatScheduler | null = null;
let releaseRequestNotifier: ReleaseRequestNotificationScheduler | null = null;
let desktopUpdater: DesktopAppUpdater | null = null;
let integrationController: IntegrationController | null = null;
let unsubscribeUpdateStatus: (() => void) | null = null;
let isQuitting = false;
let quitCleanupComplete = false;
let quitCleanupPromise: Promise<void> | null = null;
let updateInstallInProgress = false;

startDesktopLifecycle();

function startDesktopLifecycle(): void {
  if (!electronApp.requestSingleInstanceLock()) {
    electronApp.quit();
    return;
  }
  electronApp.on("second-instance", () => showMainWindow());
  electronApp.on("before-quit", (event) => {
    // The signed updater owns its own restart path. Maintenance keeps leases
    // alive, so the normal quit cleanup must not run during installation.
    if (quitCleanupComplete || updateInstallInProgress) {
      isQuitting = true;
      return;
    }
    event.preventDefault();
    if (quitCleanupPromise) return;
    isQuitting = true;
    quitCleanupPromise = cleanupBeforeQuit()
      .catch((error: unknown) => {
        console.error(`Agent Hub shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        quitCleanupComplete = true;
        quitCleanupPromise = null;
        electronApp.quit();
      });
  });
  electronApp.on("activate", () => showMainWindow());
  electronApp.on("window-all-closed", () => {
    if (noTray) electronApp.quit();
  });

  electronApp.whenReady().then(bootstrap).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("Agent Hub could not start", message);
    electronApp.quit();
  });
}

async function bootstrap(): Promise<void> {
  const userDataDirectory = electronApp.getPath("userData");
  const updateDirectory = path.join(userDataDirectory, "updates");
  const recovery = new FileDesktopUpdateRecovery(updateDirectory);
  const recoveryExecutor = new WindowsUpdateRecoveryExecutor(updateDirectory);
  const updaterEnabled = electronApp.isPackaged
    && process.platform === "win32"
    && !process.env.PORTABLE_EXECUTABLE_FILE;
  const currentVersion = electronApp.isPackaged ? electronApp.getVersion() : AGENT_HUB_VERSION;
  if (updaterEnabled) {
    const recoveryAction = await reconcilePendingUpdateAtStartup({
      recovery,
      recoveryExecutor,
      currentVersion,
    });
    if (recoveryAction === "quit-for-rollback") {
      isQuitting = true;
      electronApp.quit();
      return;
    }
  }
  const serviceScript = path.join(electronApp.getAppPath(), "dist", "server", "index.js");
  const servicePort = await findAvailableServicePort();
  hostServer = createServiceSupervisor({
    executable: process.execPath,
    scriptPath: serviceScript,
    port: servicePort,
    dataDir: path.join(userDataDirectory, "server"),
  });
  await hostServer.start();
  const serverInfo: DesktopServerInfo = {
    localServerUrl: hostServer.url,
    lanUrls: collectLanUrls(hostServer.port, networkInterfaces()),
    port: hostServer.port,
    appVersion: AGENT_HUB_VERSION,
    protocolVersion: AGENT_HUB_PROTOCOL_VERSION,
    schemaVersion: AGENT_HUB_SCHEMA_VERSION,
  };
  const store = new ConnectionStore(
    path.join(userDataDirectory, CONNECTION_STORE_FILENAME),
    new WindowsDpapiProtector(),
  );
  integrationController = new IntegrationController({
    userDataPath: userDataDirectory,
    store,
    onError(error) {
      console.error(`Agent Hub integration lifecycle warning: ${error.message}`);
    },
  });
  await integrationController.start();
  const integrationIsActive = () => integrationController?.getPresence()?.record.status === "active";
  const startScanner = () => startRepositoryScanScheduler({
    store,
    integrationActive: integrationIsActive,
    onError(error, connection) {
      const repository = connection?.repositoryPath ? ` (${connection.repositoryPath})` : "";
      console.error(`Agent Hub repository scan failed${repository}: ${error.message}`);
    },
  });
  if (integrationIsActive()) {
    scanScheduler = startScanner();
    hookHeartbeatScheduler = startCodexSessionHeartbeatScheduler({
      userDataPath: userDataDirectory,
      store,
      onError(error, state) {
        const session = state?.hubSessionId ? ` (${state.hubSessionId})` : "";
        console.error(`Agent Hub Codex heartbeat failed${session}: ${error.message}`);
      },
    });
    releaseRequestNotifier = startReleaseRequestNotificationScheduler({
      store,
      notify(request, connection) {
        if (!Notification.isSupported()) return;
        const notification = new Notification({
          title: `${connection.roomName || "Agent Hub"}：保护范围交接申请`,
          body: `${request.requesterName} 请求“${request.requestTitle}”${request.requestedPaths[0] ? `\n${request.requestedPaths[0]}` : ""}`,
          silent: false,
        });
        notification.on("click", () => showMainWindow());
        notification.show();
      },
      onError(error, connection) {
        const room = connection?.roomName ? ` (${connection.roomName})` : "";
        console.error(`Agent Hub release-request notification check failed${room}: ${error.message}`);
      },
    });
  }

  const engine = await createElectronUpdateEngine();
  const updater = new DesktopAppUpdater({
    engine,
    recovery,
    enabled: updaterEnabled,
    currentVersion,
    recoveryApplication: {
      applicationDirectory: path.dirname(process.execPath),
      applicationExecutablePath: process.execPath,
      restoreRootDirectory: userDataDirectory,
    },
    recoveryExecutor,
      installHooks: {
      async prepareForInstall() {
        const maintenanceScanner = scanScheduler;
        // A scheduler marks itself stopped before draining its current scan.
        // Clear the live reference first so abort recovery always creates a
        // fresh instance even when a later maintenance step fails.
        scanScheduler = null;
        await enterDesktopMaintenance({
          controller: integrationController,
          scanner: maintenanceScanner,
          localServer: hostServer,
        });
        const databasePath = path.join(userDataDirectory, "server", "agent-hub.sqlite");
        const snapshotPath = path.join(updateDirectory, "staging", "agent-hub-pre-update.sqlite");
        const database = new DatabaseSync(databasePath);
        try {
          await createConsistentSqliteBackup(database, snapshotPath);
        } finally {
          database.close();
        }
        return [
          {
            sourcePath: snapshotPath,
            relativeName: "server/agent-hub.sqlite",
            restorePath: databasePath,
            required: true,
            removeSourceAfterCopy: true,
          },
        ];
      },
      onInstallLaunching() {
        updateInstallInProgress = true;
        isQuitting = true;
      },
      async onInstallAborted() {
        updateInstallInProgress = false;
        isQuitting = false;
        await recoverDesktopMaintenance({
          controller: integrationController,
          localServer: hostServer,
          restartSchedulers: [
            () => {
              if (!scanScheduler && integrationController?.getPresence()?.record.status === "active") {
                scanScheduler = startScanner();
              }
            },
            () => {
              if (!hookHeartbeatScheduler && integrationController?.getPresence()?.record.status === "active") {
                hookHeartbeatScheduler = startCodexSessionHeartbeatScheduler({
                  userDataPath: userDataDirectory,
                  store,
                  onError(error, state) {
                    const session = state?.hubSessionId ? ` (${state.hubSessionId})` : "";
                    console.error(`Agent Hub Codex heartbeat failed${session}: ${error.message}`);
                  },
                });
              }
            },
          ],
        });
      },
    },
  });
  desktopUpdater = updater;

  registerIpc(serverInfo, store, userDataDirectory, updater, integrationController, hostServer);
  const window = createMainWindow(serverInfo.localServerUrl);
  mainWindow = window;
  unsubscribeUpdateStatus = updater.subscribe((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(DESKTOP_IPC.desktopUpdateStatus, status);
    }
  });
  if (!noTray) createTray(serverInfo);
  await verifyStartupHealthAndMark({
    localServerUrl: serverInfo.localServerUrl,
    electronExecutable: process.execPath,
    headlessRunnerPath: path.join(
      electronApp.getAppPath(),
      "dist",
      "companion",
      "headless-runner.js",
    ),
    expectedVersion: currentVersion,
    loadRenderer: () => window.loadURL(serverInfo.localServerUrl),
    markHealthy: () => updater.markCurrentStartupHealthy(),
  });
  updater.startAutomaticChecks();
}

async function createElectronUpdateEngine(): Promise<ElectronUpdateEngine> {
  const { NsisUpdater } = await import("electron-updater");
  return new NsisUpdater({
    provider: "github",
    owner: AGENT_HUB_RELEASE_OWNER,
    repo: AGENT_HUB_RELEASE_REPOSITORY,
  }) as ElectronUpdateEngine;
}

async function cleanupBeforeQuit(): Promise<void> {
  // shutdownDesktopIntegration closes the sentinel before waiting on these
  // producers, then drains their operation markers before remote cleanup.
  const schedulers = [scanScheduler, hookHeartbeatScheduler, releaseRequestNotifier];
  scanScheduler = null;
  hookHeartbeatScheduler = null;
  releaseRequestNotifier = null;
  unsubscribeUpdateStatus?.();
  unsubscribeUpdateStatus = null;
  desktopUpdater?.dispose();
  desktopUpdater = null;
  // Keep the local room service available until remote cleanup has been sent.
  await shutdownDesktopIntegration({
    schedulers,
    controller: integrationController,
    localServer: hostServer,
  });
  hostServer = null;
  integrationController = null;
  tray?.destroy();
  tray = null;
}

async function findAvailableServicePort(): Promise<number> {
  for (const port of candidatePorts(PREFERRED_PORT)) {
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(150) });
      if (!probe.ok) return port;
    } catch {
      return port;
    }
  }
  throw new Error("Agent Hub could not find an available local port from 4173 through 4272.");
}

function createMainWindow(localServerUrl: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 660,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f5f6f7",
    title: "Agent Hub",
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  const trustedOrigin = new URL(localServerUrl).origin;
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://github.com/")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (new URL(targetUrl).origin !== trustedOrigin) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (!isQuitting && !noTray) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

function createTray(serverInfo: DesktopServerInfo): void {
  const iconPath = fileURLToPath(new URL("../../assets/agent-hub-icon.png", import.meta.url));
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip(`Agent Hub - ${serverInfo.localServerUrl}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Agent Hub", click: () => showMainWindow() },
      {
        label: "Copy LAN invitation address",
        enabled: serverInfo.lanUrls.length > 0,
        click: () => clipboard.writeText(serverInfo.lanUrls[0] ?? serverInfo.localServerUrl),
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          electronApp.quit();
        },
      },
    ]),
  );
  tray.on("click", () => showMainWindow());
}

function registerIpc(
  serverInfo: DesktopServerInfo,
  store: ConnectionStore,
  userDataDirectory: string,
  updater: DesktopAppUpdater,
  controller: IntegrationController,
  localServer: ServiceSupervisor,
): void {
  const allowedRepositories = new Set<string>();
  void store.list().then((connections) => {
    for (const connection of connections) allowedRepositories.add(pathKey(connection.repositoryPath));
  });

  ipcMain.handle(DESKTOP_IPC.chooseRepository, async (event) => {
    assertTrustedRenderer(event, serverInfo.localServerUrl);
    const options: OpenDialogOptions = {
      title: "Choose a Git repository",
      properties: ["openDirectory"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const selected = result.canceled ? undefined : result.filePaths[0];
    if (!selected) return null;
    const resolved = path.resolve(selected);
    allowedRepositories.add(pathKey(resolved));
    return resolved;
  });

  ipcMain.handle(DESKTOP_IPC.inspectRepository, async (event, repositoryPath: unknown) => {
    assertTrustedRenderer(event, serverInfo.localServerUrl);
    const resolved = requireApprovedRepository(repositoryPath, allowedRepositories);
    return inspectRepository(resolved);
  });

  ipcMain.handle(DESKTOP_IPC.getServerInfo, (event) => {
    assertTrustedRenderer(event, serverInfo.localServerUrl);
    return serverInfo;
  });

  ipcMain.handle(DESKTOP_IPC.listRoomConnections, async (event) => {
    assertTrustedRenderer(event, serverInfo.localServerUrl);
    return store.list();
  });

  ipcMain.handle(
    DESKTOP_IPC.pauseRoomConnection,
    async (event, connectionId: unknown) => {
      assertTrustedRenderer(event, serverInfo.localServerUrl);
      if (typeof connectionId !== "string" || !connectionId.trim()) {
        throw new Error("A saved room connection is required.");
      }
      const normalizedId = connectionId.trim();
      return pauseDesktopRoomConnection({
        connectionId: normalizedId,
        controller,
        store,
        localServer,
      });
    },
  );

  ipcMain.handle(DESKTOP_IPC.activateRoomConnection, async (event, connectionId: unknown) => {
    assertTrustedRenderer(event, serverInfo.localServerUrl);
    if (typeof connectionId !== "string" || !connectionId.trim()) {
      throw new Error("A saved room connection is required.");
    }
    const normalizedId = connectionId.trim();
    return activateDesktopRoomConnection({
      connectionId: normalizedId,
      controller,
      store,
      localServer,
    });
  });

  ipcMain.handle(DESKTOP_IPC.saveRoomConnection, async (event, input: SaveRoomConnectionInput) => {
    assertTrustedRenderer(event, serverInfo.localServerUrl);
    requireApprovedRepository(input?.repositoryPath, allowedRepositories);
    const saved = await store.save(input);
    controller.rememberConnectionState(saved.id, saved.integrationEnabled !== false);
    allowedRepositories.add(pathKey(saved.repositoryPath));
    await scanScheduler?.scanNow();
    return saved;
  });

  ipcMain.handle(DESKTOP_IPC.requestRoomServer, async (event, input: unknown) => {
    assertTrustedRenderer(event, serverInfo.localServerUrl);
    if (shouldStartLocalRoomService(input, localServer.url)) await localServer.start();
    return requestRoomServer(input, store);
  });

  ipcMain.handle(DESKTOP_IPC.getDesktopUpdateStatus, (event) => {
    assertTrustedRenderer(event, serverInfo.localServerUrl);
    return updater.getStatus();
  });

  ipcMain.handle(DESKTOP_IPC.checkDesktopUpdate, async (event) => {
    assertTrustedRenderer(event, serverInfo.localServerUrl);
    return updater.check();
  });

  ipcMain.handle(DESKTOP_IPC.downloadDesktopUpdate, async (event) => {
    assertTrustedRenderer(event, serverInfo.localServerUrl);
    return updater.download();
  });

  ipcMain.handle(DESKTOP_IPC.installDesktopUpdate, async (event) => {
    assertTrustedRenderer(event, serverInfo.localServerUrl);
    return updater.install();
  });

  ipcMain.handle(DESKTOP_IPC.applyRoomServerUpdate, async (event) => {
    assertTrustedRenderer(event, serverInfo.localServerUrl);
    throw new Error("Room-service-only updates were retired. Use the signed desktop updater instead.");
  });

  ipcMain.handle(DESKTOP_IPC.installCodexIntegration, async (event, connectionId: unknown) => {
    assertTrustedRenderer(event, serverInfo.localServerUrl);
    if (process.env.PORTABLE_EXECUTABLE_FILE) {
      throw new Error(
        "Codex automatic integration requires the installed Agent Hub edition because portable app paths are temporary. Install the Setup edition, then connect Codex once from the room screen.",
      );
    }
    if (typeof connectionId !== "string" || !connectionId.trim()) {
      throw new Error("A saved room connection is required before installing the Codex integration.");
    }
    const connection = await store.get(connectionId.trim());
    if (!connection) throw new Error("The selected room connection does not exist.");

    const launcherPath = await installHeadlessLauncher({
      launcherPath: path.join(userDataDirectory, "codex", "agent-hub-headless.ps1"),
      electronExecutable: process.execPath,
      runnerPath: path.join(electronApp.getAppPath(), "dist", "companion", "headless-runner.js"),
      userDataPath: userDataDirectory,
    });
    const runnerPath = path.join(
      electronApp.getAppPath(),
      "dist",
      "companion",
      "headless-runner.js",
    );
    const hookCommand = "powershell.exe";
    const launcherArgs = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      launcherPath,
    ];
    const args = [
      runnerPath,
      "--user-data",
      userDataDirectory,
      "--mcp-bridge",
      "--connection-id",
      connection.id,
    ];
    return installCodexMcpConfig(path.join(homedir(), ".codex", "config.toml"), {
      name: codexServerName(connection.id),
      command: process.execPath,
      args,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      hookCommand,
      hookArgs: launcherArgs,
    });
  });
}

function assertTrustedRenderer(event: IpcMainInvokeEvent, localServerUrl: string): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) {
    throw new Error("Agent Hub rejected IPC from an unknown window.");
  }
  const frameUrl = event.senderFrame?.url;
  if (!frameUrl || new URL(frameUrl).origin !== new URL(localServerUrl).origin) {
    throw new Error("Agent Hub rejected IPC from an untrusted page.");
  }
}

function requireApprovedRepository(value: unknown, allowedRepositories: Set<string>): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("A repository path is required.");
  const resolved = path.resolve(value.trim());
  if (!allowedRepositories.has(pathKey(resolved))) {
    throw new Error("Choose this repository with Agent Hub before allowing local analysis.");
  }
  return resolved;
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isAddressInUse(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE");
}

function showMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
