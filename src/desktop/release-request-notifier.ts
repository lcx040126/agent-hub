import { canonicalRepositoryIdentity, type ConnectionStore } from "./connection-store.js";
import type { RoomServerResponse, SavedRoomConnection } from "./contracts.js";
import { requestRoomServer } from "./room-server-proxy.js";

export interface PendingReleaseRequestNotification {
  id: string;
  requesterName: string;
  requestTitle: string;
  requestedPaths: string[];
}

export interface ReleaseRequestNotificationScheduler {
  scanNow(): Promise<void>;
  stop(): Promise<void>;
}

interface ConnectionLookup {
  list(): ReturnType<ConnectionStore["list"]>;
  get(connectionId: string): ReturnType<ConnectionStore["get"]>;
  readMemberToken(connectionId: string): ReturnType<ConnectionStore["readMemberToken"]>;
}

type Requester = (
  input: unknown,
  store: Pick<ConnectionLookup, "get" | "readMemberToken">,
) => Promise<RoomServerResponse>;

export interface StartReleaseRequestNotifierOptions {
  store: ConnectionLookup;
  intervalMs?: number;
  request?: Requester;
  notify(request: PendingReleaseRequestNotification, connection: SavedRoomConnection): void;
  onError?: (error: Error, connection?: SavedRoomConnection) => void;
}

const DEFAULT_INTERVAL_MS = 15_000;
const MAX_REMEMBERED_NOTIFICATIONS = 2_000;

export function startReleaseRequestNotificationScheduler(
  options: StartReleaseRequestNotifierOptions,
): ReleaseRequestNotificationScheduler {
  const notified = new Set<string>();
  let stopped = false;
  let running: Promise<void> | undefined;
  const scanNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = notifyPendingRequests(options, notified)
      .catch((error: unknown) => options.onError?.(toError(error)))
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  void scanNow();
  const timer = setInterval(() => void scanNow(), options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  return {
    scanNow,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}

async function notifyPendingRequests(
  options: StartReleaseRequestNotifierOptions,
  notified: Set<string>,
): Promise<void> {
  const activeConnections = (await options.store.list())
    .filter((connection) => connection.integrationEnabled !== false);
  const byRepository = new Map<string, SavedRoomConnection[]>();
  for (const connection of activeConnections) {
    const identity = await canonicalRepositoryIdentity(connection.repositoryPath);
    const matching = byRepository.get(identity) ?? [];
    matching.push(connection);
    byRepository.set(identity, matching);
  }
  const connections: SavedRoomConnection[] = [];
  for (const [identity, matching] of byRepository) {
    if (matching.length === 1) connections.push(matching[0]!);
    else options.onError?.(new Error(
      `Agent Hub skipped notifications because repository ${identity} has multiple active room connections.`,
    ));
  }
  const requester = options.request ?? requestRoomServer;
  await Promise.all(connections.map(async (connection) => {
    try {
      const response = await requester({
        connectionId: connection.id,
        method: "GET",
        path: "/api/release-requests?status=pending",
      }, options.store);
      if (response.status < 200 || response.status >= 300) return;
      const payload = record(response.body);
      const currentMemberId = text(payload.currentMemberId);
      if (!currentMemberId) return;
      const requests = Array.isArray(payload.releaseRequests) ? payload.releaseRequests : [];
      for (const value of requests) {
        const request = record(value);
        if (text(request.status) !== "pending" || text(request.holderMemberId) !== currentMemberId) continue;
        const id = text(request.id);
        if (!id) continue;
        const notificationKey = `${connection.id}:${id}`;
        if (notified.has(notificationKey)) continue;
        notified.add(notificationKey);
        trimRememberedNotifications(notified);
        options.notify({
          id,
          requesterName: text(request.requesterName) || "团队成员",
          requestTitle: text(request.requestTitle) || "请求修改受保护范围",
          requestedPaths: stringArray(request.requestedPaths),
        }, connection);
      }
    } catch (error) {
      options.onError?.(toError(error), connection);
    }
  }));
}

function trimRememberedNotifications(notified: Set<string>): void {
  while (notified.size > MAX_REMEMBERED_NOTIFICATIONS) {
    const oldest = notified.values().next().value as string | undefined;
    if (!oldest) return;
    notified.delete(oldest);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
