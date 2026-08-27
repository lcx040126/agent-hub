import path from "node:path";
import type { ConnectionStore } from "../desktop/connection-store.js";
import type { SavedRoomConnection } from "../desktop/contracts.js";
import { AgentHubClient, AgentHubHttpError } from "./hub-client.js";
import {
  IntegrationOperationTracker,
  type ConnectionOperationTracker,
} from "./integration-operations.js";
import { inspectRepository, type RepositorySnapshot } from "./repository.js";
import { hasPendingPauseForConnection } from "./pause-retry.js";
import { hasPendingPausePreparationForConnection } from "./pause-preparation.js";

export interface RepositoryScanSchedulerOptions {
  store: ConnectionStore;
  intervalMs?: number;
  inspectTimeoutMs?: number;
  inspect?: typeof inspectRepository;
  fetchImpl?: typeof fetch;
  integrationActive?: () => boolean | Promise<boolean>;
  operationTracker?: Pick<ConnectionOperationTracker, "run">;
  onError?: (error: Error, connection?: SavedRoomConnection) => void;
}

export interface RepositoryScanScheduler {
  scanNow(): Promise<void>;
  stop(): Promise<void>;
}

const DEFAULT_SCAN_INTERVAL_MS = 2 * 60_000;
const DEFAULT_INSPECT_TIMEOUT_MS = 60_000;

export function startRepositoryScanScheduler(
  options: RepositoryScanSchedulerOptions,
): RepositoryScanScheduler {
  const intervalMs = options.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 10_000) {
    throw new Error("The repository scan interval must be at least 10 seconds.");
  }
  const sessions = new Map<string, string>();
  const operationTracker = options.operationTracker
    ?? new IntegrationOperationTracker(path.dirname(options.store.filePath));
  let stopped = false;
  let running: Promise<void> | null = null;

  const scanNow = async () => {
    if (stopped) return;
    if (running) return running;
    running = runAllScans(options, sessions, operationTracker).finally(() => {
      running = null;
    });
    return running;
  };
  const timer = setInterval(() => void scanNow(), intervalMs);
  timer.unref();
  void scanNow();

  return {
    scanNow,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}

async function runAllScans(
  options: RepositoryScanSchedulerOptions,
  sessions: Map<string, string>,
  operationTracker: Pick<ConnectionOperationTracker, "run">,
): Promise<void> {
  let connections: SavedRoomConnection[];
  try {
    connections = (await options.store.list()).filter((connection) => connection.integrationEnabled !== false);
  } catch (error) {
    options.onError?.(asError(error));
    return;
  }
  await Promise.all(
    connections.map(async (connection) => {
      try {
        await operationTracker.run(connection.id, async () => {
          const current = await options.store.get(connection.id);
          if (!current || current.integrationEnabled === false) return;
          await scanConnection(options, sessions, current);
        });
      } catch (error) {
        if (error instanceof ScanIntegrationInactiveError) return;
        options.onError?.(asError(error), connection);
      }
    }),
  );
}

async function scanConnection(
  options: RepositoryScanSchedulerOptions,
  sessions: Map<string, string>,
  connection: SavedRoomConnection,
): Promise<void> {
  const inspectTimeoutMs = positiveFinite(
    options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS,
    "repository inspection timeout",
  );
  const snapshot = await withTimeout(
    Promise.resolve((options.inspect ?? inspectRepository)(connection.repositoryPath)),
    inspectTimeoutMs,
    `Repository inspection did not finish within ${inspectTimeoutMs} ms.`,
  );
  const current = await activeConnection(options, connection.id);
  if (!current) return;
  const memberToken = await options.store.readMemberToken(current.id);
  const client = new AgentHubClient({
    serverUrl: current.serverUrl,
    memberToken,
    fetchImpl: createScanGatedFetch(options, current.id),
    timeoutMs: 30_000,
  });
  let sessionId = sessions.get(current.id);
  if (!sessionId) {
    sessionId = await openScanSession(client, snapshot);
    sessions.set(current.id, sessionId);
  }

  try {
    await uploadSnapshot(client, sessionId, snapshot);
  } catch (error) {
    if (!(error instanceof AgentHubHttpError) || (error.status !== 404 && error.status !== 409)) {
      throw error;
    }
    sessionId = await openScanSession(client, snapshot);
    sessions.set(current.id, sessionId);
    await uploadSnapshot(client, sessionId, snapshot);
  }
}

