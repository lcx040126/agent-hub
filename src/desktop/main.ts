import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app as electronApp,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";
import { inspectRepository } from "../companion/repository.js";
import { WindowsDpapiProtector } from "../companion/windows-dpapi.js";
import {
  startRepositoryScanScheduler,
  type RepositoryScanScheduler,
} from "../companion/scan-scheduler.js";
import { installCodexMcpConfig, codexServerName } from "./codex-config.js";
import { CONNECTION_STORE_FILENAME, ConnectionStore } from "./connection-store.js";
import { DESKTOP_IPC, type SaveRoomConnectionInput, type DesktopServerInfo } from "./contracts.js";
import { installHeadlessLauncher } from "./headless-launcher.js";
import { candidatePorts, collectLanUrls } from "./network.js";
import { requestRoomServer } from "./room-server-proxy.js";
import { createServiceSupervisor, type ServiceSupervisor } from "./service-supervisor.js";

const HOST = "0.0.0.0";
const PREFERRED_PORT = 4173;
const noTray = process.argv.includes("--no-tray");

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let hostServer: ServiceSupervisor | null = null;
let scanScheduler: RepositoryScanScheduler | null = null;
let isQuitting = false;

startDesktopLifecycle();

function startDesktopLifecycle(): void {
  if (!electronApp.requestSingleInstanceLock()) {
    electronApp.quit();
    return;
  }
  electronApp.on("second-instance", () => showMainWindow());
  electronApp.on("before-quit", () => {
    isQuitting = true;
    scanScheduler?.stop();
    scanScheduler = null;
    void hostServer?.stop();
    hostServer = null;
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
  const serviceScript = path.join(electronApp.getAppPath(), "dist", "server", "index.js");
  const servicePort = await findAvailableServicePort();
  hostServer = createServiceSupervisor({
    executable: process.execPath,
    scriptPath: serviceScript,
    port: servicePort,
    dataDir: path.join(userDataDirectory, "server"),
    env: { AGENT_HUB_UPDATE_MANIFEST_URL: process.env.AGENT_HUB_UPDATE_MANIFEST_URL },
  });
  await hostServer.start();
  const serverInfo: DesktopServerInfo = {
    localServerUrl: hostServer.url,
    lanUrls: collectLanUrls(hostServer.port, networkInterfaces()),
    port: hostServer.port,
  };
  const store = new ConnectionStore(
    path.join(userDataDirectory, CONNECTION_STORE_FILENAME),
    new WindowsDpapiProtector(),
  );
  scanScheduler = startRepositoryScanScheduler({
    store,
    onError(error, connection) {
      const repository = connection?.repositoryPath ? ` (${connection.repositoryPath})` : "";
      console.error(`Agent Hub repository scan failed${repository}: ${error.message}`);
    },
  });

  registerIpc(serverInfo, store, userDataDirectory);
  mainWindow = createMainWindow(serverInfo.localServerUrl);
  if (!noTray) createTray(serverInfo);
  await mainWindow.loadURL(serverInfo.localServerUrl);
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
          isQuitting = true;
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

  ipcMain.handle(DESKTOP_IPC.saveRoomConnection, async (event, input: SaveRoomConnectionInput) => {
    assertTrustedRenderer(event, serverInfo.localServerUrl);
    requireApprovedRepository(input?.repositoryPath, allowedRepositories);
    const saved = await store.save(input);
    allowedRepositories.add(pathKey(saved.repositoryPath));
    await scanScheduler?.scanNow();
    return saved;
  });

  ipcMain.handle(DESKTOP_IPC.requestRoomServer, async (event, input: unknown) => {
    assertTrustedRenderer(event, serverInfo.localServerUrl);
    return requestRoomServer(input, store);
  });

  ipcMain.handle(DESKTOP_IPC.applyRoomServerUpdate, async (event) => {
    assertTrustedRenderer(event, serverInfo.localServerUrl);
    if (!hostServer) throw new Error("The local room service is not running.");
    const connections = await store.list();
    const local = connections.find((connection) => connection.serverUrl === serverInfo.localServerUrl);
    if (!local) throw new Error("Save the local room connection before applying an update.");
    const token = await store.readMemberToken(local.id);
    const response = await fetch(`${serverInfo.localServerUrl}/api/update/status`, { headers: { Authorization: `Bearer ${token}` } });
    const payload = await response.json() as { update?: { state?: string; stagedPath?: string } };
    if (payload.update?.state !== "staged" || !payload.update.stagedPath) throw new Error("No verified update package is ready.");
    await hostServer.restartWithScript(payload.update.stagedPath);
    return { restarted: true as const, port: hostServer.port };
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
