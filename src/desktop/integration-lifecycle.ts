import type { IntegrationController } from "../companion/integration-controller.js";
import type { ConnectionStore } from "./connection-store.js";
import type {
  ActivateRoomConnectionResult,
  DeleteRoomConnectionResult,
  PauseRoomConnectionResult,
  RoomConnectionRecoveryStatus,
  SaveRoomConnectionInput,
  SavedRoomConnection,
} from "./contracts.js";
import type { ServiceSupervisor } from "./service-supervisor.js";

interface StoppableScheduler {
  stop(): Promise<void>;
}

export async function pauseDesktopRoomConnection(options: {
  connectionId: string;
  controller: Pick<IntegrationController, "pauseConnection">;
  store: Pick<ConnectionStore, "get" | "list">;
  localServer: Pick<ServiceSupervisor, "url" | "stop">;
}): Promise<PauseRoomConnectionResult> {
  const selected = await requireConnection(options.store, options.connectionId);
  const ownsLocalRoom = sameOrigin(selected.serverUrl, options.localServer.url);

  // pauseConnection serializes pause/reactivate for this room and disables its
  // local gate before remote cleanup. The pause transaction is the sole role
  // authority, removing the old dashboard lookup race.
  const paused = await options.controller.pauseConnection(selected.id, "leave-room");
  const pausedConnection = await requireConnection(options.store, selected.id);
  if (pausedConnection.integrationEnabled !== false) {
    throw new Error(
      paused.cleanupError
        ?? "Agent Hub could not persist the paused connection state, so the room remains open.",
    );
  }
  // Queued, failed, or malformed cleanup results never authorize disconnecting
  // other members. Only the role captured by the successful pause transaction
  // can stop the same-origin room service.
  const canStopLocalRoom = ownsLocalRoom
    && !paused.queued
    && !paused.cleanupError
    && paused.response?.memberRole === "host"
    && !(await hasOtherActiveLocalConnection(
      options.store,
      selected.id,
      options.localServer.url,
    ));
  if (canStopLocalRoom) await options.localServer.stop();
  return {
    connection: pausedConnection,
    queued: paused.queued,
    requestId: paused.requestId,
    cleanupError: paused.cleanupError,
    localRoomServerStopped: canStopLocalRoom,
  };
}

export async function activateDesktopRoomConnection(options: {
  connectionId: string;
  controller: Pick<IntegrationController, "activateExclusiveConnection" | "start">;
  localServer: Pick<ServiceSupervisor, "start">;
  onActivated?: () => Promise<void> | void;
}): Promise<ActivateRoomConnectionResult> {
  await options.localServer.start();
  const activated = await options.controller.activateExclusiveConnection(options.connectionId);
  if (activated.status === "waiting-cleanup") return activated;
  await options.controller.start();
  await options.onActivated?.();
  return activated;
}

export async function getDesktopRoomConnectionRecoveryStatus(options: {
  connectionId: string;
  controller: Pick<IntegrationController, "getConnectionRecoveryStatus">;
}): Promise<RoomConnectionRecoveryStatus> {
  return options.controller.getConnectionRecoveryStatus(options.connectionId);
}

export async function retryDesktopRoomConnectionCleanup(options: {
  connectionId: string;
  controller: Pick<IntegrationController, "retryConnectionCleanup">;
}): Promise<RoomConnectionRecoveryStatus> {
  return options.controller.retryConnectionCleanup(options.connectionId);
}

export async function saveAndActivateDesktopRoomConnection(options: {
  input: SaveRoomConnectionInput;
  controller: Pick<
    IntegrationController,
    "activateExclusiveConnection" | "rememberConnectionState" | "start"
  >;
  store: Pick<ConnectionStore, "save">;
  localServer: Pick<ServiceSupervisor, "start">;
  onActivated?: () => Promise<void> | void;
}): Promise<ActivateRoomConnectionResult> {
  const saved = await options.store.save({
    ...options.input,
    integrationEnabled: false,
  });
  options.controller.rememberConnectionState(saved.id, false);
  return activateDesktopRoomConnection({
    connectionId: saved.id,
    controller: options.controller,
    localServer: options.localServer,
    onActivated: options.onActivated,
  });
}

