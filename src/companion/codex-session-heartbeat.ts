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
  const now = (options.now?.() ?? new Date()).getTime();
  const activeOwnerIds = options.store.list
    ? await unambiguousActiveOwnerIds(await options.store.list())
    : undefined;
  await Promise.all(states.map(async (state) => {
    try {
      if (!shouldHeartbeat(state, now)) {
        await stateStore.remove(state.codexSessionId);
        return;
      }
      if (activeOwnerIds && !activeOwnerIds.has(state.connectionId)) {
        await stateStore.remove(state.codexSessionId);
        return;
      }
      await operationTracker.run(state.connectionId, async () => {
        const connection = await options.store.get(state.connectionId);
        if (!connection || connection.integrationEnabled === false) {
          await stateStore.remove(state.codexSessionId);
          return;
        }
        if (
          await hasPendingPausePreparationForConnection(options.userDataPath, state.connectionId)
          || await hasPendingPauseForConnection(options.userDataPath, state.connectionId)
        ) return;
        const memberToken = await options.store.readMemberToken(state.connectionId);
        const client = new AgentHubClient({
          serverUrl: connection.serverUrl,
          memberToken,
          fetchImpl: options.fetchImpl,
        });
        await client.post(`/api/sessions/${encodeURIComponent(state.hubSessionId)}/heartbeat`, {
          clientVersion: AGENT_HUB_VERSION,
          protocolVersion: AGENT_HUB_PROTOCOL_VERSION,
          schemaVersion: AGENT_HUB_SCHEMA_VERSION,
        });
      });
    } catch (error) {
      if (error instanceof AgentHubHttpError && (error.status === 404 || error.status === 409)) {
        await stateStore.remove(state.codexSessionId);
        return;
      }
      options.onError?.(toError(error), state);
    }
  }));
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
