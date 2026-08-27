import { randomUUID } from "node:crypto";
import type { ConnectionStore } from "../desktop/connection-store.js";
import { AgentHubClient, AgentHubHttpError } from "./hub-client.js";
import { CodexHookStateStore, type CodexHookSessionState } from "./hook-state.js";
import {
  IntegrationOperationTracker,
  type ConnectionOperationTracker,
} from "./integration-operations.js";
import {
  TurnCompletionQueueStore,
  type TurnCompletionJob,
} from "./turn-completion-queue.js";
import { evaluateTurnCompletionEvidence } from "./turn-completion.js";

export interface TurnCompletionWorker {
  scanNow(): Promise<void>;
  stop(): Promise<void>;
}

interface ConnectionLookup {
  get(connectionId: string): ReturnType<ConnectionStore["get"]>;
  readMemberToken(connectionId: string): ReturnType<ConnectionStore["readMemberToken"]>;
}

export interface StartTurnCompletionWorkerOptions {
  userDataPath: string;
  store: ConnectionLookup;
  integrationActive?: () => boolean;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  gitExecutable?: string;
  now?: () => Date;
  onError?: (error: Error, job?: TurnCompletionJob) => void;
  operationTracker?: Pick<ConnectionOperationTracker, "run">;
}

export interface ProcessTurnCompletionJobOptions {
  userDataPath: string;
  client: AgentHubClient;
  gitExecutable?: string;
  gitTimeoutMs?: number;
  now?: () => Date;
}

export interface ResumePendingCompletionOptions {
  userDataPath: string;
  state: CodexHookSessionState;
  stateStore: CodexHookStateStore;
  client: AgentHubClient;
  turnId: string;
}

type StopResult = "awaiting_commit" | "already_applied" | "superseded";
type ResumeResult = "resumed" | "already_applied" | "superseded";
type CompletionResult = "released" | "awaiting_commit" | "already_applied" | "superseded";

const DEFAULT_INTERVAL_MS = 15_000;