function createScanGatedFetch(
  options: RepositoryScanSchedulerOptions,
  connectionId: string,
): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (!(await activeConnection(options, connectionId))) {
      throw new ScanIntegrationInactiveError();
    }
    return fetchImpl(input, init);
  }) as typeof fetch;
}

async function activeConnection(
  options: RepositoryScanSchedulerOptions,
  connectionId: string,
): Promise<SavedRoomConnection | undefined> {
  if (options.integrationActive && !(await options.integrationActive())) return undefined;
  const current = await options.store.get(connectionId);
  if (!current || current.integrationEnabled === false) return undefined;
  const userDataPath = path.dirname(options.store.filePath);
  if (
    await hasPendingPausePreparationForConnection(userDataPath, current.id)
    || await hasPendingPauseForConnection(userDataPath, current.id)
  ) {
    return undefined;
  }
  return current;
}

async function openScanSession(client: AgentHubClient, snapshot: RepositorySnapshot): Promise<string> {
  const response = await client.post<{ session: { id: string } }>("/api/sessions", {
    clientName: "Agent Hub desktop companion",
    agentName: "Background repository scanner",
    repository: snapshot.repository.remote ?? snapshot.repository.name,
    branch: snapshot.repository.branch,
    worktree: snapshot.repository.root,
    baseCommit: snapshot.repository.headCommit,
    task: "Synchronize project structure and rules; external file changes stay local.",
    metadata: {
      source: "desktop-companion",
      repositoryFingerprint: snapshot.repository.fingerprint,
    },
  });
  return response.session.id;
}

async function uploadSnapshot(
  client: AgentHubClient,
  sessionId: string,
  snapshot: RepositorySnapshot,
): Promise<void> {
  await client.post(`/api/sessions/${encodeURIComponent(sessionId)}/scan`, createBackgroundScanPayload(snapshot));
}

export function createBackgroundScanPayload(snapshot: RepositorySnapshot): Record<string, unknown> {
  return {
    repository: snapshot.repository.remote ?? snapshot.repository.name,
    branch: snapshot.repository.branch,
    worktree: snapshot.repository.root,
    baseCommit: snapshot.repository.headCommit,
    // Desktop/Unity/IDE changes are not attributable to an Agent tool call and never leave this machine.
    changedPaths: [],
    ruleFiles: snapshot.ruleFiles.map((rule) => rule.path).slice(0, 100),
    systems: snapshot.systems.map((system) => system.id).slice(0, 200),
    metadata: {
      source: "desktop-companion",
      generatedAt: snapshot.generatedAt,
      repositoryFingerprint: snapshot.repository.fingerprint,
      analysis: snapshot.analysis,
      ruleHashes: snapshot.ruleFiles.slice(0, 100).map((rule) => ({
        path: rule.path,
        sha256: rule.sha256,
      })),
      dependencies: snapshot.dependencies.slice(0, 500),
      dependencyCount: snapshot.dependencies.length,
      systemCount: snapshot.systems.length,
      externalChangesExcluded: true,
      metadataTruncated:
        snapshot.dependencies.length > 500
        || snapshot.systems.length > 200,
    },
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`The ${label} must be positive.`);
  return value;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class ScanIntegrationInactiveError extends Error {
  constructor() {
    super("Agent Hub repository scan stopped because the local integration is inactive.");
    this.name = "ScanIntegrationInactiveError";
  }
}
