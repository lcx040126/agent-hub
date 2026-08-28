import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalRepositoryIdentity, type ConnectionStore } from "../desktop/connection-store.js";
import {
  AGENT_HUB_PROTOCOL_VERSION,
  AGENT_HUB_SCHEMA_VERSION,
  AGENT_HUB_VERSION,
} from "../shared/version.js";
import { AgentHubClient, AgentHubHttpError } from "./hub-client.js";
import { CodexHookStateStore, parseState, type CodexHookSessionState } from "./hook-state.js";
import {
  IntegrationOperationTracker,
  type ConnectionOperationTracker,
} from "./integration-operations.js";
import { hasPendingPauseForConnection } from "./pause-retry.js";
import { hasPendingPausePreparationForConnection } from "./pause-preparation.js";
import {
  matchesSessionEndJob,
  SessionEndQueueStore,
  type SessionEndQueueJob,
} from "./session-end-queue.js";
import {
  matchesTurnCompletionJob,
  TurnCompletionQueueStore,
} from "./turn-completion-queue.js";

export interface CodexSessionHeartbeatScheduler {
  scanNow(): Promise<void>;
  stop(): Promise<void>;
}

interface ConnectionLookup {
  list?: ConnectionStore["list"];
  get(connectionId: string): ReturnType<ConnectionStore["get"]>;
  readMemberToken(connectionId: string): ReturnType<ConnectionStore["readMemberToken"]>;
}

export interface StartCodexSessionHeartbeatOptions {
  userDataPath: string;
  store: ConnectionLookup;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  onError?: (error: Error, state?: CodexHookSessionState) => void;
  operationTracker?: Pick<ConnectionOperationTracker, "run">;
}

interface HeartbeatResponse {
  renewedLeases?: Array<{
    id: string;
    expiresAt: string;
  }>;
}

const DEFAULT_INTERVAL_MS = 2 * 60_000;
const ACTIVE_STATE_MAX_AGE_MS = 5 * 60_000;
const PENDING_WRITE_MAX_AGE_MS = 2 * 60 * 60_000;

