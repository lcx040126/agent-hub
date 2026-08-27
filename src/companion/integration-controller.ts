import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  canonicalRepositoryIdentity,
  type ConnectionStore,
} from "../desktop/connection-store.js";
import type { SavedRoomConnection } from "../desktop/contracts.js";
import { CodexHookStateStore } from "./hook-state.js";
import { SessionEndQueueStore } from "./session-end-queue.js";
import { TurnCompletionQueueStore } from "./turn-completion-queue.js";
import {
  IntegrationOperationTracker,
  type ConnectionOperationTracker,
} from "./integration-operations.js";
import {
  RUNTIME_PRESENCE_FILENAME,
  startRuntimePresence,
  type RuntimePresenceHandle,
} from "./runtime-presence.js";
import {
  PAUSE_RETRY_FILENAME,
  PauseRetryQueue,
  hasPendingPauseForConnection,
  requestMemberPause,
  type PauseReason,
  type PauseRequestResult,
} from "./pause-retry.js";
import {
  PAUSE_PREPARATION_FILENAME,
  PausePreparationQueue,
} from "./pause-preparation.js";

export interface IntegrationControllerOptions {
  userDataPath: string;
  store: ConnectionStore;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  onError?: (error: Error) => void;
  startPresence?: typeof startRuntimePresence;
  operationTracker?: Pick<ConnectionOperationTracker, "drain">
    & Partial<Pick<ConnectionOperationTracker, "removeConnectionState">>;
}

export interface ExclusiveConnectionActivationResult {
  connection: SavedRoomConnection;
  pausedConnectionIds: string[];
  warnings: string[];
}

export interface ConnectionDeletionCleanupContext {
  connection: SavedRoomConnection;
  isLastConnection: boolean;
}

export interface ConnectionDeletionResult<TCleanup> {
  deletedConnectionId: string;
  remoteCleanup: "completed" | "pending";
  memberRole?: "host" | "member";
  warnings: string[];
  cleanup: TCleanup;
}

/** Coordinates the local gate, durable cleanup, and desktop lifecycle states. */
export class IntegrationController {
  readonly pauseQueue: PauseRetryQueue;
  readonly pausePreparationQueue: PausePreparationQueue;
  private readonly options: IntegrationControllerOptions;
  private presence: RuntimePresenceHandle | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private startPromise: Promise<void> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryPromise: Promise<void> | undefined;
  private preparationRetryPromise: Promise<number> | undefined;
  private readonly preparedPauseTasks = new Map<string, Promise<PauseRequestResult>>();
  private readonly connectionLifecycle = new Map<string, Promise<void>>();
  private readonly repositoryLifecycle = new Map<string, Promise<void>>();
  private deletionLifecycle: Promise<void> = Promise.resolve();
  private readonly knownActiveConnectionIds = new Set<string>();
  private forcePreparationsOnNextRetry = false;
  private shutdownRequested = false;
  private readonly operationTracker: Pick<ConnectionOperationTracker, "drain">
    & Partial<Pick<ConnectionOperationTracker, "removeConnectionState">>;

  constructor(options: IntegrationControllerOptions) {
    this.options = options;
    this.operationTracker = options.operationTracker
      ?? new IntegrationOperationTracker(options.userDataPath);
    this.pauseQueue = new PauseRetryQueue({
      filePath: path.join(path.resolve(options.userDataPath), PAUSE_RETRY_FILENAME),
      store: options.store,
      fetchImpl: options.fetchImpl,
      now: options.now,
      onError: options.onError,
    });
    this.pausePreparationQueue = new PausePreparationQueue({
      filePath: path.join(path.resolve(options.userDataPath), PAUSE_PREPARATION_FILENAME),
      now: options.now,
    });
  }