export function startTurnCompletionWorker(
  options: StartTurnCompletionWorkerOptions,
): TurnCompletionWorker {
  const queue = new TurnCompletionQueueStore(options.userDataPath);
  const operationTracker = options.operationTracker
    ?? new IntegrationOperationTracker(options.userDataPath);
  let stopped = false;
  let running: Promise<void> | undefined;

  const scanNow = (): Promise<void> => {
    if (stopped || options.integrationActive?.() === false) return Promise.resolve();
    if (running) return running;
    running = processQueue(queue, options, operationTracker)
      .catch((error: unknown) => options.onError?.(toError(error)))
      .finally(() => { running = undefined; });
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
  queue: TurnCompletionQueueStore,
  options: StartTurnCompletionWorkerOptions,
  operationTracker: Pick<ConnectionOperationTracker, "run">,
): Promise<void> {
  const now = options.now?.() ?? new Date();
  const jobs = (await queue.list()).filter((job) => Date.parse(job.nextAttemptAt) <= now.getTime());
  for (const job of jobs) {
    await operationTracker.run(job.connectionId, async () => {
      await queue.runExclusive(job.operationId, async () => {
        if (Date.parse(job.expiresAt) <= now.getTime()) {
          await queue.remove(job.operationId);
          await markStoppedState(options.userDataPath, job);
          return;
        }
        try {
          const state = await new CodexHookStateStore(options.userDataPath).load(job.codexSessionId);
          if (state && (state.activityEpoch ?? 0) > job.activityEpoch) {
            if (state.pendingCompletion?.phase === "resuming") {
              const client = await clientForJob(job, options);
              await completeResume(options.userDataPath, state, client, queue);
            } else {
              await queue.remove(job.operationId);
            }
            return;
          }
          if (
            state?.pendingCompletion
            && state.pendingCompletion.activityEpoch === job.activityEpoch
            && state.pendingCompletion.operationId !== job.operationId
          ) {
            await queue.remove(job.operationId);
            return;
          }

          const client = await clientForJob(job, options);
          const pending = await processTurnCompletionJob(job, {
            userDataPath: options.userDataPath,
            client,
            gitExecutable: options.gitExecutable,
            now: options.now,
          });
          if (pending) await queue.recordRetry(job, pending.error, now);
          else await queue.remove(job.operationId);
        } catch (error) {
          if (error instanceof AgentHubHttpError && error.status === 404) {
            await queue.remove(job.operationId);
            await clearPendingState(options.userDataPath, job);
            return;
          }
          const failure = toError(error);
          await queue.recordRetry(job, failure, now);
          options.onError?.(failure, job);
        }
      });
    });
  }
}

/** 返回 null 表示任务已经终止；返回诊断则由调用者安排约 15 秒后的重试。 */
export async function processTurnCompletionJob(
  job: TurnCompletionJob,
  options: ProcessTurnCompletionJobOptions,
): Promise<{ error: Error | null } | null> {
  const stop = await options.client.post<{ result: StopResult }>(
    `/api/sessions/${encodeURIComponent(job.hubSessionId)}/stop`,
    {
      operationId: job.operationId,
      turnId: job.turnId,
      activityEpoch: job.activityEpoch,
    },
  );
  if (stop.result === "superseded") {
    await clearPendingState(options.userDataPath, job);
    return null;
  }

  const evidence = await evaluateTurnCompletionEvidence({
    repositoryPath: job.repositoryPath,
    branch: job.branch,
    baseCommit: job.baseCommit,
    attributedPaths: job.attributedPaths,
    baselineEvidence: job.baselineEvidence,
    attributedPathsTruncated: job.attributedPathsTruncated,
    attributionComplete: job.attributionComplete,
  }, {
    gitExecutable: options.gitExecutable,
    timeoutMs: options.gitTimeoutMs ?? 5_000,
  });
  if (evidence.status === "awaiting_commit") return { error: null };
  if (evidence.status === "incomplete") return { error: new Error(evidence.reason) };

  const completion = await options.client.post<{
    result: CompletionResult;
    releasedLeaseIds?: string[];
  }>(`/api/sessions/${encodeURIComponent(job.hubSessionId)}/completion/check`, {
    operationId: job.operationId,
    turnId: job.turnId,
    activityEpoch: job.activityEpoch,
    outcome: evidence.status,
    leaseIds: job.leaseIds,
    attributedPaths: job.attributedPaths,
    baseCommit: job.baseCommit,
    headCommit: evidence.headCommit,
  });
  if (completion.result === "awaiting_commit") return { error: null };
  if (completion.result === "superseded") await clearPendingState(options.userDataPath, job);
  else await markStoppedState(options.userDataPath, job);
  return null;
}

/**
 * 新写入先持久化更高 epoch，再以同一个幂等 operation 重试 resume。只有服务端确认后，
 * PreToolUse 才继续到 prepare/claim，因此旧完成任务即使并发返回也不能覆盖新活动。
 */
export async function resumePendingTurnCompletion(
  options: ResumePendingCompletionOptions,
): Promise<void> {
  const queue = new TurnCompletionQueueStore(options.userDataPath);
  const jobs = await queue.listForSession(options.state.codexSessionId);
  if (jobs.length === 0 && !options.state.pendingCompletion) return;

  let pending = options.state.pendingCompletion;
  if (!pending || pending.phase !== "resuming") {
    const latestEpoch = jobs.reduce(
      (latest, job) => Math.max(latest, job.activityEpoch),
      options.state.activityEpoch ?? 0,
    );
    pending = {
      operationId: randomUUID(),
      turnId: options.turnId,
      activityEpoch: latestEpoch + 1,
      phase: "resuming",
      recordedAt: new Date().toISOString(),
    };
    options.state.activityEpoch = pending.activityEpoch;
    options.state.pendingCompletion = pending;
    await options.stateStore.save(options.state);
  }

  const response = await options.client.post<{ result: ResumeResult }>(
    `/api/sessions/${encodeURIComponent(options.state.hubSessionId)}/resume`,
    {
      operationId: pending.operationId,
      turnId: pending.turnId,
      activityEpoch: pending.activityEpoch,
    },
  );
  if (!new Set<ResumeResult>(["resumed", "already_applied", "superseded"]).has(response.result)) {
    throw new Error("Agent Hub returned an invalid resume result.");
  }
  options.state.activityEpoch = pending.activityEpoch;
  options.state.currentTurnId = pending.turnId;
  options.state.pendingCompletion = undefined;
  await options.stateStore.save(options.state);
  await queue.removeForSession(options.state.codexSessionId, pending.activityEpoch);
}

async function completeResume(
  userDataPath: string,
  state: CodexHookSessionState,
  client: AgentHubClient,
  queue: TurnCompletionQueueStore,
): Promise<void> {
  const pending = state.pendingCompletion;
  if (!pending || pending.phase !== "resuming") return;
  await client.post<{ result: ResumeResult }>(
    `/api/sessions/${encodeURIComponent(state.hubSessionId)}/resume`,
    {
      operationId: pending.operationId,
      turnId: pending.turnId,
      activityEpoch: pending.activityEpoch,
    },
  );
  state.pendingCompletion = undefined;
  state.currentTurnId = pending.turnId;
  await new CodexHookStateStore(userDataPath).save(state);
  await queue.removeForSession(state.codexSessionId, pending.activityEpoch);
}

async function clearPendingState(userDataPath: string, job: TurnCompletionJob): Promise<void> {
  const stateStore = new CodexHookStateStore(userDataPath);
  const state = await stateStore.load(job.codexSessionId);
  if (
    !state?.pendingCompletion
    || state.pendingCompletion.operationId !== job.operationId
    || state.pendingCompletion.activityEpoch !== job.activityEpoch
  ) return;
  state.pendingCompletion = undefined;
  await stateStore.save(state);
}

async function markStoppedState(userDataPath: string, job: TurnCompletionJob): Promise<void> {
  const stateStore = new CodexHookStateStore(userDataPath);
  const state = await stateStore.load(job.codexSessionId);
  if (
    !state?.pendingCompletion
    || state.pendingCompletion.operationId !== job.operationId
    || state.pendingCompletion.activityEpoch !== job.activityEpoch
  ) return;
  state.pendingCompletion.phase = "stopped";
  await stateStore.save(state);
}

async function clientForJob(
  job: TurnCompletionJob,
  options: StartTurnCompletionWorkerOptions,
): Promise<AgentHubClient> {
  const connection = await options.store.get(job.connectionId);
  if (!connection) throw new Error("The saved room connection for this completion no longer exists.");
  const memberToken = await options.store.readMemberToken(job.connectionId);
  return new AgentHubClient({
    serverUrl: connection.serverUrl,
    memberToken,
    fetchImpl: options.fetchImpl,
    timeoutMs: 10_000,
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