export function startCodexSessionHeartbeatScheduler(
  options: StartCodexSessionHeartbeatOptions,
): CodexSessionHeartbeatScheduler {
  const stateStore = new CodexHookStateStore(options.userDataPath);
  const operationTracker = options.operationTracker
    ?? new IntegrationOperationTracker(options.userDataPath);
  let stopped = false;
  let running: Promise<void> | undefined;

  const scanNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = heartbeatAll(stateStore, options, operationTracker)
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

async function heartbeatAll(
  stateStore: CodexHookStateStore,
  options: StartCodexSessionHeartbeatOptions,
  operationTracker: Pick<ConnectionOperationTracker, "run">,
): Promise<void> {
  const states = await readHookStates(stateStore, options.onError);
  const completionQueue = new TurnCompletionQueueStore(options.userDataPath);
  const sessionEndQueue = new SessionEndQueueStore(options.userDataPath);
  const sessionEndJobs = await sessionEndQueue.list();
  const pendingCompletionJobs = await completionQueue.list((error) => options.onError?.(error));
  const now = (options.now?.() ?? new Date()).getTime();
  const activeOwnerIds = options.store.list
    ? await unambiguousActiveOwnerIds(await options.store.list())
    : undefined;
  await Promise.all(states.map(async (state) => {
    try {
      if (hasMatchingSessionEnd(sessionEndJobs, state)) {
        await reconcileMatchingSessionEnd(stateStore, sessionEndQueue, state);
        return;
      }
      if (!shouldHeartbeat(state, now)) {
        return;
      }
      if (
        state.pendingCompletion
        || pendingCompletionJobs.some((job) => matchesTurnCompletionJob(job, state))
      ) return;
      await operationTracker.run(state.connectionId, async () => {
        await stateStore.runExclusiveLeaseRenewal(state.codexSessionId, async (currentState) => {
          if (currentState.connectionId !== state.connectionId) return undefined;
          if (await mergeAndRemoveQueuedSessionEnd(sessionEndQueue, stateStore, currentState)) {
            return undefined;
          }
          if (!shouldHeartbeat(currentState, now) || currentState.pendingCompletion) return undefined;
          if (
            pendingCompletionJobs.some((job) => matchesTurnCompletionJob(job, currentState))
            || (await completionQueue.listForLifecycle(
              currentState,
              (error) => options.onError?.(error, currentState),
            )).length > 0
          ) return undefined;
          if (activeOwnerIds && !activeOwnerIds.has(currentState.connectionId)) {
            await stateStore.remove(currentState.codexSessionId);
            return undefined;
          }
          const connection = await options.store.get(currentState.connectionId);
          if (!connection || connection.integrationEnabled === false) {
            await stateStore.remove(currentState.codexSessionId);
            return undefined;
          }
          if (
            await hasPendingPausePreparationForConnection(options.userDataPath, currentState.connectionId)
            || await hasPendingPauseForConnection(options.userDataPath, currentState.connectionId)
          ) return undefined;
          const memberToken = await options.store.readMemberToken(currentState.connectionId);
          const client = new AgentHubClient({
            serverUrl: connection.serverUrl,
            memberToken,
            fetchImpl: options.fetchImpl,
          });
          const heartbeat = await client.post<HeartbeatResponse>(
            `/api/sessions/${encodeURIComponent(currentState.hubSessionId)}/heartbeat`,
            {
              clientVersion: AGENT_HUB_VERSION,
              protocolVersion: AGENT_HUB_PROTOCOL_VERSION,
              schemaVersion: AGENT_HUB_SCHEMA_VERSION,
              turnId: currentState.currentTurnId,
              activityEpoch: currentState.activityEpoch ?? 0,
            },
          );
          if (await mergeAndRemoveQueuedSessionEnd(sessionEndQueue, stateStore, currentState)) {
            return undefined;
          }
          return heartbeat.renewedLeases ?? [];
        });
      });
    } catch (error) {
      if (error instanceof AgentHubHttpError && error.status === 404) {
        await removeMatchingState(stateStore, state);
        return;
      }
      if (error instanceof AgentHubHttpError && error.status === 409) return;
      options.onError?.(toError(error), state);
    }
  }));
}

async function mergeAndRemoveQueuedSessionEnd(
  queue: SessionEndQueueStore,
  stateStore: CodexHookStateStore,
  state: CodexHookSessionState,
): Promise<boolean> {
  const job = (await queue.listForSession(state.codexSessionId))
    .find((candidate) => matchesSessionEndJob(candidate, state));
  if (!job) return false;
  await queue.mergeState(job.finalizationId, state);
  await stateStore.remove(state.codexSessionId);
  return true;
}

function hasMatchingSessionEnd(
  jobs: SessionEndQueueJob[],
  state: CodexHookSessionState,
): boolean {
  return jobs.some((job) => matchesSessionEndJob(job, state));
}

async function reconcileMatchingSessionEnd(
  stateStore: CodexHookStateStore,
  queue: SessionEndQueueStore,
  snapshot: CodexHookSessionState,
): Promise<void> {
  await stateStore.runExclusive(snapshot.codexSessionId, async () => {
    const current = await stateStore.load(snapshot.codexSessionId);
    if (!current || !sameLifecycleState(current, snapshot)) return;
    await mergeAndRemoveQueuedSessionEnd(queue, stateStore, current);
  });
}

async function removeMatchingState(
  store: CodexHookStateStore,
  snapshot: CodexHookSessionState,
): Promise<void> {
  await store.runExclusive(snapshot.codexSessionId, async () => {
    const current = await store.load(snapshot.codexSessionId);
    if (
      current
      && current.connectionId === snapshot.connectionId
      && current.hubSessionId === snapshot.hubSessionId
      && current.finalizationId === snapshot.finalizationId
    ) await store.remove(snapshot.codexSessionId);
  });
}

function sameLifecycleState(left: CodexHookSessionState, right: CodexHookSessionState): boolean {
  return left.codexSessionId === right.codexSessionId
    && left.connectionId === right.connectionId
    && left.hubSessionId === right.hubSessionId
    && left.finalizationId === right.finalizationId;
}

async function unambiguousActiveOwnerIds(
  connections: Awaited<ReturnType<ConnectionStore["list"]>>,
): Promise<Set<string>> {
  const byRepository = new Map<string, string[]>();
  for (const connection of connections) {
    if (connection.integrationEnabled === false) continue;
    const identity = await canonicalRepositoryIdentity(connection.repositoryPath);
    const ids = byRepository.get(identity) ?? [];
    ids.push(connection.id);
    byRepository.set(identity, ids);
  }
  return new Set(
    [...byRepository.values()]
      .filter((ids) => ids.length === 1)
      .flat(),
  );
}

function shouldHeartbeat(state: CodexHookSessionState, now: number): boolean {
  if (
    state.writeBlockSyncPending
    || state.leases.some((lease) => lease.coordinationState === "blocked")
  ) return false;
  // updatedAt is written only by real Hook state changes; this scheduler never refreshes it.
  if (!state.pendingWrite) return ageMs(state.updatedAt, now) <= ACTIVE_STATE_MAX_AGE_MS;
  return ageMs(state.pendingWrite.recordedAt, now) <= PENDING_WRITE_MAX_AGE_MS;
}

function ageMs(timestamp: string, now: number): number {
  return Math.max(0, now - Date.parse(timestamp));
}

async function readHookStates(
  stateStore: CodexHookStateStore,
  onError?: (error: Error, state?: CodexHookSessionState) => void,
): Promise<CodexHookSessionState[]> {
  let names: string[];
  try {
    names = (await readdir(stateStore.directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const states = await Promise.all(names.map(async (name) => {
    try {
      return parseState(await readFile(path.join(stateStore.directory, name), "utf8"));
    } catch (error) {
      onError?.(toError(error));
      return undefined;
    }
  }));
  return states.filter((state): state is CodexHookSessionState => Boolean(state));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
