import type { ConnectionStore } from "../desktop/connection-store.js";
import { finalizeQueuedSession, SessionEndLocalEvidenceError } from "./codex-hook.js";
import { AgentHubClient, AgentHubHttpError } from "./hub-client.js";
import { CodexHookStateStore } from "./hook-state.js";
import {
  matchesSessionEndJob,
  SessionEndQueueStore,
  type SessionEndQueueJob,
} from "./session-end-queue.js";
import { IntegrationOperationTracker, type ConnectionOperationTracker } from "./integration-operations.js";

export interface SessionEndFinalizationWorker {
  scanNow(): Promise<void>;
  stop(): Promise<void>;
}

interface ConnectionLookup {
  get(connectionId: string): ReturnType<ConnectionStore["get"]>;
  readMemberToken(connectionId: string): ReturnType<ConnectionStore["readMemberToken"]>;
}

export interface StartSessionEndFinalizationWorkerOptions {
  userDataPath: string;
  store: ConnectionLookup;
  integrationActive?: () => boolean;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  gitExecutable?: string;
  now?: () => Date;
  onError?: (error: Error, job?: SessionEndQueueJob) => void;
  operationTracker?: Pick<ConnectionOperationTracker, "run">;
}

const DEFAULT_INTERVAL_MS = 2_000;
const MAX_LOCAL_EVIDENCE_ATTEMPTS = 5;

export function startSessionEndFinalizationWorker(
  options: StartSessionEndFinalizationWorkerOptions,
): SessionEndFinalizationWorker {
  const queue = new SessionEndQueueStore(options.userDataPath);
  const operationTracker = options.operationTracker ?? new IntegrationOperationTracker(options.userDataPath);
  let stopped = false;
  let running: Promise<void> | undefined;

  const scanNow = (): Promise<void> => {
    if (stopped || options.integrationActive?.() === false) return Promise.resolve();
    if (running) return running;
    running = processQueue(queue, options, operationTracker)
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

async function processQueue(
  queue: SessionEndQueueStore,
  options: StartSessionEndFinalizationWorkerOptions,
  operationTracker: Pick<ConnectionOperationTracker, "run">,
): Promise<void> {
  const now = options.now?.() ?? new Date();
  const jobs = (await queue.list((error) => options.onError?.(error)))
    .filter((job) => Date.parse(job.nextAttemptAt) <= now.getTime());
  for (const queuedJob of jobs) {
    let job = queuedJob;
    try {
      const prepared = await prepareQueuedJob(queue, queuedJob, options.userDataPath);
      if (!prepared) continue;
      job = prepared;
      await operationTracker.run(job.connectionId, () => processJob(job, options));
      await removeFinalizedHookState(job, options.userDataPath);
      await queue.remove(job.finalizationId);
    } catch (error) {
      const failure = toError(error);
      if (
        error instanceof AgentHubHttpError
        && (error.code === "session_not_found" || error.code === "session_already_closed")
      ) {
        await removeFinalizedHookState(job, options.userDataPath);
        await queue.remove(job.finalizationId);
        continue;
      }
      const localEvidenceFailure = error instanceof SessionEndLocalEvidenceError;
      const failedJob = await queue.recordFailure(job, failure, now, { localEvidenceFailure });
      if (!failedJob) continue;
      job = failedJob;
      if (localEvidenceFailure && job.localEvidenceAttempts >= MAX_LOCAL_EVIDENCE_ATTEMPTS) {
        try {
          await operationTracker.run(
            job.connectionId,
            () => completeWithoutEvidence(job, options, failure),
          );
          await removeFinalizedHookState(job, options.userDataPath);
          await queue.remove(job.finalizationId);
          continue;
        } catch (completionError) {
          options.onError?.(toError(completionError), job);
        }
      }
      options.onError?.(failure, job);
    }
  }
}

async function prepareQueuedJob(
  queue: SessionEndQueueStore,
  snapshot: SessionEndQueueJob,
  userDataPath: string,
): Promise<SessionEndQueueJob | undefined> {
  const stateStore = new CodexHookStateStore(userDataPath);
  return stateStore.runExclusive(snapshot.codexSessionId, async () => {
    let job: SessionEndQueueJob;
    try {
      job = await queue.load(snapshot.finalizationId);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    const state = await stateStore.load(snapshot.codexSessionId);
    if (!state || !matchesSessionEndJob(job, state)) return job;
    const merged = await queue.mergeState(job.finalizationId, state);
    await stateStore.remove(snapshot.codexSessionId);
    return merged;
  });
}

async function removeFinalizedHookState(
  job: SessionEndQueueJob,
  userDataPath: string,
): Promise<void> {
  const stateStore = new CodexHookStateStore(userDataPath);
  await stateStore.runExclusive(job.codexSessionId, async () => {
    const state = await stateStore.load(job.codexSessionId);
    if (
      state
      && matchesSessionEndJob(job, state)
    ) await stateStore.remove(job.codexSessionId);
  });
}

async function processJob(
  job: SessionEndQueueJob,
  options: StartSessionEndFinalizationWorkerOptions,
): Promise<void> {
  const client = await clientForJob(job, options);
  await finalizeQueuedSession(job, { client, gitExecutable: options.gitExecutable });
}

async function completeWithoutEvidence(
  job: SessionEndQueueJob,
  options: StartSessionEndFinalizationWorkerOptions,
  failure: Error,
): Promise<void> {
  const client = await clientForJob(job, options);
  await client.post(`/api/sessions/${encodeURIComponent(job.hubSessionId)}/finalize/start`, {
    finalizationId: job.finalizationId,
    summary: "Background finalization exhausted its local evidence retries.",
  });
  await client.post(`/api/sessions/${encodeURIComponent(job.hubSessionId)}/finalize/complete`, {
    finalizationId: job.finalizationId,
    summary: "The session was closed after repeated local evidence failures.",
    evidenceError: `最终证据处理连续失败 ${MAX_LOCAL_EVIDENCE_ATTEMPTS} 次：${failure.message}`,
  });
}

async function clientForJob(
  job: SessionEndQueueJob,
  options: StartSessionEndFinalizationWorkerOptions,
): Promise<AgentHubClient> {
  const connection = await options.store.get(job.connectionId);
  if (!connection) throw new Error("The saved room connection for this finalization no longer exists.");
  const memberToken = await options.store.readMemberToken(job.connectionId);
  return new AgentHubClient({
    serverUrl: connection.serverUrl,
    memberToken,
    fetchImpl: options.fetchImpl,
    timeoutMs: 15_000,
  });
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
