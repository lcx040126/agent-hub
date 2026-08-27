import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AgentHubDesktopApi,
  DesktopUpdateStatus,
  RoomServerRequestInput,
  SaveRoomConnectionInput,
} from "./contracts.js";

const channels = {
  chooseRepository: "agent-hub:choose-repository",
  inspectRepository: "agent-hub:inspect-repository",
  getServerInfo: "agent-hub:get-server-info",
  saveRoomConnection: "agent-hub:save-room-connection",
  listRoomConnections: "agent-hub:list-room-connections",
  pauseRoomConnection: "agent-hub:pause-room-connection",
  activateRoomConnection: "agent-hub:activate-room-connection",
  deleteRoomConnection: "agent-hub:delete-room-connection",
  requestRoomServer: "agent-hub:request-room-server",
  installCodexIntegration: "agent-hub:install-codex-integration",
  getDesktopUpdateStatus: "agent-hub:get-desktop-update-status",
  checkDesktopUpdate: "agent-hub:check-desktop-update",
  downloadDesktopUpdate: "agent-hub:download-desktop-update",
  installDesktopUpdate: "agent-hub:install-desktop-update",
  desktopUpdateStatus: "agent-hub:desktop-update-status",
  applyRoomServerUpdate: "agent-hub:apply-room-server-update",
} as const;

const desktopApi: AgentHubDesktopApi = Object.freeze({
  chooseRepository: () => ipcRenderer.invoke(channels.chooseRepository),
  inspectRepository: (repositoryPath: string) =>
    ipcRenderer.invoke(channels.inspectRepository, repositoryPath),
  getServerInfo: () => ipcRenderer.invoke(channels.getServerInfo),
  saveRoomConnection: (input: SaveRoomConnectionInput) =>
    ipcRenderer.invoke(channels.saveRoomConnection, input),
  listRoomConnections: () => ipcRenderer.invoke(channels.listRoomConnections),
  pauseRoomConnection: (connectionId: string) =>
    ipcRenderer.invoke(channels.pauseRoomConnection, connectionId),
  activateRoomConnection: (connectionId: string) =>
    ipcRenderer.invoke(channels.activateRoomConnection, connectionId),
  deleteRoomConnection: (connectionId: string) =>
    ipcRenderer.invoke(channels.deleteRoomConnection, connectionId),
  requestRoomServer: (input: RoomServerRequestInput) =>
    ipcRenderer.invoke(channels.requestRoomServer, input),
  installCodexIntegration: (connectionId: string) =>
    ipcRenderer.invoke(channels.installCodexIntegration, connectionId),
  getDesktopUpdateStatus: () => ipcRenderer.invoke(channels.getDesktopUpdateStatus),
  checkDesktopUpdate: () => ipcRenderer.invoke(channels.checkDesktopUpdate),
  downloadDesktopUpdate: () => ipcRenderer.invoke(channels.downloadDesktopUpdate),
  installDesktopUpdate: () => ipcRenderer.invoke(channels.installDesktopUpdate),
  onDesktopUpdateStatus: (listener: (status: DesktopUpdateStatus) => void) => {
    const handler = (_event: IpcRendererEvent, status: DesktopUpdateStatus) => listener(status);
    ipcRenderer.on(channels.desktopUpdateStatus, handler);
    return () => ipcRenderer.removeListener(channels.desktopUpdateStatus, handler);
  },
  applyRoomServerUpdate: () => ipcRenderer.invoke(channels.applyRoomServerUpdate),
});

contextBridge.exposeInMainWorld("agentHubDesktop", desktopApi);
