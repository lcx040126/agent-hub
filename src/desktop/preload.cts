import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentHubDesktopApi,
  RoomServerRequestInput,
  SaveRoomConnectionInput,
} from "./contracts.js";

const channels = {
  chooseRepository: "agent-hub:choose-repository",
  inspectRepository: "agent-hub:inspect-repository",
  getServerInfo: "agent-hub:get-server-info",
  saveRoomConnection: "agent-hub:save-room-connection",
  listRoomConnections: "agent-hub:list-room-connections",
  requestRoomServer: "agent-hub:request-room-server",
  installCodexIntegration: "agent-hub:install-codex-integration",
} as const;

const desktopApi: AgentHubDesktopApi = Object.freeze({
  chooseRepository: () => ipcRenderer.invoke(channels.chooseRepository),
  inspectRepository: (repositoryPath: string) =>
    ipcRenderer.invoke(channels.inspectRepository, repositoryPath),
  getServerInfo: () => ipcRenderer.invoke(channels.getServerInfo),
  saveRoomConnection: (input: SaveRoomConnectionInput) =>
    ipcRenderer.invoke(channels.saveRoomConnection, input),
  listRoomConnections: () => ipcRenderer.invoke(channels.listRoomConnections),
  requestRoomServer: (input: RoomServerRequestInput) =>
    ipcRenderer.invoke(channels.requestRoomServer, input),
  installCodexIntegration: (connectionId: string) =>
    ipcRenderer.invoke(channels.installCodexIntegration, connectionId),
});

contextBridge.exposeInMainWorld("agentHubDesktop", desktopApi);
