import path from "node:path";
import {
  canonicalRepositoryIdentity,
  type ConnectionStore,
} from "../desktop/connection-store.js";
import type { SavedRoomConnection } from "../desktop/contracts.js";
import { AGENT_HUB_SCAN_METADATA_MAX_LENGTH } from "../shared/limits.js";
import {
  AGENT_HUB_PROTOCOL_VERSION,
  AGENT_HUB_SCHEMA_VERSION,
  AGENT_HUB_VERSION,
} from "../shared/version.js";
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
  connections = await unambiguousRepositoryOwners(connections, options.onError);
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

async function unambiguousRepositoryOwners(
  connections: SavedRoomConnection[],
  onError?: (error: Error, connection?: SavedRoomConnection) => void,
): Promise<SavedRoomConnection[]> {
  const byRepository = new Map<string, SavedRoomConnection[]>();
  for (const connection of connections) {
    const identity = await canonicalRepositoryIdentity(connection.repositoryPath);
    const matching = byRepository.get(identity) ?? [];
    matching.push(connection);
    byRepository.set(identity, matching);
  }
  const selected: SavedRoomConnection[] = [];
  for (const [identity, matching] of byRepository) {
    if (matching.length === 1) {
      selected.push(matching[0]!);
      continue;
    }
    onError?.(new Error(
      `Agent Hub skipped background scanning because repository ${identity} has multiple active room connections.`,
    ));
  }
  return selected;
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
  // 在读取凭证或建立远端扫描会话前完成本地容量验证。
  const payload = createBackgroundScanPayload(snapshot);
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
    await uploadSnapshot(client, sessionId, payload);
  } catch (error) {
    if (!(error instanceof AgentHubHttpError) || (error.status !== 404 && error.status !== 409)) {
      throw error;
    }
    sessionId = await openScanSession(client, snapshot);
    sessions.set(current.id, sessionId);
    await uploadSnapshot(client, sessionId, payload);
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
    clientVersion: AGENT_HUB_VERSION,
    protocolVersion: AGENT_HUB_PROTOCOL_VERSION,
    schemaVersion: AGENT_HUB_SCHEMA_VERSION,
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
  payload: Record<string, unknown>,
): Promise<void> {
  await client.post(`/api/sessions/${encodeURIComponent(sessionId)}/scan`, payload);
}

export function createBackgroundScanPayload(snapshot: RepositorySnapshot): Record<string, unknown> {
  const metadata = createBackgroundScanMetadata(snapshot);
  return {
    repository: snapshot.repository.remote ?? snapshot.repository.name,
    branch: snapshot.repository.branch,
    worktree: snapshot.repository.root,
    baseCommit: snapshot.repository.headCommit,
    // Desktop/Unity/IDE changes are not attributable to an Agent tool call and never leave this machine.
    changedPaths: [],
    ruleFiles: snapshot.ruleFiles.map((rule) => rule.path).slice(0, 100),
    systems: snapshot.systems.map((system) => system.id).slice(0, 200),
    metadata,
  };
}

function createBackgroundScanMetadata(snapshot: RepositorySnapshot): Record<string, unknown> {
  const ruleHashes = snapshot.ruleFiles.map((rule) => ({
    path: rule.path,
    sha256: rule.sha256,
  }));
  const dependencies = snapshot.dependencies;
  const createCandidate = (ruleHashIncludedCount: number, dependencyIncludedCount: number) => ({
    source: "desktop-companion",
    generatedAt: snapshot.generatedAt,
    repositoryFingerprint: snapshot.repository.fingerprint,
    analysis: snapshot.analysis,
    ruleHashes: ruleHashes.slice(0, ruleHashIncludedCount),
    dependencies: dependencies.slice(0, dependencyIncludedCount),
    dependencyCount: dependencies.length,
    dependencyIncludedCount,
    ruleHashCount: ruleHashes.length,
    ruleHashIncludedCount,
    systemCount: snapshot.systems.length,
    externalChangesExcluded: true,
    metadataTruncated:
      ruleHashIncludedCount < ruleHashes.length
      || dependencyIncludedCount < dependencies.length
      || snapshot.ruleFiles.length > 100
      || snapshot.systems.length > 200,
  });

  // 先验证不含可裁剪列表的固定字段，避免构造出服务端必然拒绝的请求。
  const minimum = createCandidate(0, 0);
  if (JSON.stringify(minimum).length > AGENT_HUB_SCAN_METADATA_MAX_LENGTH) {
    throw new BackgroundScanMetadataTooLargeError();
  }

  // 两类数据都只保留原有顺序的前缀；规则哈希沿用原字段顺序并优先占用预算。
  const ruleHashIncludedCount = maximumFittingPrefix(
    ruleHashes.length,
    (count) => createCandidate(count, 0),
  );
  const dependencyIncludedCount = maximumFittingPrefix(
    dependencies.length,
    (count) => createCandidate(ruleHashIncludedCount, count),
  );
  const metadata = createCandidate(ruleHashIncludedCount, dependencyIncludedCount);
  if (JSON.stringify(metadata).length > AGENT_HUB_SCAN_METADATA_MAX_LENGTH) {
    throw new BackgroundScanMetadataTooLargeError();
  }
  return metadata;
}

function maximumFittingPrefix(
  itemCount: number,
  createCandidate: (includedCount: number) => Record<string, unknown>,
): number {
  let lower = 0;
  let upper = itemCount;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (JSON.stringify(createCandidate(middle)).length <= AGENT_HUB_SCAN_METADATA_MAX_LENGTH) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  return lower;
}

export class BackgroundScanMetadataTooLargeError extends Error {
  constructor() {
    super(
      `Agent Hub could not create scan metadata within the ${AGENT_HUB_SCAN_METADATA_MAX_LENGTH} character limit.`,
    );
    this.name = "BackgroundScanMetadataTooLargeError";
  }
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