  async start(): Promise<void> {
    if (this.shutdownRequested || this.shutdownPromise) {
      throw new Error("Agent Hub integration cannot start while desktop shutdown is in progress.");
    }
    if (this.presence?.record.status === "active") return;
    if (this.presence?.record.status === "maintenance") return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const normalizedConnectionIds = await this.options.store.normalizeRepositoryIntegrationOwners();
    if (normalizedConnectionIds.length > 0) {
      await new CodexHookStateStore(this.options.userDataPath)
        .removeForConnections(normalizedConnectionIds);
      await new TurnCompletionQueueStore(this.options.userDataPath)
        .removeForConnections(normalizedConnectionIds);
      for (const connectionId of normalizedConnectionIds) {
        this.knownActiveConnectionIds.delete(connectionId);
      }
    }
    const activeConnections = await this.options.store.listActive();
    this.replaceKnownActiveConnections(activeConnections.map((connection) => connection.id));
    const startPresence = this.options.startPresence ?? startRuntimePresence;
    this.presence = await startPresence(
      path.join(path.resolve(this.options.userDataPath), RUNTIME_PRESENCE_FILENAME),
      { onError: this.options.onError },
    );
    // Recovery runs in the background. The file-based per-connection pending
    // gate keeps affected rooms remote-disabled while unrelated rooms and the
    // desktop remain available.
    this.forcePreparationsOnNextRetry = true;
    this.schedulePauseRetry(0);
  }

  async pauseConnection(connectionId: string, reason: PauseReason = "leave-room"): Promise<PauseRequestResult> {
    if (this.shutdownRequested || this.shutdownPromise) {
      throw new Error("Agent Hub cannot pause a room while desktop shutdown is in progress.");
    }
    return this.withRepositoryConnectionLifecycle(connectionId, () =>
      this.pauseConnectionInternal(connectionId, reason));
  }

  private async pauseConnectionInternal(
    connectionId: string,
    reason: PauseReason,
  ): Promise<PauseRequestResult> {
    const requestId = randomUUID();
    try {
      // Persist before changing local state or waiting for drain. A forced
      // process termination at any later point can safely resume preparation.
      await this.pausePreparationQueue.enqueue({ connectionId, reason, requestId });
    } catch (error) {
      const failure = toError(error);
      this.options.onError?.(failure);
      return {
        queued: false,
        requestId,
        cleanupError: `Agent Hub could not persist cleanup before pausing: ${failure.message}`,
        failureKind: "local",
      };
    }

    try {
      await this.options.store.pauseIntegration(connectionId);
    } catch (error) {
      this.options.onError?.(toError(error));
      this.schedulePauseRetry();
      throw error;
    }
    this.knownActiveConnectionIds.delete(connectionId);
    await new CodexHookStateStore(this.options.userDataPath)
      .removeForConnection(connectionId)
      .catch((error: unknown) => this.options.onError?.(toError(error)));
    await new TurnCompletionQueueStore(this.options.userDataPath)
      .removeForConnection(connectionId)
      .catch((error: unknown) => this.options.onError?.(toError(error)));
    return this.completePreparedPause(connectionId, reason, requestId);
  }

  private async completePreparedPause(
    connectionId: string,
    reason: PauseReason,
    requestId: string,
  ): Promise<PauseRequestResult> {
    const existing = this.preparedPauseTasks.get(requestId);
    if (existing) return existing;
    const task = this.completePreparedPauseInternal(connectionId, reason, requestId)
      .finally(() => {
        if (this.preparedPauseTasks.get(requestId) === task) {
          this.preparedPauseTasks.delete(requestId);
        }
      });
    this.preparedPauseTasks.set(requestId, task);
    return task;
  }

