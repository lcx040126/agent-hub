import type { RepositorySnapshot } from "../companion/repository.js";

export interface DesktopServerInfo {
  localServerUrl: string;
  lanUrls: string[];
  port: number;
}

export interface SaveRoomConnectionInput {
  id?: string;
  serverUrl: string;
  memberToken: string;
  repositoryPath: string;
  roomId?: string;
  roomName?: string;
  memberName?: string;
}

export interface SavedRoomConnection {
  id: string;
  serverUrl: string;
  repositoryPath: string;
  roomId?: string;
  roomName?: string;
  memberName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexInstallResult {
  configPath: string;
  backupPath?: string;
  mcpServerName: string;
  command: string;
  args: string[];
  restartRequired: true;
}

export type BootstrapRoomServerRequest =
  | {
      serverUrl: string;
      connectionId?: never;
      method: "GET";
      path: "/api/health";
      body?: never;
    }
  | {
      serverUrl: string;
      connectionId?: never;
      method: "POST";
      path: "/api/rooms" | "/api/rooms/join";
      body: unknown;
    };

export interface SavedRoomServerRequest {
  serverUrl?: never;
  connectionId: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

export type RoomServerRequestInput = BootstrapRoomServerRequest | SavedRoomServerRequest;

export interface RoomServerResponse {
  status: number;
  body: unknown;
}

export interface AgentHubDesktopApi {
  chooseRepository(): Promise<string | null>;
  inspectRepository(repositoryPath: string): Promise<RepositorySnapshot>;
  getServerInfo(): Promise<DesktopServerInfo>;
  saveRoomConnection(input: SaveRoomConnectionInput): Promise<SavedRoomConnection>;
  listRoomConnections(): Promise<SavedRoomConnection[]>;
  requestRoomServer(input: RoomServerRequestInput): Promise<RoomServerResponse>;
  installCodexIntegration(connectionId: string): Promise<CodexInstallResult>;
}

export const DESKTOP_IPC = {
  chooseRepository: "agent-hub:choose-repository",
  inspectRepository: "agent-hub:inspect-repository",
  getServerInfo: "agent-hub:get-server-info",
  saveRoomConnection: "agent-hub:save-room-connection",
  listRoomConnections: "agent-hub:list-room-connections",
  requestRoomServer: "agent-hub:request-room-server",
  installCodexIntegration: "agent-hub:install-codex-integration",
} as const;
