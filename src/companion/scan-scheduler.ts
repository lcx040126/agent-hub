import type { ConnectionStore } from "../desktop/connection-store.js";
import type { SavedRoomConnection } from "../desktop/contracts.js";
import { AgentHubClient, AgentHubHttpError } from "./hub-client.js";
import { inspectRepository, type RepositorySnapshot } from "./repository.js";

export interface RepositoryScanSchedulerOptions {
  store: ConnectionStore;
  intervalMs?: number;
  inspect?: typeof inspectRepository;
  fetchImpl?: typeof fetch;
  onError?: (error: Error, connection?: SavedRoomConnection) => void;
}

export interface RepositoryScanScheduler {
  scanNow(): Promise<void>;
  stop(): void;
}

const DEFAULT_SCAN_INTERVAL_MS = 2 * 60_000;

export function startRepositoryScanScheduler(
  options: RepositoryScanSchedulerOptions,
): RepositoryScanScheduler {
  const intervalMs = options.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 10_000) {
    throw new Error("The repository scan interval must be at least 10 seconds.");
  }
  const sessions = new Map<string, string>();
  let stopped = false;
  let running: Promise<void> | null = null;

  const scanNow = async () => {
    if (stopped) return;
    if (running) return running;
    running = runAllScans(options, sessions).finally(() => {
      running = null;
    });
    return running;
  };
  const timer = setInterval(() => void scanNow(), intervalMs);
  timer.unref();
  void scanNow();

  return {
    scanNow,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function runAllScans(
  options: RepositoryScanSchedulerOptions,
  sessions: Map<string, string>,
): Promise<void> {
  let connections: SavedRoomConnection[];
  try {
    connections = await options.store.list();
  } catch (error) {
    options.onError?.(asError(error));
    return;
  }
  await Promise.all(
    connections.map(async (connection) => {
      try {
        await scanConnection(options, sessions, connection);
      } catch (error) {
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
  const [memberToken, snapshot] = await Promise.all([
    options.store.readMemberToken(connection.id),
    (options.inspect ?? inspectRepository)(connection.repositoryPath),
  ]);
  const client = new AgentHubClient({
    serverUrl: connection.serverUrl,
    memberToken,
    fetchImpl: options.fetchImpl,
    timeoutMs: 30_000,
  });
  let sessionId = sessions.get(connection.id);
  if (!sessionId) {
    sessionId = await openScanSession(client, snapshot);
    sessions.set(connection.id, sessionId);
  }

  try {
    await uploadSnapshot(client, sessionId, snapshot);
  } catch (error) {
    if (!(error instanceof AgentHubHttpError) || (error.status !== 404 && error.status !== 409)) {
      throw error;
    }
    sessionId = await openScanSession(client, snapshot);
    sessions.set(connection.id, sessionId);
    await uploadSnapshot(client, sessionId, snapshot);
  }
}

async function openScanSession(client: AgentHubClient, snapshot: RepositorySnapshot): Promise<string> {
  const response = await client.post<{ session: { id: string } }>("/api/sessions", {
    clientName: "Agent Hub desktop companion",
    agentName: "Background repository scanner",
    repository: snapshot.repository.remote ?? snapshot.repository.name,
    branch: snapshot.repository.branch,
    worktree: snapshot.repository.root,
    baseCommit: snapshot.repository.headCommit,
    task: "Continuously synchronize local project structure and change metadata.",
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
  await client.post(`/api/sessions/${encodeURIComponent(sessionId)}/scan`, {
    repository: snapshot.repository.remote ?? snapshot.repository.name,
    branch: snapshot.repository.branch,
    worktree: snapshot.repository.root,
    baseCommit: snapshot.repository.headCommit,
    changedPaths: snapshot.changedPaths.slice(0, 100),
    ruleFiles: snapshot.ruleFiles.map((rule) => rule.path).slice(0, 100),
    systems: snapshot.systems.map((system) => system.id).slice(0, 200),
    metadata: {
      source: "desktop-companion",
      generatedAt: snapshot.generatedAt,
      repositoryFingerprint: snapshot.repository.fingerprint,
      impactedSystemIds: snapshot.impactedSystemIds.slice(0, 200),
      analysis: snapshot.analysis,
      ruleHashes: snapshot.ruleFiles.slice(0, 100).map((rule) => ({
        path: rule.path,
        sha256: rule.sha256,
      })),
      dependencies: snapshot.dependencies.slice(0, 500),
      dependencyCount: snapshot.dependencies.length,
      systemCount: snapshot.systems.length,
      changedPathCount: snapshot.changedPaths.length,
      metadataTruncated:
        snapshot.dependencies.length > 500
        || snapshot.systems.length > 200
        || snapshot.changedPaths.length > 100,
    },
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