  private async completePreparedPauseInternal(
    connectionId: string,
    reason: PauseReason,
    requestId: string,
  ): Promise<PauseRequestResult> {
    try {
      await this.operationTracker.drain(connectionId);
      await new CodexHookStateStore(this.options.userDataPath).removeForConnection(connectionId);
      await new TurnCompletionQueueStore(this.options.userDataPath).removeForConnection(connectionId);
    } catch (error) {
      const drainError = toError(error);
      this.options.onError?.(drainError);
      try {
        await this.pausePreparationQueue.defer(requestId, drainError);
        this.schedulePauseRetry();
        return { queued: true, requestId, cleanupError: drainError.message, failureKind: "local" };
      } catch (queueError) {
        const persistenceError = toError(queueError);
        this.options.onError?.(persistenceError);
        return {
          queued: false,
          requestId,
          cleanupError: `${drainError.message} Cleanup retry could not be updated: ${persistenceError.message}`,
          failureKind: "local",
        };
      }
    }

    let result: PauseRequestResult;
    try {
      result = await requestMemberPause(this.options.store, connectionId, reason, {
        fetchImpl: this.options.fetchImpl,
        now: this.options.now,
        queue: this.pauseQueue,
        requestId,
        queueCompletion: "retain",
      });
    } catch (error) {
      const failure = toError(error);
      this.options.onError?.(failure);
      await this.pausePreparationQueue.defer(requestId, failure);
      this.schedulePauseRetry();
      return { queued: true, requestId, cleanupError: failure.message, failureKind: "local" };
    }
    if (result.cleanupError) this.options.onError?.(new Error(result.cleanupError));
    try {
      await this.pausePreparationQueue.remove(requestId);
    } catch (error) {
      const failure = toError(error);
      this.options.onError?.(failure);
      this.schedulePauseRetry();
      return {
        queued: true,
        requestId,
        cleanupError: result.queued
          ? `${result.cleanupError ?? "Remote cleanup is still pending."} Its local preparation record could not be removed: ${failure.message}`
          : `Remote cleanup completed, but its local recovery record could not be removed: ${failure.message}`,
        failureKind: "local",
        response: result.response,
      };
    }
    if (!result.queued) {
      try {
        await this.pauseQueue.remove(requestId);
      } catch (error) {
        const failure = toError(error);
        this.options.onError?.(failure);
        this.schedulePauseRetry();
        return {
          queued: true,
          requestId,
          cleanupError: `Remote cleanup completed, but its fixed retry record could not be removed: ${failure.message}`,
          failureKind: "local",
          response: result.response,
        };
      }
    }
    if (result.queued) this.schedulePauseRetry();
    return result;
  }

  async activateConnection(connectionId: string): Promise<void> {
    await this.activateExclusiveConnection(connectionId);
  }

