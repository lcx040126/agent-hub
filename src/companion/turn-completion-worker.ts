import { randomUUID } from "node:crypto";
import type { ConnectionStore } from "../desktop/connection-store.js";
import { AgentHubClient, AgentHubHttpError } from "./hub-client.js";
import { CodexHookStateStore, type CodexHookSessionState } from "./hook-state.js";
import {
  IntegrationOperationTracker,
  type ConnectionOperationTracker,
} from "./integration-operations.js";
import {
  matchesTurnCompletionJob,
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

interface StopResponse {
  result: StopResult;
  managedLeases?: Array<{
    id: string;
    paths: string[];
    expiresAt: string;
  }>;
  awaitingAutomaticLeases?: Array<{
    id: string;
    expiresAt: string;
  }>;
}

interface ResumeResponse {
  result: ResumeResult;
  previousResult?: ResumeResult;
  session?: {
    status?: string;
    currentTurnId?: string | null;
    activityEpoch?: number;
    turnStoppedAt?: string | null;
  };
}

interface CompletionResponse {
  result: CompletionResult;
  previousResult?: Exclude<CompletionResult, "already_applied">;
  releasedLeaseIds?: string[];
}

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
  const listedJobs = (await queue.list((error) => options.onError?.(error)))
    .filter((job) => Date.parse(job.nextAttemptAt) <= now.getTime());
  for (const listedJob of listedJobs) {
    await operationTracker.run(listedJob.connectionId, async () => {
      // 文件锁只保护快照与结果提交，网络和 Git 检查不应阻塞并发 Stop 写入更新后的 evidence。
      const job = await queue.runExclusive(listedJob.operationId, async () => {
        const current = await queue.load(listedJob.operationId);
        if (!current || Date.parse(current.nextAttemptAt) > now.getTime()) return undefined;
        return current;
      });
      if (!job) return;

      if (Date.parse(job.expiresAt) <= now.getTime()) {
        if (await queue.removeIfUnchanged(job)) {
          await markStoppedState(options.userDataPath, job);
        }
        return;
      }
      try {
        const state = await new CodexHookStateStore(options.userDataPath).load(job.codexSessionId);
        const matchingState = state && matchesTurnCompletionJob(job, state) ? state : undefined;
        if (matchingState && (matchingState.activityEpoch ?? 0) > job.activityEpoch) {
          if (matchingState.pendingCompletion?.phase === "resuming") {
            const client = await clientForJob(job, options);
            await completeResume(options.userDataPath, matchingState, client, queue);
          } else {
            await queue.removeIfUnchanged(job);
          }
          return;
        }
        if (
          matchingState?.pendingCompletion
          && matchingState.pendingCompletion.activityEpoch === job.activityEpoch
          && matchingState.pendingCompletion.operationId !== job.operationId
        ) {
          await queue.removeIfUnchanged(job);
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
        else await queue.removeIfUnchanged(job);
      } catch (error) {
        if (
          error instanceof AgentHubHttpError
          && (error.code === "session_not_found" || error.code === "session_already_closed")
        ) {
          if (await queue.removeIfUnchanged(job)) {
            await clearPendingState(options.userDataPath, job);
          }
          return;
        }
        const failure = toError(error);
        await queue.recordRetry(job, failure, now);
        options.onError?.(failure, job);
      }
    });
  }
}

/** 返回 null 表示任务已经终止；返回诊断则由调用者安排约 15 秒后的重试。 */
export async function processTurnCompletionJob(
  job: TurnCompletionJob,
  options: ProcessTurnCompletionJobOptions,
): Promise<{ error: Error | null } | null> {
  const stop = await options.client.post<StopResponse>(
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

  if (Array.isArray(stop.managedLeases)) {
    const validationError = validateManagedLeaseManifest(stop.managedLeases);
    if (validationError) return { error: validationError };
    if (stop.managedLeases.length > 1) {
      return {
        error: new Error("Agent Hub returned more than one canonical Agent-managed lease; preserving protection until TTL."),
      };
    }
    job.leaseIds = stop.managedLeases.map((lease) => lease.id);
    job.leaseAttributionComplete = true;
    if (stop.managedLeases.length > 0) {
      job.expiresAt = new Date(Math.max(
        Date.parse(job.expiresAt),
        ...stop.managedLeases.map((lease) => Date.parse(lease.expiresAt)),
      )).toISOString();
    }
    await adoptManagedLeaseManifest(options.userDataPath, job, stop.managedLeases);
    if (stop.managedLeases.length === 0 && job.attributedPaths.length === 0) {
      await markStoppedState(options.userDataPath, job);
      return null;
    }
  } else if (Array.isArray(stop.awaitingAutomaticLeases)) {
    const serverLeases = stop.awaitingAutomaticLeases;
    const malformed = serverLeases.some((lease) =>
      !lease || typeof lease.id !== "string" || !lease.id.trim()
      || typeof lease.expiresAt !== "string" || !Number.isFinite(Date.parse(lease.expiresAt)));
    if (malformed) {
      return { error: new Error("Agent Hub returned incomplete automatic lease evidence; preserving protection until TTL.") };
    }
    const knownLeaseIds = new Set(job.leaseIds);
    const unknownLeases = serverLeases.filter((lease) => !knownLeaseIds.has(lease.id));
    if (unknownLeases.length > 0) {
      job.expiresAt = new Date(Math.max(...serverLeases.map((lease) => Date.parse(lease.expiresAt)))).toISOString();
      return {
        error: new Error(
          "Local Hook state does not account for every active automatic lease; preserving protection until TTL.",
        ),
      };
    }
    if (serverLeases.length === 0 && job.leaseIds.length === 0) {
      await markStoppedState(options.userDataPath, job);
      return null;
    }
  } else {
    // 只有服务端明确返回租约清单（合法空任务为 []）才能证明没有遗漏；
    // 字段缺失可能来自旧响应或证据截断，必须保留保护直至 TTL。
    return { error: new Error("Automatic lease evidence is unavailable; preserving protection until TTL.") };
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

  const completion = await options.client.post<CompletionResponse>(
    `/api/sessions/${encodeURIComponent(job.hubSessionId)}/completion/check`, {
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
  else {
    await markStoppedState(
      options.userDataPath,
      job,
      confirmedReleasedLeaseIds(job, completion),
    );
  }
  return null;
}

function confirmedReleasedLeaseIds(
  job: TurnCompletionJob,
  completion: CompletionResponse,
): string[] {
  const confirmsRelease = completion.result === "released"
    || (completion.result === "already_applied" && completion.previousResult === "released");
  if (!confirmsRelease || !Array.isArray(completion.releasedLeaseIds)) return [];
  const expected = new Set(job.leaseIds);
  return [...new Set(completion.releasedLeaseIds
    .filter((leaseId): leaseId is string => typeof leaseId === "string")
    .map((leaseId) => leaseId.trim())
    .filter((leaseId) => leaseId && expected.has(leaseId)))];
}

function validateManagedLeaseManifest(
  leases: NonNullable<StopResponse["managedLeases"]>,
): Error | undefined {
  const malformed = leases.some((lease) =>
    !lease
    || typeof lease.id !== "string"
    || !lease.id.trim()
    || !Array.isArray(lease.paths)
    || lease.paths.some((candidate) => typeof candidate !== "string" || !candidate.trim())
    || typeof lease.expiresAt !== "string"
    || !Number.isFinite(Date.parse(lease.expiresAt)));
  return malformed
    ? new Error("Agent Hub returned incomplete managed lease evidence; preserving protection until TTL.")
    : undefined;
}

async function adoptManagedLeaseManifest(
  userDataPath: string,
  job: TurnCompletionJob,
  leases: NonNullable<StopResponse["managedLeases"]>,
): Promise<void> {
  const stateStore = new CodexHookStateStore(userDataPath);
  await stateStore.runExclusive(job.codexSessionId, async () => {
    const state = await stateStore.load(job.codexSessionId);
    if (!state || !matchesTurnCompletionJob(job, state)) return;
    state.leases = leases.map((lease) => ({
      id: lease.id,
      paths: [...new Set(lease.paths.map((candidate) => candidate.trim()).filter(Boolean))],
      expiresAt: lease.expiresAt,
      coordinationState: state.leases.find((candidate) => candidate.id === lease.id)?.coordinationState,
    }));
    state.leaseAttributionComplete = true;
    await stateStore.save(state);
  });
}

/**
 * 新写入先持久化更高 epoch，再以同一个幂等 operation 重试 resume。只有服务端确认后，
 * PreToolUse 才继续到 prepare/claim，因此旧完成任务即使并发返回也不能覆盖新活动。
 */
export async function resumePendingTurnCompletion(
  options: ResumePendingCompletionOptions,
): Promise<void> {
  const queue = new TurnCompletionQueueStore(options.userDataPath);
  const jobs = await queue.listForLifecycle(options.state);
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

  const response = await options.client.post<ResumeResponse>(
    `/api/sessions/${encodeURIComponent(options.state.hubSessionId)}/resume`,
    {
      operationId: pending.operationId,
      turnId: pending.turnId,
      activityEpoch: pending.activityEpoch,
    },
  );
  applyResumeResponse(options.state, pending, response);
  await options.stateStore.save(options.state);
  await queue.removeForLifecycle(options.state, options.state.activityEpoch);
}

async function completeResume(
  userDataPath: string,
  state: CodexHookSessionState,
  client: AgentHubClient,
  queue: TurnCompletionQueueStore,
): Promise<void> {
  const pending = state.pendingCompletion;
  if (!pending || pending.phase !== "resuming") return;
  const response = await client.post<ResumeResponse>(
    `/api/sessions/${encodeURIComponent(state.hubSessionId)}/resume`,
    {
      operationId: pending.operationId,
      turnId: pending.turnId,
      activityEpoch: pending.activityEpoch,
    },
  );
  const stateStore = new CodexHookStateStore(userDataPath);
  const resumedEpoch = await stateStore.runExclusive(state.codexSessionId, async () => {
    const latest = await stateStore.load(state.codexSessionId);
    if (
      !latest
      || !matchesTurnCompletionJob(state, latest)
      || !latest.pendingCompletion
      || latest.pendingCompletion.operationId !== pending.operationId
      || latest.pendingCompletion.activityEpoch !== pending.activityEpoch
      || latest.pendingCompletion.phase !== "resuming"
    ) return undefined;
    applyResumeResponse(latest, latest.pendingCompletion, response);
    await stateStore.save(latest);
    return latest.activityEpoch;
  });
  if (resumedEpoch !== undefined) {
    await queue.removeForLifecycle(state, resumedEpoch);
  }
}

function applyResumeResponse(
  state: CodexHookSessionState,
  pending: NonNullable<CodexHookSessionState["pendingCompletion"]>,
  response: ResumeResponse,
): void {
  if (response.result === "resumed") {
    state.activityEpoch = pending.activityEpoch;
    state.currentTurnId = pending.turnId;
    state.pendingCompletion = undefined;
    return;
  }
  if (response.result === "already_applied") {
    if (response.previousResult !== "resumed") {
      throw new Error("Agent Hub replayed a resume without a confirmed resumed result.");
    }
    state.activityEpoch = pending.activityEpoch;
    state.currentTurnId = pending.turnId;
    state.pendingCompletion = undefined;
    return;
  }
  if (response.result !== "superseded") {
    throw new Error("Agent Hub returned an invalid resume result.");
  }

  const server = response.session;
  if (
    server?.status !== "active"
    || server.turnStoppedAt !== null
    || server.currentTurnId !== pending.turnId
    || !Number.isSafeInteger(server.activityEpoch)
    || Number(server.activityEpoch) < pending.activityEpoch
  ) {
    throw new Error(
      "Agent Hub superseded the resume request without proving that this turn is active; the write remains blocked.",
    );
  }

  // 同一 turn 已由并发请求恢复时，以服务端 epoch 为准；其他 superseded 状态继续保留本地证据并阻止写入。
  state.activityEpoch = Number(server.activityEpoch);
  state.currentTurnId = pending.turnId;
  state.pendingCompletion = undefined;
}

async function clearPendingState(userDataPath: string, job: TurnCompletionJob): Promise<void> {
  const stateStore = new CodexHookStateStore(userDataPath);
  await stateStore.runExclusive(job.codexSessionId, async () => {
    const state = await stateStore.load(job.codexSessionId);
    if (
      !state
      || !matchesTurnCompletionJob(job, state)
      || !state.pendingCompletion
      || state.pendingCompletion.operationId !== job.operationId
      || state.pendingCompletion.activityEpoch !== job.activityEpoch
    ) return;
    state.pendingCompletion = undefined;
    await stateStore.save(state);
  });
}

async function markStoppedState(
  userDataPath: string,
  job: TurnCompletionJob,
  releasedLeaseIds: string[] = [],
): Promise<void> {
  const stateStore = new CodexHookStateStore(userDataPath);
  await stateStore.runExclusive(job.codexSessionId, async () => {
    const state = await stateStore.load(job.codexSessionId);
    if (
      !state
      || !matchesTurnCompletionJob(job, state)
      || !state.pendingCompletion
      || state.pendingCompletion.operationId !== job.operationId
      || state.pendingCompletion.activityEpoch !== job.activityEpoch
    ) return;
    if (releasedLeaseIds.length > 0) {
      // 只删除当前 completion 明确释放的租约；上面的 generation/operation/epoch 围栏保护新 Turn 的 canonical 状态。
      const released = new Set(releasedLeaseIds);
      state.leases = state.leases.filter((lease) => !released.has(lease.id));
      if (state.leases.length === 0 && job.leaseAttributionComplete) {
        state.leaseAttributionComplete = true;
      }
    }
    state.pendingCompletion.phase = "stopped";
    await stateStore.save(state);
  });
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
