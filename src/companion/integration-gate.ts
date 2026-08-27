import path from "node:path";
import type { SavedRoomConnection } from "../desktop/contracts.js";
import {
  readRuntimePresence,
  RUNTIME_PRESENCE_FILENAME,
  type RuntimePresenceValidation,
} from "./runtime-presence.js";
import { hasPendingPauseForConnection } from "./pause-retry.js";
import { hasPendingPausePreparationForConnection } from "./pause-preparation.js";

export interface LocalIntegrationStatus {
  active: boolean;
  remoteAllowed: boolean;
  reason: "active" | "connection-paused" | "cleanup-pending" | RuntimePresenceValidation["status"];
  presence?: RuntimePresenceValidation;
  diagnostic?: string;
}

export async function getRuntimeIntegrationStatus(
  userDataPath: string,
  presenceFilePath?: string,
): Promise<RuntimePresenceValidation> {
  return readRuntimePresence(presenceFilePath ?? runtimePresencePath(userDataPath));
}

/** Return the path shared by the desktop process and all headless integrations. */
export function runtimePresencePath(userDataPath: string): string {
  return path.join(path.resolve(userDataPath), RUNTIME_PRESENCE_FILENAME);
}

/**
 * The local gate is intentionally fail-closed. A missing or stale desktop
 * sentinel means hooks and MCP must behave as if the connection is paused.
 */
export async function getLocalIntegrationStatus(
  userDataPath: string,
  connection: Pick<SavedRoomConnection, "id" | "integrationEnabled">,
  presenceFilePath?: string,
): Promise<LocalIntegrationStatus> {
  if (connection.integrationEnabled === false) {
    return { active: false, remoteAllowed: false, reason: "connection-paused" };
  }
  const presence = await getRuntimeIntegrationStatus(userDataPath, presenceFilePath);
  if (!presence.active) {
    return { active: false, remoteAllowed: false, reason: presence.status, presence };
  }
  try {
    if (
      await hasPendingPausePreparationForConnection(userDataPath, connection.id)
      || await hasPendingPauseForConnection(userDataPath, connection.id)
    ) {
      return {
        active: true,
        remoteAllowed: false,
        reason: "cleanup-pending",
        presence,
        diagnostic: "Agent Hub 正在等待完成上一次退出清理；本次写入不会被阻止，但暂不创建新的远端协作会话。",
      };
    }
  } catch (error) {
    return {
      active: true,
      remoteAllowed: false,
      reason: "cleanup-pending",
      presence,
      diagnostic: `Agent Hub 无法验证退出清理队列：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    active: true,
    remoteAllowed: true,
    reason: "active",
    presence,
  };
}

export function isConnectionIntegrationEnabled(
  connection: Pick<SavedRoomConnection, "integrationEnabled">,
): boolean {
  // Documents written by v0.2.0 do not have this field; the migration default
  // is enabled, matching ConnectionStore.parseStoreDocument.
  return connection.integrationEnabled !== false;
}