  async activateExclusiveConnection(
    connectionId: string,
  ): Promise<ExclusiveConnectionActivationResult> {
    const selected = await this.requireConnection(connectionId);
    const repositoryIdentity = await canonicalRepositoryIdentity(selected.repositoryPath);
    return this.withRepositoryLifecycle(repositoryIdentity, async () => {
      if (this.shutdownRequested || this.shutdownPromise) {
        throw new Error("Agent Hub cannot reactivate a room while desktop shutdown is in progress.");
      }
      const target = await this.requireConnection(connectionId);
      const activeConnections = await this.options.store.listActive();
      const peers: SavedRoomConnection[] = [];
      for (const connection of activeConnections) {
        if (connection.id === target.id) continue;
        if (await canonicalRepositoryIdentity(connection.repositoryPath) === repositoryIdentity) {
          peers.push(connection);
        }
      }

      const pausedConnectionIds: string[] = [];
      const warnings: string[] = [];
      if (target.integrationEnabled !== false && peers.length > 0) {
        const safetyPause = await this.options.store.setRepositoryIntegrationOwner(
          target.repositoryPath,
          null,
        );
        for (const pausedId of safetyPause.pausedConnectionIds) {
          this.knownActiveConnectionIds.delete(pausedId);
        }
        await this.operationTracker.drain(target.id);
        await new CodexHookStateStore(this.options.userDataPath).removeForConnection(target.id);
        await new TurnCompletionQueueStore(this.options.userDataPath).removeForConnection(target.id);
      }
      for (const peer of peers) {
        const result = await this.withConnectionLifecycle(peer.id, () =>
          this.pauseConnectionInternal(peer.id, "leave-room"));
        if (result.failureKind === "local") {
          throw new Error(
            `Agent Hub paused the previous room locally but could not safely finish its local cleanup: ${result.cleanupError ?? "unknown local cleanup failure"}`,
          );
        }
        if (result.failureKind === "remote") {
          throw new Error(
            `Agent Hub paused the previous room locally, but the room rejected cleanup: ${result.cleanupError ?? "unknown remote cleanup failure"}`,
          );
        }
        if (result.failureKind === "transient-remote") {
          warnings.push(
            `The previous room is temporarily unreachable. Its remote sessions or leases are still queued for cleanup: ${result.cleanupError ?? "temporary network failure"}`,
          );
        }
        pausedConnectionIds.push(peer.id);
      }

      const connection = await this.withConnectionLifecycle(target.id, async () => {
        // Keep this connection disabled until any pre-cutoff cleanup intent has
        // drained and moved to a fixed-cutoff request. The process-wide sentinel
        // may already be active for other rooms.
        const pendingPreparations = await this.flushPausePreparations(true, target.id);
        if (pendingPreparations > 0) {
          throw new Error(
            "Agent Hub cannot reactivate this room while an earlier cleanup is still waiting for operations to drain.",
          );
        }
        await this.flushFixedPauseRetries();
        if (await hasPendingPauseForConnection(this.options.userDataPath, target.id)) {
          throw new Error(
            "Agent Hub cannot reactivate this room until its previous remote cleanup reaches the room server.",
          );
        }
        const ownership = await this.options.store.setRepositoryIntegrationOwner(
          target.repositoryPath,
          target.id,
        );
        for (const pausedId of ownership.pausedConnectionIds) {
          this.knownActiveConnectionIds.delete(pausedId);
          if (!pausedConnectionIds.includes(pausedId)) pausedConnectionIds.push(pausedId);
        }
        if (!ownership.owner) throw new Error("Agent Hub could not activate the selected room connection.");
        this.knownActiveConnectionIds.add(target.id);
        return ownership.owner;
      });

      return {
        connection,
        pausedConnectionIds: pausedConnectionIds.sort(),
        warnings,
      };
    });
  }

  async deleteConnection<TCleanup>(
    connectionId: string,
    cleanupLocalConfiguration: (
      context: ConnectionDeletionCleanupContext,
    ) => Promise<TCleanup>,
  ): Promise<ConnectionDeletionResult<TCleanup>> {
    const selected = await this.requireConnection(connectionId);
    const repositoryIdentity = await canonicalRepositoryIdentity(selected.repositoryPath);
    return this.withDeletionLifecycle(() =>
      this.withRepositoryLifecycle(repositoryIdentity, () =>
        this.withConnectionLifecycle(connectionId, async () => {
        if (this.shutdownRequested || this.shutdownPromise) {
          throw new Error("Agent Hub cannot remove a room while desktop shutdown is in progress.");
        }
        const connection = await this.requireConnection(connectionId);
        const paused = await this.pauseConnectionInternal(connection.id, "leave-room");
        if (paused.failureKind === "local") {
          throw new Error(
            `Agent Hub kept the room connection paused because local cleanup did not finish safely: ${paused.cleanupError ?? "unknown local cleanup failure"}`,
          );
        }
        if (paused.failureKind === "remote") {
          throw new Error(
            `Agent Hub kept the room connection paused because the room rejected member cleanup: ${paused.cleanupError ?? "unknown remote cleanup failure"}`,
          );
        }

        const warnings: string[] = [];
        const remoteCleanup = paused.failureKind === "transient-remote" ? "pending" : "completed";
        if (remoteCleanup === "pending") {
          warnings.push(
            `The room is temporarily unreachable. Local data was removed, but remote sessions or leases may remain until the room reconnects or they expire: ${paused.cleanupError ?? "temporary network failure"}`,
          );
        }

        this.clearPauseRetryTimer();
        if (this.retryPromise) await this.retryPromise;
        if (this.preparationRetryPromise) await this.preparationRetryPromise;
        await this.pausePreparationQueue.removeForConnection(connection.id);
        await this.pauseQueue.removeForConnection(connection.id);
        await new CodexHookStateStore(this.options.userDataPath).removeForConnection(connection.id);
        await new SessionEndQueueStore(this.options.userDataPath).removeForConnection(connection.id);
        await new TurnCompletionQueueStore(this.options.userDataPath).removeForConnection(connection.id);
        await this.operationTracker.removeConnectionState?.(connection.id);

        const remainingConnections = (await this.options.store.list())
          .filter((candidate) => candidate.id !== connection.id);
        const cleanup = await cleanupLocalConfiguration({
          connection,
          isLastConnection: remainingConnections.length === 0,
        });
        const removed = await this.options.store.remove(connection.id);
        if (!removed) {
          throw new Error("The room connection disappeared before Agent Hub could finish removing it.");
        }
        this.knownActiveConnectionIds.delete(connection.id);
        this.schedulePauseRetry();
        return {
          deletedConnectionId: connection.id,
          remoteCleanup,
          memberRole: paused.response?.memberRole,
          warnings,
          cleanup,
        };
        })));
  }

