import type { ConnectionStore } from "../desktop/connection-store.js";
import { finalizeQueuedSession } from "./codex-hook.js";
import { AgentHubClient, AgentHubHttpError } from "./hub-client.js";
import { SessionEndQueueStore, type SessionEndQueueJob } from "./session-end-queue.js";
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
  const jobs = (await queue.list()).filter((job) => Date.parse(job.nextAttemptAt) <= now.getTime());
  for (const job of jobs) {
    try {
      await operationTracker.run(job.connectionId, () => processJob(job, options));
      await queue.remove(job.finalizationId);
    } catch (error) {
      const failure = toError(error);
      if (
        error instanceof AgentHubHttpError
        && (error.status === 404 || error.code === "session_already_closed")
      ) {
        await queue.remove(job.finalizationId);
        continue;
      }
      if (job.attempts + 1 >= MAX_LOCAL_EVIDENCE_ATTEMPTS && !isNetworkFailure(failure)) {
        try {
          await operationTracker.run(
            job.connectionId,
            () => completeWithoutEvidence(job, options, failure),
          );
          await queue.remove(job.finalizationId);
          continue;
        } catch (completionError) {
          options.onError?.(toError(completionError), job);
        }
      }
      await queue.recordFailure(job, failure, now);
      options.onError?.(failure, job);
    }
  }
}

async function processJob(
  job: SessionEndQueueJob,
  options: StartSessionEndFinalizationWorkerOptions,
): Promise<void> {
  const client = await clientForJob(job, options);
  await finalizeQueuedSession(job, { client });
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

function isNetworkFailure(error: Error): boolean {
  return /(?:fetch failed|failed to fetch|network|socket|econn|etimedout|timed out|did not respond|connection reset|connection refused|aborted)/i.test(
    error.message,
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
