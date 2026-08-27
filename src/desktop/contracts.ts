import type { RepositorySnapshot } from "../companion/repository.js";

export interface DesktopServerInfo {
  localServerUrl: string;
  lanUrls: string[];
  port: number;
  appVersion: string;
  protocolVersion: number;
  schemaVersion: number;
}

export type DesktopUpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "failed";

export interface DesktopUpdateStatus {
  phase: DesktopUpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  publishedAt?: string;
  notes?: string;
  sizeBytes?: number;
  progressPercent?: number;
  transferredBytes?: number;
  bytesPerSecond?: number;
  checkedAt?: string;
  error?: string;
  canRetry: boolean;
}

export interface SaveRoomConnectionInput {
  id?: string;
  serverUrl: string;
  memberToken: string;
  repositoryPath: string;
  roomId?: string;
  roomName?: string;
  memberName?: string;
  memberRole?: "host" | "member";
  /** Local gate for Codex hooks and MCP. Omitted values preserve current state on update. */
  integrationEnabled?: boolean;
  /** Whether Agent Hub has installed this connection into the local Codex config. */
  codexIntegrationInstalled?: boolean;
}

export interface SavedRoomConnection {
  id: string;
  serverUrl: string;
  repositoryPath: string;
  roomId?: string;
  roomName?: string;
  memberName?: string;
  /** Missing only for legacy v0.2.0 documents that did not persist the role. */
  memberRole?: "host" | "member";
  integrationEnabled: boolean;
  /** Undefined only for legacy documents whose Codex installation intent has not been migrated yet. */
  codexIntegrationInstalled?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PauseRoomConnectionResult {
  connection: SavedRoomConnection;
  queued: boolean;
  requestId: string;
  cleanupError?: string;
  localRoomServerStopped: boolean;
}

export interface ActivateRoomConnectionResult {
  connection: SavedRoomConnection;
  pausedConnectionIds: string[];
  warnings: string[];
}

export interface DeleteRoomConnectionResult {
  deletedConnectionId: string;
  remoteCleanup: "completed" | "pending" | "skipped";
  codexConfigChanged: boolean;
  codexRestartRequired: boolean;
  warnings: string[];
}

export interface CodexInstallResult {
  configPath: string;
  backupPath?: string;
  mcpServerName: string;
  command: string;
  args: string[];
  restartRequired: boolean;
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
  saveRoomConnection(input: SaveRoomConnectionInput): Promise<ActivateRoomConnectionResult>;
  listRoomConnections(): Promise<SavedRoomConnection[]>;
  pauseRoomConnection(connectionId: string): Promise<PauseRoomConnectionResult>;
  activateRoomConnection(connectionId: string): Promise<ActivateRoomConnectionResult>;
  deleteRoomConnection(connectionId: string): Promise<DeleteRoomConnectionResult>;
  requestRoomServer(input: RoomServerRequestInput): Promise<RoomServerResponse>;
  installCodexIntegration(connectionId: string): Promise<CodexInstallResult>;
  getDesktopUpdateStatus(): Promise<DesktopUpdateStatus>;
  checkDesktopUpdate(): Promise<DesktopUpdateStatus>;
  downloadDesktopUpdate(): Promise<DesktopUpdateStatus>;
  installDesktopUpdate(): Promise<DesktopUpdateStatus>;
  onDesktopUpdateStatus(listener: (status: DesktopUpdateStatus) => void): () => void;
  /** @deprecated Room-service-only script updates were retired in 0.2.0. */
  applyRoomServerUpdate(): Promise<{ restarted: true; port: number }>;
}

export const DESKTOP_IPC = {
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