export async function deleteDesktopRoomConnection(options: {
  connectionId: string;
  controller: Pick<IntegrationController, "deleteConnection">;
  store: Pick<ConnectionStore, "get" | "list">;
  localServer: Pick<ServiceSupervisor, "url" | "stop">;
  uninstallCodexIntegration(context: {
    connection: SavedRoomConnection;
    isLastConnection: boolean;
  }): Promise<{ changed: boolean; restartRequired: boolean }>;
}): Promise<DeleteRoomConnectionResult> {
  const selected = await requireConnection(options.store, options.connectionId);
  const ownsLocalRoom = sameOrigin(selected.serverUrl, options.localServer.url);
  const deleted = await options.controller.deleteConnection(
    selected.id,
    options.uninstallCodexIntegration,
  );
  const warnings = [...deleted.warnings];
  if (
    ownsLocalRoom
    && deleted.remoteCleanup === "completed"
    && deleted.memberRole === "host"
  ) {
    try {
      if (!(await hasOtherActiveLocalConnection(
        options.store,
        selected.id,
        options.localServer.url,
      ))) {
        await options.localServer.stop();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(
        `The room was removed from this computer, but Agent Hub could not stop the local room service: ${message}`,
      );
    }
  }
  return {
    deletedConnectionId: deleted.deletedConnectionId,
    remoteCleanup: deleted.remoteCleanup,
    codexConfigChanged: deleted.cleanup.changed,
    codexRestartRequired: deleted.cleanup.restartRequired,
    warnings,
  };
}

export async function shutdownDesktopIntegration(options: {
  schedulers: Array<StoppableScheduler | null | undefined>;
  controller: Pick<IntegrationController, "deactivateLocalGate" | "shutdown"> | null | undefined;
  localServer: Pick<ServiceSupervisor, "stop"> | null | undefined;
}): Promise<void> {
  const failures: unknown[] = [];

  // The sentinel is the process-wide safety boundary. Close it before waiting
  // for a slow scan or heartbeat so Hook/MCP calls become inert immediately.
  await captureFailure(() => options.controller?.deactivateLocalGate(), failures);
  const schedulerResults = await Promise.allSettled(
    options.schedulers.map((scheduler) => scheduler?.stop()),
  );
  for (const result of schedulerResults) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  await captureFailure(() => options.controller?.shutdown("app-shutdown"), failures);
  // A cleanup failure must never leave the local room child process orphaned.
  await captureFailure(() => options.localServer?.stop(), failures);

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Agent Hub desktop shutdown encountered multiple cleanup failures.");
  }
}

export async function enterDesktopMaintenance(options: {
  controller: Pick<IntegrationController, "enterMaintenance"> | null | undefined;
  scanner: StoppableScheduler | null | undefined;
  localServer: Pick<ServiceSupervisor, "stop"> | null | undefined;
}): Promise<void> {
  const failures: unknown[] = [];
  // Preserve the safety order, but attempt every transition so a partial
  // failure cannot leave a producer running behind a stopped room service.
  await captureFailure(() => options.controller?.enterMaintenance(), failures);
  await captureFailure(() => options.scanner?.stop(), failures);
  await captureFailure(() => options.localServer?.stop(), failures);

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "Agent Hub maintenance entry encountered multiple failures.",
    );
  }
}

export async function recoverDesktopMaintenance(options: {
  controller: Pick<IntegrationController, "resumeAfterMaintenance"> | null | undefined;
  localServer: Pick<ServiceSupervisor, "start"> | null | undefined;
  restartSchedulers?: Array<() => Promise<unknown> | unknown>;
}): Promise<void> {
  const failures: unknown[] = [];
  const coreResults = await Promise.allSettled([
    Promise.resolve().then(() => options.localServer?.start()),
    Promise.resolve().then(() => options.controller?.resumeAfterMaintenance()),
  ]);
  for (const result of coreResults) {
    if (result.status === "rejected") failures.push(result.reason);
  }

  const schedulerResults = await Promise.allSettled(
    (options.restartSchedulers ?? []).map((restart) => Promise.resolve().then(restart)),
  );
  for (const result of schedulerResults) {
    if (result.status === "rejected") failures.push(result.reason);
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "Agent Hub maintenance recovery encountered multiple failures.",
    );
  }
}

export function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

/** Only an explicit local create/join action may restart a stopped host service. */
export function shouldStartLocalRoomService(input: unknown, localServerUrl: string): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  if (typeof value.connectionId === "string" && value.connectionId.trim()) return false;
  if (typeof value.method !== "string" || value.method.trim().toUpperCase() !== "POST") return false;
  if (value.path !== "/api/rooms" && value.path !== "/api/rooms/join") return false;
  return typeof value.serverUrl === "string" && sameOrigin(value.serverUrl, localServerUrl);
}

async function requireConnection(
  store: Pick<ConnectionStore, "get">,
  connectionId: string,
): Promise<SavedRoomConnection> {
  const connection = await store.get(connectionId);
  if (!connection) throw new Error("The selected room connection does not exist.");
  return connection;
}

async function hasOtherActiveLocalConnection(
  store: Pick<ConnectionStore, "list">,
  excludedConnectionId: string,
  localServerUrl: string,
): Promise<boolean> {
  return (await store.list()).some((connection) =>
    connection.id !== excludedConnectionId
    && connection.integrationEnabled !== false
    && sameOrigin(connection.serverUrl, localServerUrl));
}

async function captureFailure(
  operation: () => Promise<unknown> | undefined,
  failures: unknown[],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
}