  /** Keep the shutdown fallback current when the desktop saves a connection. */
  rememberConnectionState(connectionId: string, integrationEnabled: boolean): void {
    if (integrationEnabled) this.knownActiveConnectionIds.add(connectionId);
    else this.knownActiveConnectionIds.delete(connectionId);
  }

  /** Disable all local integrations immediately, then attempt remote cleanup. */
  async shutdown(reason: Exclude<PauseReason, "leave-room"> = "app-shutdown"): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownRequested = true;
    const shutdownPromise = (async () => {
      this.clearPauseRetryTimer();
      await this.deactivateLocalGate()
        .catch((error: unknown) => this.options.onError?.(toError(error)));
      // If startup already owns the sentinel creation path, let it finish and
      // then close the resulting sentinel. A start requested after this point
      // is rejected by shutdownRequested.
      if (this.startPromise) {
        await this.startPromise.catch((error: unknown) => this.options.onError?.(toError(error)));
      }
      await this.deactivateLocalGate()
        .catch((error: unknown) => this.options.onError?.(toError(error)));
      // Finish any room-level pause/activate transition that began before the
      // shutdown flag. New activation is rejected above.
      await Promise.all([
        this.deletionLifecycle,
        ...this.repositoryLifecycle.values(),
        ...this.connectionLifecycle.values(),
      ]);
      const uncompensatedFailures: Error[] = [];
      let connectionIds: string[];
      try {
        const connections = await this.options.store.listActive();
        connectionIds = connections.map((connection) => connection.id);
        this.replaceKnownActiveConnections(connectionIds);
      } catch (error) {
        const failure = toError(error);
        this.options.onError?.(failure);
        connectionIds = [...this.knownActiveConnectionIds];
        if (connectionIds.length === 0) {
          uncompensatedFailures.push(new Error(
            `Agent Hub could not enumerate active connections during shutdown: ${failure.message}`,
          ));
        }
      }
      await new CodexHookStateStore(this.options.userDataPath)
        .removeForConnections(connectionIds)
        .catch((error: unknown) => this.options.onError?.(toError(error)));
      await new TurnCompletionQueueStore(this.options.userDataPath)
        .removeForConnections(connectionIds)
        .catch((error: unknown) => this.options.onError?.(toError(error)));
      await Promise.all(connectionIds.map(async (connectionId) => {
        const requestId = randomUUID();
        try {
          await this.pausePreparationQueue.enqueue({ connectionId, reason, requestId });
        } catch (error) {
          const failure = toError(error);
          this.options.onError?.(failure);
          uncompensatedFailures.push(new Error(
            `Agent Hub could not save cleanup recovery for connection ${connectionId}: ${failure.message}`,
          ));
          return;
        }
        // App shutdown leaves the saved connection enabled for automatic
        // restart, while the process-wide sentinel prevents new local work.
        const result = await this.completePreparedPause(connectionId, reason, requestId);
        if (result.cleanupError) this.options.onError?.(new Error(result.cleanupError));
      }));
      try {
        await this.flushFixedPauseRetries();
      } catch (error) {
        this.options.onError?.(toError(error));
      }
      if (this.presence) {
        await this.presence.stop().catch((error: unknown) => this.options.onError?.(toError(error)));
        this.presence = undefined;
      }
      if (uncompensatedFailures.length > 0) {
        throw new AggregateError(
          uncompensatedFailures,
          "Agent Hub could not safely persist all integration cleanup before shutdown.",
        );
      }
    })();
    this.shutdownPromise = shutdownPromise;
    void shutdownPromise.then(
      () => {
        if (this.shutdownPromise === shutdownPromise) {
          this.shutdownPromise = undefined;
          this.shutdownRequested = false;
        }
      },
      () => {
        if (this.shutdownPromise === shutdownPromise) {
          this.shutdownPromise = undefined;
          this.shutdownRequested = false;
        }
      },
    );
    return shutdownPromise;
  }

  async enterMaintenance(): Promise<void> {
    this.clearPauseRetryTimer();
    await this.presence?.markMaintenance();
  }

  /** Close the process-wide Hook/MCP gate before waiting on any producer. */
  async deactivateLocalGate(): Promise<void> {
    this.clearPauseRetryTimer();
    if (!this.presence) return;
    await this.presence.markInactive();
  }

  async resumeAfterMaintenance(): Promise<void> {
    await this.stopPresence();
    await this.start();
  }

  async stopPresence(): Promise<void> {
    await this.presence?.stop();
    this.presence = undefined;
  }

  getPresence(): RuntimePresenceHandle | undefined {
    return this.presence;
  }

  /** Run a due cleanup retry immediately; exposed for startup/diagnostics and deterministic tests. */
  async retryPendingPauses(): Promise<void> {
    this.clearPauseRetryTimer();
    await this.flushPauseRetries();
  }

  private schedulePauseRetry(delayMs = 0): void {
    if (this.retryTimer || this.presence?.record.status !== "active") return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flushPauseRetries();
    }, Math.min(Math.max(0, delayMs), 2_147_483_647));
    this.retryTimer.unref();
  }

  private async flushPauseRetries(): Promise<void> {
    if (this.retryPromise || this.presence?.record.status !== "active") return this.retryPromise;
    const retryPromise = (async () => {
      try {
        const forcePreparations = this.forcePreparationsOnNextRetry;
        this.forcePreparationsOnNextRetry = false;
        await this.flushPausePreparations(forcePreparations);
        await this.flushFixedPauseRetries();
      } catch (error) {
        this.options.onError?.(toError(error));
      }
    })();
    this.retryPromise = retryPromise;
    await retryPromise;
    if (this.retryPromise === retryPromise) this.retryPromise = undefined;
    try {
      const [preparations, pauses] = await Promise.all([
        this.pausePreparationQueue.list(),
        this.pauseQueue.list(),
      ]);
      if (preparations.length > 0 || pauses.length > 0) this.schedulePauseRetry(5_000);
    } catch (error) {
      this.options.onError?.(toError(error));
    }
  }

  private async flushPausePreparations(
    force: boolean,
    onlyConnectionId?: string,
  ): Promise<number> {
    if (this.preparationRetryPromise) {
      const inFlight = this.preparationRetryPromise;
      await inFlight;
      return this.flushPausePreparations(force, onlyConnectionId);
    }
    const retryPromise = (async () => {
      const now = (this.options.now ?? (() => new Date()))();
      const entries = await this.pausePreparationQueue.list();
      const fixedRequestIds = new Set(
        (await this.pauseQueue.list()).map((entry) => entry.requestId),
      );
      for (const entry of entries) {
        if (onlyConnectionId !== undefined && entry.connectionId !== onlyConnectionId) continue;
        if (!force && Date.parse(entry.nextAttemptAt) > now.getTime()) continue;
        if (fixedRequestIds.has(entry.requestId)) {
          // A crash can leave both records behind after the fixed request was
          // persisted. The retry entry is authoritative because it preserves
          // the original cutoffAt for this requestId.
          await this.pausePreparationQueue.remove(entry.requestId);
          continue;
        }
        if (entry.reason === "leave-room") {
          try {
            await this.options.store.pauseIntegration(entry.connectionId);
            this.knownActiveConnectionIds.delete(entry.connectionId);
          } catch (error) {
            const failure = toError(error);
            this.options.onError?.(failure);
            await this.pausePreparationQueue.defer(entry.requestId, failure);
            continue;
          }
        }
        await this.completePreparedPause(
          entry.connectionId,
          entry.reason,
          entry.requestId,
        );
      }
      const remaining = await this.pausePreparationQueue.list();
      return onlyConnectionId === undefined
        ? remaining.length
        : remaining.filter((entry) => entry.connectionId === onlyConnectionId).length;
    })();
    this.preparationRetryPromise = retryPromise;
    try {
      return await retryPromise;
    } finally {
      if (this.preparationRetryPromise === retryPromise) this.preparationRetryPromise = undefined;
    }
  }

  private async flushFixedPauseRetries(): Promise<void> {
    await this.pauseQueue.flush({
      // Preparation is persisted before its fixed cutoff. Recheck for each
      // entry so a foreground pause that interleaves with this flush cannot
      // lose the only record containing its original cutoffAt.
      shouldRetain: async (entry) =>
        (await this.pausePreparationQueue.list())
          .some((preparation) => preparation.requestId === entry.requestId),
    });
  }

  private clearPauseRetryTimer(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async withConnectionLifecycle<T>(
    connectionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.connectionLifecycle.get(connectionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(() => undefined, () => undefined);
    this.connectionLifecycle.set(connectionId, tail);
    try {
      return await run;
    } finally {
      if (this.connectionLifecycle.get(connectionId) === tail) {
        this.connectionLifecycle.delete(connectionId);
      }
    }
  }

  private async withRepositoryConnectionLifecycle<T>(
    connectionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const connection = await this.requireConnection(connectionId);
    const repositoryIdentity = await canonicalRepositoryIdentity(connection.repositoryPath);
    return this.withRepositoryLifecycle(repositoryIdentity, () =>
      this.withConnectionLifecycle(connectionId, operation));
  }

  private async withDeletionLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.deletionLifecycle.then(operation);
    this.deletionLifecycle = run.then(() => undefined, () => undefined);
    return run;
  }

  private async withRepositoryLifecycle<T>(
    repositoryIdentity: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.repositoryLifecycle.get(repositoryIdentity) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(() => undefined, () => undefined);
    this.repositoryLifecycle.set(repositoryIdentity, tail);
    try {
      return await run;
    } finally {
      if (this.repositoryLifecycle.get(repositoryIdentity) === tail) {
        this.repositoryLifecycle.delete(repositoryIdentity);
      }
    }
  }

  private async requireConnection(connectionId: string): Promise<SavedRoomConnection> {
    const connection = await this.options.store.get(connectionId);
    if (!connection) throw new Error("The selected room connection does not exist.");
    return connection;
  }

  private replaceKnownActiveConnections(connectionIds: string[]): void {
    this.knownActiveConnectionIds.clear();
    for (const connectionId of connectionIds) this.knownActiveConnectionIds.add(connectionId);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
