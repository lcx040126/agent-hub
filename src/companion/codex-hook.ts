import type { Readable, Writable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { SecretProtector } from "../desktop/connection-store.js";
import type { SavedRoomConnection } from "../desktop/contracts.js";
import {
  AGENT_HUB_PROTOCOL_VERSION,
  AGENT_HUB_SCHEMA_VERSION,
  AGENT_HUB_VERSION,
} from "../shared/version.js";
import {
  estimateContextTokens,
  packContextByBudget,
  type ContextBudgetCandidate,
} from "../server/context-budget.js";
import {
  AmbiguousRepositoryConnectionError,
  openConnectionStore,
  resolveConnectionRecordById,
  resolveConnectionRecordForPath,
  type ResolvedRoomConnection,
  type ResolvedRoomConnectionRecord,
} from "./connection-runtime.js";
import {
  inspectGitIdentity,
  inspectGitWorkingPathsFromIdentity,
  inspectGitWorkingStateFromIdentity,
  inspectGitWorkingState,
  toRepositoryRelativePath,
  type GitWorkingState,
} from "./git-state.js";
import { AgentHubClient, AgentHubHttpError } from "./hub-client.js";
import {
  collectFeatureGitEvidence,
  type FeatureGitEvidence,
} from "./feature-evidence.js";
import {
  applyHookProtectionMode,
  CodexHookStateLockTimeoutError,
  CodexHookStateStore,
  type CodexHookSessionState,
  type HookLeaseState,
  type HookProposedEditState,
} from "./hook-state.js";
import {
  enforceWriteHookPolicy,
  failOpenWriteHookOutput,
  hasVerifiedManualExclusiveBlocker,
  isVerifiedManualExclusiveClaim,
  markVerifiedManualExclusiveBlock,
  requiresAuthoritativeModeRecheck,
  type AuthoritativeHookProtectionPolicy,
  type HookProtectionPolicy,
} from "./codex-hook-policy.js";
import {
  attributedChangedPaths,
  extractAttributedWriteIntent,
  type AttributedWriteIntent,
} from "./write-attribution.js";
import { getLocalIntegrationStatus, getRuntimeIntegrationStatus } from "./integration-gate.js";
import { IntegrationOperationTracker } from "./integration-operations.js";
import {
  matchesSessionEndJob,
  SessionEndQueueStore,
  type SessionEndQueueJob,
} from "./session-end-queue.js";
import {
  matchesTurnCompletionJob,
  TurnCompletionQueueStore,
  type TurnCompletionJob,
} from "./turn-completion-queue.js";
import {
  processTurnCompletionJob,
  resumePendingTurnCompletion,
} from "./turn-completion-worker.js";
import { collectAttributedPathEvidence, type AttributedPathEvidence } from "./turn-completion.js";

export type CodexHookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SessionEnd";

export interface RunCodexHookOptions {
  eventName: CodexHookEventName;
  userDataPath: string;
  cwd?: string;
  stdin?: Readable;
  stdout?: Writable;
  protector?: SecretProtector;
  fetchImpl?: typeof fetch;
  gitExecutable?: string;
  /** Override used by embedded callers/tests; production uses userData/runtime-presence.json. */
  runtimePresencePath?: string;
}

export interface CodexHookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  source?: string;
  reason?: string;
  turn_id?: string;
  stop_hook_active?: boolean;
}

interface HookRuntime {
  input: CodexHookInput;
  connection: SavedRoomConnection;
  client: AgentHubClient;
  git: GitWorkingState;
  state: CodexHookSessionState;
  stateStore: CodexHookStateStore;
}

interface OpenHookSessionResponse {
  session: {
    id: string;
    status: string;
    currentTurnId?: string | null;
    activityEpoch?: number;
    turnStoppedAt?: string | null;
    reused?: boolean;
  };
}

class HookGenerationAdoptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HookGenerationAdoptionError";
  }
}

interface RoomSnapshotLike {
  room?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  members?: unknown[];
  activeLeases?: unknown[];
  decisions?: unknown[];
  verifications?: unknown[];
  records?: unknown[];
  handoffs?: unknown[];
  localScans?: unknown[];
  releaseRequests?: unknown[];
  featureMemories?: unknown[];
  featureMemoryIndexHasMore?: boolean;
  featureMemoryIndexUnavailable?: boolean;
}

interface EditCheckResponse {
  allowed: boolean;
  blockers: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
  coveredPaths: string[];
  uncoveredPaths: string[];
  historicalImpacts?: Array<Record<string, unknown>>;
  featureConfirmation?: Record<string, unknown>;
}

interface LeaseResponse {
  acquired: boolean;
  decision: "allow" | "warn" | "deny" | "wait";
  lease?: { id: string; paths?: string[]; expiresAt: string };
  conflicts?: Array<Record<string, unknown>>;
  waitingFor?: {
    leaseId: string;
    sessionId?: string | null;
    title: string;
    memberName: string;
    expiresAt: string;
    paths: string[];
  };
}

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const MAX_SESSION_FEATURE_PATHS = 100;
const LEASE_TTL_MINUTES = 10;
const STOP_STATE_LOCK_TIMEOUT_MS = 750;

export async function runCodexHook(options: RunCodexHookOptions): Promise<number> {
  const output = options.stdout ?? process.stdout;
  try {
    const input = parseHookInput(await readHookInput(options.stdin ?? process.stdin));
    const result = await handleCodexHook(options, input);
    if (result !== undefined) output.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const result = failureOutput(options.eventName, error);
    if (result !== undefined) output.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
}

export async function handleCodexHook(
  options: RunCodexHookOptions,
  input: CodexHookInput,
): Promise<Record<string, unknown> | undefined> {
  if (input.hook_event_name && input.hook_event_name !== options.eventName) {
    throw new Error(`Hook event mismatch: expected ${options.eventName}.`);
  }
  if (options.eventName === "SessionEnd") {
    await handleSessionEnd(options, input);
    return undefined;
  }
  if (options.eventName === "Stop") {
    try {
      await handleStop(options, input);
    } catch {
      // Stop 不能延长或阻塞 Codex 回合；持久化失败也由后续写入或租约 TTL 兜底。
    }
    return { continue: true };
  }
  const writeEvent = isWriteHookEvent(options.eventName) ? options.eventName : undefined;
  let writePolicy: HookProtectionPolicy | undefined;
  let trackedRecord: ResolvedRoomConnectionRecord | undefined;
  try {
    const runtimePresence = await getRuntimeIntegrationStatus(
      options.userDataPath,
      options.runtimePresencePath,
    );
    if (!runtimePresence.active) return undefined;
    const record = await resolveTrackedConnectionRecord(options, input);
    if (!record) return undefined;
    trackedRecord = record;
    const connectionId = record.connection.id;
    const localStatus = await getLocalIntegrationStatus(
      options.userDataPath,
      record.connection,
      options.runtimePresencePath,
    );
    if (!localStatus.active) return undefined;
    if (!localStatus.remoteAllowed) {
      return failureOutput(
        options.eventName,
        new HookCleanupPendingError(localStatus.diagnostic),
      );
    }
    if (writeEvent) {
      // 每次写入事件都读取权威设置。读取失败本身绝不能成为新的写入门禁。
      writePolicy = await readAuthoritativeHookProtectionPolicy(options, record);
      if (!writePolicy.authoritative) {
        return failOpenWriteHookOutput(writeEvent, writePolicy.warning);
      }
    }
    let effectiveWritePolicy = writePolicy;
    const dispatch = async () => {
      const result = await dispatchCodexHook(options, input, record, writePolicy);
      await assertHookIntegrationActive(options, connectionId);
      if (
        writeEvent
        && writePolicy?.authoritative
        && requiresAuthoritativeModeRecheck(writeEvent, result)
      ) {
        // prepare/check 可能在首次读设置后才切回保护模式；未标记拒绝必须二次读取后再决定是否降级。
        effectiveWritePolicy = await readAuthoritativeHookProtectionPolicy(options, record);
      }
      return result;
    };
    const result = await new IntegrationOperationTracker(options.userDataPath).run(connectionId, dispatch);
    if (!writeEvent) return result;
    if (!effectiveWritePolicy) return result;
    if (!effectiveWritePolicy.authoritative) {
      return failOpenWriteHookOutput(writeEvent, effectiveWritePolicy.warning);
    }
    return enforceWriteHookPolicy(writeEvent, result, effectiveWritePolicy);
  } catch (error) {
    if (error instanceof HookIntegrationInactiveError) {
      await new CodexHookStateStore(options.userDataPath).remove(input.session_id);
      return undefined;
    }
    if (!writeEvent) throw error;
    const latestWritePolicy = trackedRecord
      ? await readAuthoritativeHookProtectionPolicy(options, trackedRecord)
      : undefined;
    if (latestWritePolicy?.authoritative && latestWritePolicy.blockingProtectionEnabled) {
      return failureOutput(writeEvent, error, true);
    }
    return failOpenWriteHookOutput(
      writeEvent,
      latestWritePolicy && !latestWritePolicy.authoritative
        ? `无法完成本次协调检查：${humanError(error)}。${latestWritePolicy.warning}`
        : `无法完成本次协调检查：${humanError(error)}。`,
    );
  }
}

interface PrepareEditsResponse {
  check: EditCheckResponse;
  claim?: LeaseResponse;
  renewedLeases?: Array<{ id: string; paths?: string[]; expiresAt: string }>;
}

interface WriteBlockedResponse {
  releasedLeaseIds: string[];
  blockedLeaseIds: string[];
}

async function dispatchCodexHook(
  options: RunCodexHookOptions,
  input: CodexHookInput,
  record: ResolvedRoomConnectionRecord,
  writePolicy?: HookProtectionPolicy,
): Promise<Record<string, unknown> | undefined> {
  switch (options.eventName) {
    case "SessionStart":
      return handleSessionStart(options, input, record);
    case "UserPromptSubmit":
      return handleUserPromptSubmit(options, input, record);
    case "PreToolUse":
      return handlePreToolUse(options, input, record, requireAuthoritativeWritePolicy(writePolicy));
    case "PostToolUse":
      return handlePostToolUse(options, input, record, requireAuthoritativeWritePolicy(writePolicy));
    case "Stop":
      return { continue: true };
    case "SessionEnd":
      return undefined;
  }
}

async function handleUserPromptSubmit(
  options: RunCodexHookOptions,
  input: CodexHookInput,
  record: ResolvedRoomConnectionRecord,
): Promise<Record<string, unknown> | undefined> {
  const turnId = input.turn_id?.trim();
  if (!turnId) return undefined;
  const stateStore = new CodexHookStateStore(options.userDataPath);
  return stateStore.runExclusive(input.session_id, async () => {
    const runtime = await findHookRuntime(options, input, record);
    if (!runtime || runtime.state.currentTurnId === turnId) return undefined;
    try {
      // 上一轮 Stop 留下的完成证据必须经幂等 resume 协议收口，不能由提示事件直接清空。
      await resumePendingTurnCompletion({
        userDataPath: options.userDataPath,
        state: runtime.state,
        stateStore: runtime.stateStore,
        client: runtime.client,
        turnId,
      });
      if (runtime.state.currentTurnId === turnId) return undefined;

      const nextEpoch = Math.max(runtime.state.activityEpoch ?? 0, 0) + 1;
      await registerAndAdoptHookGeneration(
        runtime,
        input,
        turnId,
        nextEpoch,
        "UserPromptSubmit",
        options,
      );
    } catch {
      // Prompt submission is advisory; PreToolUse performs the authoritative retry.
    }
    return undefined;
  });
}

async function resolveTrackedConnectionRecord(
  options: RunCodexHookOptions,
  input: CodexHookInput,
): Promise<ResolvedRoomConnectionRecord | undefined> {
  const state = await new CodexHookStateStore(options.userDataPath).load(input.session_id);
  if (state) {
    return resolveConnectionRecordById(options.userDataPath, state.connectionId, options.protector);
  }
  return resolveConnectionRecordForPath(
    options.userDataPath,
    input.cwd || options.cwd || process.cwd(),
    options.protector,
  );
}

async function readAuthoritativeHookProtectionPolicy(
  options: RunCodexHookOptions,
  record: ResolvedRoomConnectionRecord,
): Promise<HookProtectionPolicy> {
  try {
    const resolved = await hydrateConnectionRecord(record);
    const client = new AgentHubClient({
      serverUrl: resolved.connection.serverUrl,
      memberToken: resolved.memberToken,
      fetchImpl: createHookGatedFetch(options, resolved.connection.id),
    });
    const response = await client.get<{ settings?: Record<string, unknown> }>("/api/room/settings");
    const enabled = response.settings?.blockingProtectionEnabled;
    if (typeof enabled !== "boolean") {
      throw new Error("The room settings response omitted blockingProtectionEnabled.");
    }
    return { authoritative: true, blockingProtectionEnabled: enabled };
  } catch (error) {
    return {
      authoritative: false,
      warning: `无法读取房间的权威保护模式（${humanError(error)}）；按故障放行策略处理。`,
    };
  }
}

function requireAuthoritativeWritePolicy(
  policy: HookProtectionPolicy | undefined,
): AuthoritativeHookProtectionPolicy {
  if (!policy?.authoritative) throw new Error("The write Hook is missing an authoritative room policy.");
  return policy;
}

function isWriteHookEvent(event: CodexHookEventName): event is "PreToolUse" | "PostToolUse" {
  return event === "PreToolUse" || event === "PostToolUse";
}

async function handleSessionStart(
  options: RunCodexHookOptions,
  input: CodexHookInput,
  record: ResolvedRoomConnectionRecord,
): Promise<Record<string, unknown> | undefined> {
  const stateStore = new CodexHookStateStore(options.userDataPath);
  const sessionEndQueue = new SessionEndQueueStore(options.userDataPath);
  const runtime = await stateStore.runExclusive(input.session_id, async () => {
    let existingState = await stateStore.load(input.session_id);
    if (existingState && existingState.connectionId !== record.connection.id) return undefined;
    if (!(await getLocalIntegrationStatus(
      options.userDataPath,
      record.connection,
      options.runtimePresencePath,
    )).active) return undefined;
    const resolved = await hydrateConnectionRecord(record);
    const pendingFinalizations = (await sessionEndQueue.listForSession(input.session_id))
      .filter((job) => job.connectionId === record.connection.id);
    const matchingFinalization = existingState
      ? pendingFinalizations.find((job) => matchesSessionEndJob(job, existingState!))
      : undefined;
    if (existingState && matchingFinalization) {
      await sessionEndQueue.mergeState(matchingFinalization.finalizationId, existingState);
    }
    // 先让旧代次进入 finalizing，服务端才会为同一个 Codex task 分配新的 active Hub session。
    await ensurePendingFinalizationsStarted(options, resolved, pendingFinalizations);
    if (existingState && matchingFinalization) {
      await stateStore.remove(input.session_id);
      existingState = undefined;
    }
    return openHookRuntime(options, input, resolved, !existingState, existingState);
  });
  if (!runtime) return undefined;
  const snapshot = await runtime.client.get<RoomSnapshotLike>("/api/snapshot");
  const snapshotProtectionMode = snapshot.settings?.blockingProtectionEnabled;
  if (typeof snapshotProtectionMode === "boolean") {
    const transition = applyHookProtectionMode(runtime.state, snapshotProtectionMode);
    if (transition.changed) await runtime.stateStore.save(runtime.state);
  }
  try {
    const featureIndex = await runtime.client.post<FeatureQueryResponse>("/api/features/query", {
      sessionId: runtime.state.hubSessionId,
      level: "cards",
      statuses: ["current"],
      limit: 8,
    });
    snapshot.featureMemories = featureIndex.cards;
    snapshot.featureMemoryIndexHasMore = Boolean(featureIndex.nextCursor);
  } catch {
    // Real-time coordination must remain available even if the optional memory index cannot load.
    snapshot.featureMemoryIndexUnavailable = true;
  }
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: formatRoomContext(
        snapshot,
        runtime.connection,
        runtime.git,
        runtime.state.hubSessionId,
      ),
    },
  };
}

async function handlePreToolUse(
  options: RunCodexHookOptions,
  input: CodexHookInput,
  record: ResolvedRoomConnectionRecord,
  policy: AuthoritativeHookProtectionPolicy,
): Promise<Record<string, unknown> | undefined> {
  const intent = extractAttributedWriteIntent(input.tool_name, input.tool_input);
  if (!intent.writes) return undefined;
  const stateStore = new CodexHookStateStore(options.userDataPath);
  // PreToolUse 会跨多次网络调用读写 epoch、completion 与 pendingWrite；整段串行化才能阻止 Stop 覆盖新回合。
  return stateStore.runExclusive(input.session_id, () =>
    handlePreToolUseExclusive(options, input, record, intent, policy));
}

async function handlePreToolUseExclusive(
  options: RunCodexHookOptions,
  input: CodexHookInput,
  record: ResolvedRoomConnectionRecord,
  intent: AttributedWriteIntent,
  policy: AuthoritativeHookProtectionPolicy,
): Promise<Record<string, unknown> | undefined> {
  const runtime = await findHookRuntime(options, input, record);
  if (!runtime) return undefined;
  const modeTransition = applyHookProtectionMode(
    runtime.state,
    policy.blockingProtectionEnabled,
  );
  if (modeTransition.changed) await runtime.stateStore.save(runtime.state);
  const monitorMode = !policy.blockingProtectionEnabled;
  const monitorWarnings = [...modeTransition.warnings];
  if (runtime.state.quarantine) {
    return denyOutput(
      `Agent Hub 已隔离当前会话，因为先前检测到越界写入：${runtime.state.quarantine.reason}`
      + " 请停止新增修改，人工检查现有 Git 差异，并结束当前 Codex 会话后再继续。",
    );
  }
  try {
    await resumePendingTurnCompletion({
      userDataPath: options.userDataPath,
      state: runtime.state,
      stateStore: runtime.stateStore,
      client: runtime.client,
      turnId: completionTurnId(input, (runtime.state.activityEpoch ?? 0) + 1),
    });
  } catch (error) {
    if (error instanceof HookIntegrationInactiveError || error instanceof HookCleanupPendingError) throw error;
    const reason = `Agent Hub 尚未确认上一回合已恢复：${humanError(error)}`;
    if (!monitorMode) {
      // 保护模式仍保持原有完成围栏；监测模式只保留诊断并继续尝试登记本次写入。
      return denyOutput(`${reason}，本次写入已暂停。`);
    }
    monitorWarnings.push(reason);
  }
  const currentTurnId = completionTurnId(input, runtime.state.activityEpoch ?? 0);
  if (runtime.state.currentTurnId !== currentTurnId) {
    runtime.state.currentTurnId = currentTurnId;
    await runtime.stateStore.save(runtime.state);
  }
  let paths = normalizeCandidates(
    runtime.git.repositoryRoot,
    mapRepositoryCwd(
      runtime.connection.repositoryPath,
      runtime.git.repositoryRoot,
      input.cwd,
    ),
    intent.pathCandidates,
  );
  let proposedEdits = normalizeProposedEdits(
    runtime.git.repositoryRoot,
    mapRepositoryCwd(runtime.connection.repositoryPath, runtime.git.repositoryRoot, input.cwd),
    intent,
  );
  if (paths.length > 0) {
    const targetedBaseline = await inspectGitWorkingPathsFromIdentity(runtime.git, paths, {
      gitExecutable: options.gitExecutable,
    });
    mergeTargetedObservation(runtime.state, paths, targetedBaseline);
    runtime.git = {
      ...targetedBaseline,
      changedPaths: [...runtime.state.observedChangedPaths],
      changedPathFingerprints: { ...runtime.state.observedChangedFingerprints },
    };
  } else if (intent.attributedSideEffects) {
    runtime.git = await inspectGitWorkingStateFromIdentity(runtime.git, {
      gitExecutable: options.gitExecutable,
    });
    runtime.state.observedChangedPaths = [...runtime.git.changedPaths];
    runtime.state.observedChangedFingerprints = { ...runtime.git.changedPathFingerprints };
  }

  if (paths.length > MAX_SESSION_FEATURE_PATHS || proposedEdits.length > MAX_SESSION_FEATURE_PATHS) {
    const reason = `Agent Hub 单次最多协调 ${MAX_SESSION_FEATURE_PATHS} 个明确写入路径；本次命令解析到 ${Math.max(paths.length, proposedEdits.length)} 个。`;
    if (!monitorMode) {
      return denyOutput(
        `${reason} 请让 Agent 把修改拆成多个较小的工具调用，确保每个路径都能在写入前完成租约和历史功能检查。`,
      );
    }
    monitorWarnings.push(`${reason} 监测模式将登记前 ${MAX_SESSION_FEATURE_PATHS} 个路径并继续写入。`);
    paths = paths.slice(0, MAX_SESSION_FEATURE_PATHS);
    proposedEdits = proposedEdits.slice(0, MAX_SESSION_FEATURE_PATHS);
  }

  if (!monitorMode && runtime.state.writeBlockSyncPending) {
    const writeBlockReason = await resynchronizeWriteBlockFence(runtime, paths);
    if (writeBlockReason) return denyOutput(writeBlockReason);
  }

  if (paths.length === 0) {
    if (!monitorMode && runtime.state.leaseAttributionComplete === false) {
      return denyOutput(
        "Agent Hub 复用了远端会话，但本机缺少该会话的完整租约状态；"
        + "不能执行无法预先确定输出路径的生成、格式化或构建写入。请改用明确路径的写入工具。",
      );
    }
    const passiveWriteBlock = runtime.state.passiveWriteBlock;
    if (!monitorMode && passiveWriteBlock) {
      return denyOutput(
        `Agent Hub 正在等待 ${passiveWriteBlock.memberName} 释放较早会话的写入范围；`
        + "不能执行无法预先确定输出路径的生成、格式化或构建写入。"
        + ` 缓存租约预计 ${formatHookExpiry(passiveWriteBlock.expiresAt)}，届时仍须改用明确路径的写入工具向房间重新检查。`,
      );
    }
    const blockedLease = runtime.state.leases.find((lease) => lease.coordinationState === "blocked");
    if (!monitorMode && blockedLease) {
      return denyOutput(
        "Agent Hub 已阻塞当前会话的自动租约；在未提交改动清理并由明确路径写入向房间复核前，"
        + "不能执行无法预先确定输出路径的生成、格式化或构建写入。",
      );
    }
    if (intent.attributedSideEffects && intent.proposalHash) {
      const stopFence = await adoptConcurrentStopFence(options.userDataPath, runtime);
      if (stopFence && !monitorMode) return stopFence;
      if (stopFence) monitorWarnings.push("检测到并发 Stop 围栏；监测模式继续写入并保留完成状态证据。");
      setPendingWrite(runtime, input, intent, proposedEdits);
      await runtime.stateStore.save(runtime.state);
      return allowOutput(
        monitorContext(
          "Agent Hub 已识别这是一项生成、格式化或构建写入；输出路径将在工具结束后按本次增量归因并立即检查。",
          monitorWarnings,
        ),
      );
    }
    const hasRepositoryLease = runtime.state.leases.some((lease) =>
      lease.coordinationState !== "blocked"
      && Date.parse(lease.expiresAt) > Date.now()
      && lease.paths.some((leasePath) => leasePath === "."),
    );
    if (hasRepositoryLease) {
      const stopFence = await adoptConcurrentStopFence(options.userDataPath, runtime);
      if (stopFence && !monitorMode) return stopFence;
      if (stopFence) monitorWarnings.push("检测到并发 Stop 围栏；监测模式继续写入并保留完成状态证据。");
      return allowOutput(monitorContext("Agent Hub 已确认当前会话持有整个仓库的写入范围。", monitorWarnings));
    }
    if (monitorMode) {
      if (runtime.state.leaseAttributionComplete === false) {
        monitorWarnings.push("本地缺少远端会话的完整租约归因，工具结束后将按 Git 增量尽量补登记。");
      }
      setPendingWrite(runtime, input, intent, proposedEdits);
      await runtime.stateStore.save(runtime.state);
      return allowOutput(monitorContext(
        "Agent Hub 无法预先确定输出路径；监测模式允许写入，并将在工具结束后扫描实际变化。",
        monitorWarnings,
      ));
    }
    return denyOutput(
      "Agent Hub 无法从这条命令确定将写入哪些文件。请让 Agent 改用 apply_patch，或先通过 lease_acquire 明确领取最小路径后再执行。",
    );
  }

  const stopFenceBeforePrepare = await adoptConcurrentStopFence(options.userDataPath, runtime);
  if (stopFenceBeforePrepare && !monitorMode) return stopFenceBeforePrepare;
  if (stopFenceBeforePrepare) monitorWarnings.push("检测到并发 Stop 围栏；监测模式继续执行权威风险检查。");
  if (!monitorMode) {
    const blockedLeaseReason = await resynchronizeWriteBlockFence(runtime, paths);
    if (blockedLeaseReason) return denyOutput(blockedLeaseReason);
  }

  let prepared: PrepareEditsResponse | undefined;
  let recoveredActivityEpoch = false;
  let activityRecoveryAttempted = false;
  try {
    prepared = await runtime.client.post<PrepareEditsResponse>("/api/edits/prepare", {
      sessionId: runtime.state.hubSessionId,
      title: `Codex 自动范围 ${shortSessionId(input.session_id)}`,
      intent: `由 ${input.tool_name ?? "写入工具"} 在实际修改前自动领取`,
      branch: runtime.git.branch,
      baseCommit: runtime.git.headCommit,
      turnId: runtime.state.currentTurnId,
      activityEpoch: runtime.state.activityEpoch ?? 0,
      paths,
      proposedEdits,
    });
  } catch (error) {
    let preparationError = error;
    if (error instanceof AgentHubHttpError && error.code === "stale_activity_epoch") {
      activityRecoveryAttempted = true;
      const details = isRecord(error.details) ? error.details : {};
      const currentEpoch = typeof details.currentActivityEpoch === "number"
        ? details.currentActivityEpoch
        : runtime.state.activityEpoch ?? 0;
      const recoveryEpoch = currentEpoch + 1;
      const recoveryTurnId = input.turn_id?.trim()
        || completionTurnId(input, recoveryEpoch);
      try {
        await registerAndAdoptHookGeneration(
          runtime,
          input,
          recoveryTurnId,
          recoveryEpoch,
          "stale_activity_epoch_recovery",
          options,
        );
        prepared = await runtime.client.post<PrepareEditsResponse>("/api/edits/prepare", {
          sessionId: runtime.state.hubSessionId,
          title: "Codex automatic write retry",
          intent: "Retry after stale activity epoch recovery",
          branch: runtime.git.branch,
          baseCommit: runtime.git.headCommit,
          turnId: runtime.state.currentTurnId,
          activityEpoch: runtime.state.activityEpoch,
          paths,
          proposedEdits,
        });
        recoveredActivityEpoch = true;
      } catch (retryError) {
        if (retryError instanceof HookGenerationAdoptionError) {
          return denyOutput(
            `Agent Hub 无法接管当前 Codex 任务的新会话代际：${retryError.message} 本次写入保持暂停。`,
          );
        }
        if (retryError instanceof AgentHubHttpError && retryError.code === "stale_activity_epoch") {
          if (monitorMode) {
            monitorWarnings.push("服务端仍报告旧 activity epoch；监测模式允许写入并保留待补登记状态。");
            setPendingWrite(runtime, input, intent, proposedEdits);
            await runtime.stateStore.save(runtime.state);
            return allowOutput(monitorContext(undefined, monitorWarnings));
          }
          return denyOutput("Agent Hub 检测到会话活动已被更新；本次写入已暂停，请重新提交当前任务。");
        }
        preparationError = retryError;
      }
    }
    if (
      !recoveredActivityEpoch
      && preparationError instanceof AgentHubHttpError
      && (preparationError.code === "branch_changed" || preparationError.code === "session_frozen")
    ) {
      if (monitorMode) {
        monitorWarnings.push(`${preparationError.message} 监测模式不会因分支或冻结状态阻止写入。`);
        appendMonitorDiagnostic(runtime.state, "quarantine", preparationError.message, paths);
        setPendingWrite(runtime, input, intent, proposedEdits);
        await runtime.stateStore.save(runtime.state);
        return allowOutput(monitorContext(undefined, monitorWarnings));
      }
      runtime.state.quarantine = {
        reason: preparationError.message,
        paths: [],
        detectedAt: new Date().toISOString(),
      };
      await runtime.stateStore.save(runtime.state);
      return denyOutput(`${preparationError.message} 请确认新分支基线后重新开始 Codex 会话。`);
    }
    if (!recoveredActivityEpoch && activityRecoveryAttempted) {
      if (monitorMode) {
        monitorWarnings.push("过期 activity epoch 的权威恢复未完成；本次写入将继续并等待后续补登记。");
        setPendingWrite(runtime, input, intent, proposedEdits);
        await runtime.stateStore.save(runtime.state);
        return allowOutput(monitorContext(undefined, monitorWarnings));
      }
      return denyOutput(
        "Agent Hub 检测到当前写入使用了过期的会话活动轮次，但本次权威恢复未能完整完成；"
        + "写入保持暂停，请恢复房间连接后重新提交当前操作。",
      );
    }
    const blockedLease = runtime.state.leases.some((lease) => lease.coordinationState === "blocked");
    if (
      !recoveredActivityEpoch
      && (
        runtime.state.passiveWriteBlock
        || blockedLease
        || runtime.state.leaseAttributionComplete === false
      )
      && isSoftIntegrationFailure(preparationError)
    ) {
      if (monitorMode) {
        monitorWarnings.push("房间暂时无法确认旧等待或阻塞租约；监测模式按故障放行。");
        setPendingWrite(runtime, input, intent, proposedEdits);
        await runtime.stateStore.save(runtime.state);
        return allowOutput(monitorContext(undefined, monitorWarnings));
      }
      return denyOutput(
        "Agent Hub 已记录当前会话存在等待、阻塞或尚未恢复的租约状态，但暂时无法向房间服务确认写入范围；"
        + "本次写入保持暂停，请恢复连接后用明确路径重试。",
      );
    }
    if (!recoveredActivityEpoch) {
      if (!monitorMode) throw preparationError;
      monitorWarnings.push(`写入前风险登记失败：${humanError(preparationError)}。`);
      setPendingWrite(runtime, input, intent, proposedEdits);
      await runtime.stateStore.save(runtime.state);
      return allowOutput(monitorContext(undefined, monitorWarnings));
    }
  }
  if (!prepared) throw new Error("Agent Hub prepare did not return a result.");
  updateRenewedLeases(runtime.state, prepared.renewedLeases ?? []);
  if (prepared.claim?.acquired && prepared.claim.lease) {
    const claimedPaths = prepared.claim.lease.paths?.length ? prepared.claim.lease.paths : paths;
    upsertLease(runtime.state, {
      id: prepared.claim.lease.id,
      paths: claimedPaths,
      expiresAt: prepared.claim.lease.expiresAt,
    });
  }
  const stopFenceAfterPrepare = await adoptConcurrentStopFence(options.userDataPath, runtime);
  if (stopFenceAfterPrepare && !monitorMode) return stopFenceAfterPrepare;
  if (stopFenceAfterPrepare) monitorWarnings.push("风险检查后收到并发 Stop 围栏；监测模式继续写入。");
  if (prepared.check.allowed) {
    clearResolvedPassiveWriteBlock(runtime.state, paths);
    setPendingWrite(runtime, input, intent, proposedEdits);
    await runtime.stateStore.save(runtime.state);
    const claimed = prepared.claim?.acquired
      ? `Agent Hub 已自动领取写入范围：${paths.join("、")}。`
      : "";
    return allowOutput(monitorContext(
      `${claimed}${formatWarnings(prepared.check.warnings) ?? ""}` || undefined,
      monitorWarnings,
    ));
  }
  if (
    isVerifiedManualExclusiveClaim(prepared.claim)
    || hasVerifiedManualExclusiveBlocker(prepared.check)
  ) {
    return markVerifiedManualExclusiveBlock(
      denyOutput(prepared.claim
        ? formatConflicts(prepared.claim.conflicts ?? [], "deny")
        : formatEditBlockers(prepared.check.blockers, runtime.state.hubSessionId)),
    );
  }
  if (monitorMode) {
    const detectedRisk = prepared.claim && !prepared.claim.acquired
      ? formatConflicts(prepared.claim.conflicts ?? [], prepared.claim.decision)
      : formatEditBlockers(prepared.check.blockers, runtime.state.hubSessionId);
    return denyOutput(monitorContext(detectedRisk, monitorWarnings) ?? detectedRisk);
  }
  // 只有同一成员的并行会话等待才需要收束当前会话自己的自动租约。
  // 其他成员或手动独占范围只拒绝这一次目标写入，不能把当前任务的无关范围一并冻结。
  const passiveConflict = prepared.claim?.decision === "wait";
  if (passiveConflict) {
    const initial = new Set(runtime.state.initialChangedPaths.map(pathKey));
    // 本地租约归属不完整时必须按 dirty 处理，防止服务端把无法在本机重建的租约取消。
    const dirty = runtime.state.leaseAttributionComplete === false
      || runtime.state.pendingWrite !== undefined
      || (runtime.state.attributedChangedPaths?.length ?? 0) > 0
      || runtime.git.changedPaths.some((path) => !initial.has(pathKey(path)));
    const waitingFor = prepared.claim?.waitingFor;
    if (waitingFor) {
      runtime.state.passiveWriteBlock = {
        leaseId: waitingFor.leaseId,
        sessionId: typeof waitingFor.sessionId === "string" ? waitingFor.sessionId : undefined,
        memberName: waitingFor.memberName,
        paths: unique(waitingFor.paths.length > 0 ? waitingFor.paths : paths),
        requestedPaths: unique([
          ...(runtime.state.passiveWriteBlock?.requestedPaths ?? []),
          ...paths,
        ]),
        expiresAt: waitingFor.expiresAt,
      };
    }
    runtime.state.writeBlockSyncPending = {
      dirty,
      paths: unique(paths),
      recordedAt: new Date().toISOString(),
    };
    // write-ahead 保存必须先于网络调用；等待响应期间后台心跳不得续租尚未确认停止的范围。
    if (dirty) synchronizeBlockedLeaseState(runtime.state, undefined, true);
    await runtime.stateStore.save(runtime.state);
    const response = await runtime.client.post<WriteBlockedResponse>(
      `/api/sessions/${encodeURIComponent(runtime.state.hubSessionId)}/write-blocked`,
      {
        dirty,
        reason: "Waiting for an older same-member automatic lease.",
        paths,
      },
    ).catch(() => undefined);
    if (response) {
      synchronizeBlockedLeaseState(runtime.state, response, dirty);
      runtime.state.writeBlockSyncPending = undefined;
      await runtime.stateStore.save(runtime.state);
    }
  }
  if (prepared.claim && !prepared.claim.acquired) {
    if (prepared.claim.decision === "wait") {
      const waitingFor = prepared.claim.waitingFor;
      const holder = waitingFor && typeof waitingFor.memberName === "string"
        ? waitingFor.memberName
        : "同一成员的较早会话";
      const expiry = waitingFor && typeof waitingFor.expiresAt === "string"
        ? `，预计 ${formatHookExpiry(waitingFor.expiresAt)}`
        : "";
      return denyOutput(`Agent Hub 正在等待 ${holder} 释放重叠写入范围${expiry}；当前会话不会反向阻塞优先任务。`);
    }
    return denyOutput(formatConflicts(prepared.claim.conflicts ?? [], prepared.claim.decision));
  }
  return denyOutput(formatEditBlockers(prepared.check.blockers, runtime.state.hubSessionId));
}

function formatHookExpiry(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "租约到期";
  const minutes = Math.max(0, Math.ceil((timestamp - Date.now()) / 60_000));
  return minutes <= 1 ? "1 分钟内到期" : `${minutes} 分钟后到期`;
}

async function adoptConcurrentStopFence(
  userDataPath: string,
  runtime: HookRuntime,
): Promise<Record<string, unknown> | undefined> {
  const jobs = await new TurnCompletionQueueStore(userDataPath).listForLifecycle(runtime.state);
  const currentEpoch = runtime.state.activityEpoch ?? 0;
  const candidate = jobs
    .filter((job) => job.activityEpoch >= currentEpoch)
    .at(-1);
  if (!candidate) return undefined;

  if (candidate.activityEpoch === currentEpoch) {
    // Stop 在本次 PreToolUse 持锁期间到达时，由锁持有者接管 fence，防止放行后同 epoch 被晚到 worker 停止。
    runtime.state.pendingCompletion = {
      operationId: candidate.operationId,
      turnId: candidate.turnId,
      activityEpoch: candidate.activityEpoch,
      phase: "awaiting_commit",
      recordedAt: candidate.createdAt,
    };
    runtime.state.currentTurnId = candidate.turnId;
    await runtime.stateStore.save(runtime.state);
  }
  return denyOutput("Agent Hub 已收到并发的回合结束信号，本次写入已暂停；请在完成状态确认后重试。");
}

interface FeatureMemoryCardResponse {
  featureId: string;
  featureKey: string;
  revisionId: string;
  revisionNumber: number;
  name?: string;
  systemId?: string;
  status?: string;
  coreContract?: string;
  paths?: string[];
  symbols?: string[];
  verificationStatus?: string;
}

interface FeatureQueryResponse {
  cards: FeatureMemoryCardResponse[];
  details?: Array<{ id: string; sourceSessionId: string; status: string }>;
  nextCursor?: string | null;
}

interface AutomaticFeatureVerification {
  testKey: string;
  result: "passed" | "failed" | "pending";
  summary: string;
  command?: string;
  evidence?: string;
}

interface SessionFinalizationContext {
  hubSessionId: string;
  baseCommit: string;
  leases: HookLeaseState[];
}

async function handlePostToolUse(
  options: RunCodexHookOptions,
  input: CodexHookInput,
  record: ResolvedRoomConnectionRecord,
  policy: AuthoritativeHookProtectionPolicy,
): Promise<Record<string, unknown> | undefined> {
  const intent = extractAttributedWriteIntent(input.tool_name, input.tool_input);
  if (!intent.writes) return undefined;
  const stateStore = new CodexHookStateStore(options.userDataPath);
  // PostToolUse 会更新与 PreToolUse 相同的 pending、围栏和租约；整段串行化避免旧快照覆盖较新的写入阻塞状态。
  return stateStore.runExclusive(input.session_id, () =>
    handlePostToolUseExclusive(options, input, record, intent, policy));
}

async function handlePostToolUseExclusive(
  options: RunCodexHookOptions,
  input: CodexHookInput,
  record: ResolvedRoomConnectionRecord,
  intent: AttributedWriteIntent,
  policy: AuthoritativeHookProtectionPolicy,
): Promise<Record<string, unknown> | undefined> {
  const runtime = await findHookRuntime(options, input, record);
  if (!runtime) return undefined;
  const modeTransition = applyHookProtectionMode(
    runtime.state,
    policy.blockingProtectionEnabled,
  );
  if (modeTransition.changed) await runtime.stateStore.save(runtime.state);
  const monitorMode = !policy.blockingProtectionEnabled;
  const monitorWarnings = [...modeTransition.warnings];
  const pending = runtime.state.pendingWrite;
  const baseline = pending
    ? {
        changedPaths: pending.baselineChangedPaths,
        changedPathFingerprints: pending.baselineChangedFingerprints,
      }
    : {
        changedPaths: runtime.state.observedChangedPaths,
        changedPathFingerprints: runtime.state.observedChangedFingerprints,
      };
  const repositoryTargets = pending?.proposedEdits.map((edit) => edit.path) ?? normalizeCandidates(
    runtime.git.repositoryRoot,
    mapRepositoryCwd(runtime.connection.repositoryPath, runtime.git.repositoryRoot, input.cwd),
    intent.pathCandidates,
  );
  const targetedInspection = !(pending?.attributedSideEffects ?? intent.attributedSideEffects)
    && repositoryTargets.length > 0;
  runtime.git = targetedInspection
    ? await inspectGitWorkingPathsFromIdentity(runtime.git, repositoryTargets, {
        gitExecutable: options.gitExecutable,
      })
    : await inspectGitWorkingStateFromIdentity(runtime.git, {
        gitExecutable: options.gitExecutable,
      });
  const changes = attributedChangedPaths(
    baseline,
    runtime.git,
    repositoryTargets,
    pending?.attributedSideEffects ?? intent.attributedSideEffects,
  );
  const newlyObserved = changes.attributed;
  if (changes.external.length > 0) {
    runtime.state.externalChangeDiagnostics = [
      ...(runtime.state.externalChangeDiagnostics ?? []),
      { paths: changes.external, detectedAt: new Date().toISOString() },
    ].slice(-20);
  }
  const accumulatedAttributedPaths = unique([
    ...(runtime.state.attributedChangedPaths ?? []),
    ...newlyObserved,
  ]);
  runtime.state.attributedPathsTruncated = runtime.state.attributedPathsTruncated === true
    || accumulatedAttributedPaths.length > MAX_SESSION_FEATURE_PATHS;
  runtime.state.attributedChangedPaths = accumulatedAttributedPaths.slice(0, MAX_SESSION_FEATURE_PATHS);
  const initialChangedPathKeys = new Set(runtime.state.initialChangedPaths.map(pathKey));
  const pathEvidence = (await collectAttributedPathEvidence(
    runtime.git.repositoryRoot,
    runtime.state.baseCommit,
    newlyObserved,
    { gitExecutable: options.gitExecutable },
  )).map((evidence) => initialChangedPathKeys.has(pathKey(evidence.path))
    // 会话开始时已经脏的路径，其真实任务基线不是 baseCommit；保守标记未知，避免误释放 lease。
    ? { ...evidence, baseEntry: null }
    : evidence);
  runtime.state.attributedPathEvidence = mergeAttributedPathEvidence(
    runtime.state.attributedPathEvidence ?? [],
    pathEvidence,
  );
  if (targetedInspection) mergeTargetedObservation(runtime.state, repositoryTargets, runtime.git);
  else {
    runtime.state.observedChangedPaths = [...runtime.git.changedPaths];
    runtime.state.observedChangedFingerprints = { ...runtime.git.changedPathFingerprints };
  }
  runtime.state.pendingWrite = undefined;
  await runtime.stateStore.save(runtime.state);
  if (!monitorMode) {
    const writeBlockReason = await resynchronizeWriteBlockFence(
      runtime,
      newlyObserved.length > 0 ? newlyObserved : repositoryTargets,
    );
    if (writeBlockReason) return postToolUseStopOutput(writeBlockReason);
  }
  if (newlyObserved.length === 0) {
    const context = monitorContext(undefined, monitorWarnings);
    return context ? contextOutput(context) : undefined;
  }

  const proposedEdits = (pending?.proposedEdits ?? []).filter((edit) =>
    newlyObserved.some((candidate) => pathScopeCovers(edit.path, candidate) || pathScopeCovers(candidate, edit.path)),
  );
  if (newlyObserved.length > MAX_SESSION_FEATURE_PATHS || proposedEdits.length > MAX_SESSION_FEATURE_PATHS) {
    const reason = `Agent Hub 检测到单次工具调用实际影响超过 ${MAX_SESSION_FEATURE_PATHS} 个路径，无法保证所有路径都已完成写入前保护检查。请停止继续修改并人工检查当前 Git 差异。`;
    await uploadLightweightScan(runtime, "PostToolUseOverflow", newlyObserved);
    await runtime.client.post("/api/records", {
      kind: "risk",
      title: "Agent 单次写入范围超过保护上限",
      summary: reason,
      paths: newlyObserved.slice(0, MAX_SESSION_FEATURE_PATHS),
      status: "open",
      evidence: [`Codex session ${input.session_id}`, `Tool ${input.tool_name ?? "unknown"}`],
    }).catch(() => undefined);
    if (monitorMode) {
      return contextOutput(monitorContext(reason, monitorWarnings) ?? reason);
    }
    return postToolUseStopOutput(reason);
  }
  const prepared = await runtime.client.post<PrepareEditsResponse>("/api/edits/prepare", {
    sessionId: runtime.state.hubSessionId,
    title: `Codex 归因范围 ${shortSessionId(input.session_id)}`,
    intent: `由 ${input.tool_name ?? "写入工具"} 产生的已识别增量`,
    branch: runtime.git.branch,
    baseCommit: runtime.state.baseCommit,
    turnId: runtime.state.currentTurnId,
    activityEpoch: runtime.state.activityEpoch ?? 0,
    paths: newlyObserved,
    proposedEdits,
  });
  const check = prepared.check;
  updateRenewedLeases(runtime.state, prepared.renewedLeases ?? []);
  if (prepared.claim?.acquired && prepared.claim.lease) {
    upsertLease(runtime.state, {
      id: prepared.claim.lease.id,
      paths: prepared.claim.lease.paths?.length ? prepared.claim.lease.paths : newlyObserved,
      expiresAt: prepared.claim.lease.expiresAt,
    });
    await runtime.stateStore.save(runtime.state);
  }
  await uploadLightweightScan(runtime, "PostToolUse", newlyObserved);
  if (check.allowed) {
    const warnings = formatWarnings(check.warnings);
    return contextOutput(
      monitorContext(
        `Agent Hub 已登记本次 Agent 实际变更：${newlyObserved.join("、")}。`
        + (warnings ? `\n${warnings}` : ""),
        monitorWarnings,
      ) ?? `Agent Hub 已登记本次 Agent 实际变更：${newlyObserved.join("、")}。`,
    );
  }

  const reason = formatEditBlockers(check.blockers, runtime.state.hubSessionId);
  await runtime.client.post("/api/records", {
    kind: "risk",
    title: "Agent 写入后的保护检查未通过",
    summary: reason,
    paths: newlyObserved,
    status: "open",
    evidence: [`Codex session ${input.session_id}`, `Tool ${input.tool_name ?? "unknown"}`],
  });
  const verifiedManualExclusive = isVerifiedManualExclusiveClaim(prepared.claim)
    || hasVerifiedManualExclusiveBlocker(prepared.check);
  if (monitorMode && !verifiedManualExclusive) {
    return postToolUseStopOutput(monitorContext(reason, monitorWarnings) ?? reason);
  }
  const blocked = postToolUseStopOutput(reason);
  return verifiedManualExclusive
    ? markVerifiedManualExclusiveBlock(blocked)
    : blocked;
}

async function ensurePendingFinalizationsStarted(
  options: RunCodexHookOptions,
  resolved: ResolvedRoomConnection,
  jobs: SessionEndQueueJob[],
): Promise<void> {
  if (jobs.length === 0) return;
  const client = new AgentHubClient({
    serverUrl: resolved.connection.serverUrl,
    memberToken: resolved.memberToken,
    fetchImpl: createHookGatedFetch(options, resolved.connection.id),
  });
  for (const job of jobs) {
    try {
      await client.post(`/api/sessions/${encodeURIComponent(job.hubSessionId)}/finalize/start`, {
        finalizationId: job.finalizationId,
        summary: `Codex session ${job.codexSessionId} ended; a new lifecycle generation is opening.`,
      });
    } catch (error) {
      if (
        error instanceof AgentHubHttpError
        && (
          error.code === "session_not_found"
          || error.code === "session_already_closed"
          || error.code === "finalization_conflict"
        )
      ) continue;
      throw error;
    }
  }
}

async function handleStop(
  options: RunCodexHookOptions,
  input: CodexHookInput,
): Promise<void> {
  const stateStore = new CodexHookStateStore(options.userDataPath);
  // marker 前只读取 connectionId；暂停若抢先完成清理，marker 内重读会看到 state 已不存在并直接退出。
  const initialState = await stateStore.load(input.session_id);
  if (!initialState) return;
  const queue = new TurnCompletionQueueStore(options.userDataPath);
  await new IntegrationOperationTracker(options.userDataPath).run(initialState.connectionId, async () => {
    const snapshot = await stateStore.load(input.session_id);
    if (
      !snapshot
      || snapshot.connectionId !== initialState.connectionId
      || snapshot.hubSessionId !== initialState.hubSessionId
    ) return;
    if (snapshot.pendingCompletion?.phase === "stopped") return;

    const knownRecord = await resolveOptionalConnectionRecordById(
      options.userDataPath,
      snapshot.connectionId,
      options.protector,
    );
    if (knownRecord) {
      const integration = await getLocalIntegrationStatus(
        options.userDataPath,
        knownRecord.connection,
        options.runtimePresencePath,
      );
      if (!integration.active || !integration.remoteAllowed) return;
    }

    // 先写保守 fence job：即使 PreToolUse 长时间持锁，Stop 也能在宿主预算内留下不可误释放的本地证据。
    const fenced = await ensureStopCompletionJob(queue, snapshot, input, true);
    let job: TurnCompletionJob | undefined = fenced.job;
    let connectionId: string | undefined;
    try {
      await stateStore.runExclusive(input.session_id, async () => {
        const state = await stateStore.load(input.session_id);
        if (
          !state
          || state.connectionId !== initialState.connectionId
          || state.hubSessionId !== initialState.hubSessionId
        ) {
          if (fenced.created) await queue.remove(fenced.job.operationId);
          job = undefined;
          return;
        }
        if (state.pendingCompletion?.phase === "stopped") {
          if (fenced.created) await queue.remove(fenced.job.operationId);
          job = undefined;
          return;
        }

        const authoritativeTurnId = state.pendingCompletion?.turnId ?? state.currentTurnId;
        const explicitStopTurnId = input.turn_id?.trim();
        const activityAdvanced = (state.activityEpoch ?? 0) > (snapshot.activityEpoch ?? 0);
        if (
          (explicitStopTurnId
            && authoritativeTurnId
            && explicitStopTurnId !== authoritativeTurnId
            && state.pendingWrite !== undefined)
          || (activityAdvanced && state.pendingCompletion?.phase !== "resuming")
        ) {
          // 新 turn 已经越过本次 Stop 的 fence；旧 Stop 只能丢弃，不能把新 epoch 写回 awaiting。
          if (fenced.created) await queue.remove(fenced.job.operationId);
          job = undefined;
          return;
        }

        const current = await ensureStopCompletionJob(queue, state, input, false);
        if (fenced.created && fenced.job.operationId !== current.job.operationId) {
          await queue.remove(fenced.job.operationId);
        }
        job = current.job;

        const currentRecord = await resolveOptionalConnectionRecordById(
          options.userDataPath,
          state.connectionId,
          options.protector,
        );
        if (currentRecord) {
          const integration = await getLocalIntegrationStatus(
            options.userDataPath,
            currentRecord.connection,
            options.runtimePresencePath,
          );
          // marker 已登记的 job 留给 pause/shutdown 在 drain 后统一判断；这里只禁止新的 state 回写。
          if (!integration.active || !integration.remoteAllowed) return;
        }

        state.pendingCompletion = {
          operationId: job.operationId,
          turnId: job.turnId,
          activityEpoch: job.activityEpoch,
          phase: "awaiting_commit",
          recordedAt: job.createdAt,
        };
        state.currentTurnId = job.turnId;
        await stateStore.save(state);
        connectionId = state.connectionId;
      }, { timeoutMs: STOP_STATE_LOCK_TIMEOUT_MS });
    } catch (error) {
      if (!(error instanceof CodexHookStateLockTimeoutError)) throw error;
      // fence job 已经包含 truncated 标记；锁持有者结束前不得再以陈旧 state 写入。
      return;
    }

    if (!job || !connectionId) return;
    try {
      // 持久化后再次读取 gate；marker 会让 pause/shutdown 等到这里退出后再决定清理或保留任务。
      await assertHookIntegrationActive(options, connectionId);
      const record = await resolveConnectionRecordById(
        options.userDataPath,
        connectionId,
        options.protector,
      );
      if (!record) return;
      const resolved = await hydrateConnectionRecord(record);
      const client = new AgentHubClient({
        serverUrl: resolved.connection.serverUrl,
        memberToken: resolved.memberToken,
        fetchImpl: createHookGatedFetch(options, connectionId),
        timeoutMs: 500,
      });
      await queue.runExclusive(job.operationId, async () => {
        const pending = await processTurnCompletionJob(job!, {
          userDataPath: options.userDataPath,
          client,
          gitExecutable: options.gitExecutable,
          gitTimeoutMs: 350,
        });
        if (pending) {
          const latest = await stateStore.load(job!.codexSessionId);
          // 只有同一 Hub generation 已经推进到更高 epoch 时，旧 Stop 才真正失效。
          // SessionEnd 删除旧 state 或立即复开新 generation 时，旧租约仍需要自己的 job 继续检查提交，不能只等 TTL。
          if (
            latest
            && matchesTurnCompletionJob(job!, latest)
            && (latest.activityEpoch ?? 0) > job!.activityEpoch
          ) await queue.remove(job!.operationId);
          else await queue.recordRetry(job!, pending.error);
        } else await queue.remove(job!.operationId);
      });
    } catch {
      // 15 秒后台 worker 继续使用同一 operationId 重试；Stop 始终允许 Codex 结束本回合。
    }
  });
}

async function ensureStopCompletionJob(
  queue: TurnCompletionQueueStore,
  state: CodexHookSessionState,
  input: CodexHookInput,
  conservative: boolean,
): Promise<{ job: TurnCompletionJob; created: boolean }> {
  const activityEpoch = state.pendingCompletion?.activityEpoch ?? state.activityEpoch ?? 0;
  const turnId = state.pendingCompletion?.turnId ?? completionTurnId(input, activityEpoch);
  const existingJobs = await queue.listForLifecycle(state);
  const existing = state.pendingCompletion?.phase === "awaiting_commit"
    ? existingJobs.find((candidate) =>
        candidate.activityEpoch === activityEpoch
        && candidate.operationId === state.pendingCompletion?.operationId)
    : existingJobs.find((candidate) =>
        candidate.activityEpoch === activityEpoch
        && candidate.turnId === turnId
        && candidate.operationId !== state.pendingCompletion?.operationId);
  if (existing && conservative) return { job: existing, created: false };

  // resuming 的 operationId 属于恢复请求，Stop 必须使用新的幂等键表达同一 epoch 的完成检查。
  const operationId = existing?.operationId
    ?? (state.pendingCompletion?.phase === "awaiting_commit"
      ? state.pendingCompletion.operationId
      : randomUUID());
  const queuedState = conservative
    ? { ...state, attributedPathsTruncated: true }
    : state;
  return {
    job: await queue.enqueue({ operationId, turnId, activityEpoch, state: queuedState }),
    created: !existing,
  };
}

async function resolveOptionalConnectionRecordById(
  userDataPath: string,
  connectionId: string,
  protector?: SecretProtector,
): Promise<ResolvedRoomConnectionRecord | undefined> {
  const store = await openConnectionStore(userDataPath, protector);
  const connection = await store.get(connectionId);
  return connection ? { connection, store } : undefined;
}

async function handleSessionEnd(
  options: RunCodexHookOptions,
  input: CodexHookInput,
): Promise<void> {
  const stateStore = new CodexHookStateStore(options.userDataPath);
  const snapshot = await stateStore.load(input.session_id);
  if (!snapshot) return;
  // 队列文件同时充当 durable SessionEnd tombstone。确定性 ID 保证并发或重试的 SessionEnd 指向同一任务。
  const state = snapshot.finalizationId
    ? snapshot
    : { ...snapshot, finalizationId: sessionFinalizationId(snapshot) };
  const job = await new SessionEndQueueStore(options.userDataPath).enqueue(state, input.reason);
  try {
    await stateStore.runExclusive(input.session_id, async () => {
      const current = await stateStore.load(input.session_id);
      if (!current || !matchesSessionEndJob(job, current)) return;
      await new SessionEndQueueStore(options.userDataPath).mergeState(
        job.finalizationId,
        current,
        input.reason,
      );
      await stateStore.remove(input.session_id);
    }, { timeoutMs: STOP_STATE_LOCK_TIMEOUT_MS });
  } catch (error) {
    if (!(error instanceof CodexHookStateLockTimeoutError)) throw error;
    // 在途 heartbeat 会在写回前看到队列 tombstone 并完成删除；这里不能突破宿主的 3 秒预算继续等待。
  }
}

function sessionFinalizationId(state: CodexHookSessionState): string {
  return `codex_${createHash("sha256")
    .update(`${state.connectionId}\0${state.hubSessionId}\0${state.codexSessionId}`)
    .digest("hex")}`;
}

export interface FinalizeQueuedSessionOptions {
  client: AgentHubClient;
  gitExecutable?: string;
}

export class SessionEndLocalEvidenceError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "SessionEndLocalEvidenceError";
  }
}

export async function finalizeQueuedSession(
  job: SessionEndQueueJob,
  options: FinalizeQueuedSessionOptions,
): Promise<void> {
  const { client } = options;
  await client.post(`/api/sessions/${encodeURIComponent(job.hubSessionId)}/finalize/start`, {
    finalizationId: job.finalizationId,
    summary: `Codex session ${job.codexSessionId} ended; background finalization started.`,
  });
  let git: Awaited<ReturnType<typeof inspectGitWorkingState>>;
  try {
    git = await inspectGitWorkingState(job.repositoryPath, {
      gitExecutable: options.gitExecutable,
    });
  } catch (error) {
    // 只有明确发生在本地 Git 取证阶段的错误才能消耗证据降级预算。
    throw new SessionEndLocalEvidenceError(`Local Git inspection failed: ${humanError(error)}`, error);
  }
  const actualPaths = unique(job.attributedPaths);
  const sessionContext = {
    hubSessionId: job.hubSessionId,
    baseCommit: job.baseCommit,
    leases: job.leases,
  };

  let featureMemorySummary = "未发现可归因给本次 Agent 的代码变化。";
  let evidenceError: string | undefined;
  let featureEvidence: FeatureGitEvidence | undefined;
  let featureVerifications: AutomaticFeatureVerification[] = [];
  if (job.attributedPathsTruncated) {
    featureMemorySummary = `本次 Agent 会话涉及超过 ${MAX_SESSION_FEATURE_PATHS} 个归因路径，自动功能记忆未生成，以免用不完整证据覆盖稳定版本。`;
    evidenceError = featureMemorySummary;
  } else if (actualPaths.length > 0) {
    try {
      featureEvidence = await collectFeatureGitEvidence(git.repositoryRoot, job.baseCommit, {
        gitExecutable: options.gitExecutable,
        includePaths: actualPaths,
      });
    } catch (error) {
      // 先完整收口本地子进程，再请求 snapshot；远端失败不能留下仍在访问仓库的失联 Git 任务。
      throw new SessionEndLocalEvidenceError(`Local feature evidence failed: ${humanError(error)}`, error);
    }
    featureVerifications = await collectSessionFeatureVerifications(client, sessionContext);
  }

  await client.post(`/api/sessions/${encodeURIComponent(job.hubSessionId)}/scan`, {
    repository: git.repositoryRoot,
    branch: git.branch,
    worktree: git.repositoryRoot,
    baseCommit: job.baseCommit,
    changedPaths: featureEvidence?.changedPaths ?? actualPaths,
    ruleFiles: [],
    systems: featureEvidence?.inferredSystems ?? [],
    metadata: {
      source: "codex-hook",
      event: "SessionEnd",
      finalizationId: job.finalizationId,
      attributedPathCount: actualPaths.length,
      attributedPathsTruncated: job.attributedPathsTruncated,
      featureEvidence: featureEvidence ? featureEvidenceAttestation(featureEvidence) : undefined,
      externalChangeCount: job.externalChangeCount,
    },
    finalizationId: job.finalizationId,
  });

  if (featureEvidence) {
    featureMemorySummary = await submitAutomaticFeatureDraft(
      client,
      sessionContext,
      featureEvidence,
      featureVerifications,
      job.finalizationId,
    );
  }

  await client.post(`/api/sessions/${encodeURIComponent(job.hubSessionId)}/finalize/complete`, {
    finalizationId: job.finalizationId,
    summary: `Codex session ended with ${actualPaths.length} attributed path(s). ${featureMemorySummary}`,
    evidenceError,
  });
}

async function findHookRuntime(
  options: RunCodexHookOptions,
  input: CodexHookInput,
  record: ResolvedRoomConnectionRecord,
): Promise<HookRuntime | undefined> {
  const stateStore = new CodexHookStateStore(options.userDataPath);
  const state = await stateStore.load(input.session_id);
  if (state && state.connectionId !== record.connection.id) return undefined;
  if (!(await getLocalIntegrationStatus(
    options.userDataPath,
    record.connection,
    options.runtimePresencePath,
  )).active) return undefined;
  const resolved = await hydrateConnectionRecord(record);
  if (!state) return openHookRuntime(options, input, resolved, false, state);
  const identity = await inspectGitIdentity(resolved.connection.repositoryPath, {
    gitExecutable: options.gitExecutable,
  });
  return {
    input,
    connection: resolved.connection,
    client: new AgentHubClient({
      serverUrl: resolved.connection.serverUrl,
      memberToken: resolved.memberToken,
      fetchImpl: createHookGatedFetch(options, resolved.connection.id),
    }),
    git: {
      ...identity,
      changedPaths: [...state.observedChangedPaths],
      changedPathFingerprints: { ...state.observedChangedFingerprints },
    },
    state,
    stateStore,
  };
}

async function hydrateConnectionRecord(record: ResolvedRoomConnectionRecord): Promise<ResolvedRoomConnection> {
  return {
    ...record,
    memberToken: await record.store.readMemberToken(record.connection.id),
  };
}

async function openHookRuntime(
  options: RunCodexHookOptions,
  input: CodexHookInput,
  resolved: ResolvedRoomConnection,
  refreshInitial: boolean,
  existingState?: CodexHookSessionState,
): Promise<HookRuntime> {
  const stateStore = new CodexHookStateStore(options.userDataPath);
  const git = await inspectGitWorkingState(resolved.connection.repositoryPath, {
    gitExecutable: options.gitExecutable,
  });
  const client = new AgentHubClient({
    serverUrl: resolved.connection.serverUrl,
    memberToken: resolved.memberToken,
    fetchImpl: createHookGatedFetch(options, resolved.connection.id),
  });
  let state = existingState ?? (await stateStore.load(input.session_id));
  if (!state || refreshInitial) {
    let activityEpoch = state?.activityEpoch ?? 0;
    const opened = await client.post<OpenHookSessionResponse>("/api/sessions", {
      clientName: "Agent Hub Codex hook",
      agentName: "Codex",
      clientVersion: AGENT_HUB_VERSION,
      protocolVersion: AGENT_HUB_PROTOCOL_VERSION,
      schemaVersion: AGENT_HUB_SCHEMA_VERSION,
      repository: git.repositoryRoot,
      branch: git.branch,
      worktree: git.repositoryRoot,
      baseCommit: git.headCommit,
      task: `Codex session ${input.session_id}`,
      codexSessionId: input.session_id,
      turnId: completionTurnId(input, activityEpoch),
      activityEpoch,
      metadata: {
        source: "codex-hook",
        codexSessionId: input.session_id,
        startSource: input.source,
      },
    });
    const openedSessionId = requireActiveHookSessionId(opened.session);
    activityEpoch = Math.max(activityEpoch, opened.session.activityEpoch ?? 0);
    const currentTurnId = opened.session.currentTurnId
      ?? completionTurnId(input, activityEpoch);
    const now = new Date().toISOString();
    state = {
      version: 1,
      codexSessionId: input.session_id,
      connectionId: resolved.connection.id,
      hubSessionId: openedSessionId,
      finalizationId: randomUUID(),
      repositoryPath: git.repositoryRoot,
      branch: git.branch,
      baseCommit: git.headCommit,
      initialChangedPaths: git.changedPaths,
      initialChangedFingerprints: { ...git.changedPathFingerprints },
      observedChangedPaths: git.changedPaths,
      observedChangedFingerprints: { ...git.changedPathFingerprints },
      activityEpoch,
      currentTurnId,
      pendingCompletion: opened.session.turnStoppedAt ? {
        operationId: randomUUID(),
        turnId: currentTurnId,
        activityEpoch,
        phase: "stopped",
        recordedAt: opened.session.turnStoppedAt,
      } : undefined,
      leases: [],
      // 没有本地 state 却复用了远端 session 时，旧租约与旧归因路径都不能凭空重建。
      leaseAttributionComplete: opened.session.reused === false,
      openedAt: now,
      updatedAt: now,
    };
    await stateStore.save(state);
  }
  const runtime = {
    input,
    connection: resolved.connection,
    client,
    git,
    state,
    stateStore,
  };
  await uploadLightweightScan(runtime, refreshInitial ? "SessionStart" : "AutoOpen");
  return runtime;
}

async function adoptHookSessionGeneration(
  runtime: HookRuntime,
  opened: OpenHookSessionResponse["session"],
  requestedTurnId: string,
  requestedActivityEpoch: number,
  options: Pick<RunCodexHookOptions, "gitExecutable">,
): Promise<void> {
  const sessionId = requireActiveHookSessionId(opened);
  const responseEpoch = Number.isSafeInteger(opened.activityEpoch)
    ? Number(opened.activityEpoch)
    : requestedActivityEpoch;
  const activityEpoch = Math.max(requestedActivityEpoch, responseEpoch);
  const currentTurnId = opened.currentTurnId?.trim() || requestedTurnId;

  if (sessionId === runtime.state.hubSessionId) {
    runtime.state.activityEpoch = activityEpoch;
    runtime.state.currentTurnId = currentTurnId;
    try {
      await runtime.stateStore.save(runtime.state);
    } catch (error) {
      throw new HookGenerationAdoptionError("无法持久化当前会话活动状态。", { cause: error });
    }
    return;
  }

  try {
    // 新 generation 必须从当前 Git 状态重新起算，旧租约和归因证据不能跨会话代际继承。
    const git = await inspectGitWorkingState(runtime.connection.repositoryPath, {
      gitExecutable: options.gitExecutable,
    });
    const now = new Date().toISOString();
    runtime.git = git;
    runtime.state = {
      version: 1,
      codexSessionId: runtime.state.codexSessionId,
      connectionId: runtime.state.connectionId,
      hubSessionId: sessionId,
      finalizationId: randomUUID(),
      repositoryPath: git.repositoryRoot,
      branch: git.branch,
      baseCommit: git.headCommit,
      initialChangedPaths: [...git.changedPaths],
      initialChangedFingerprints: { ...git.changedPathFingerprints },
      observedChangedPaths: [...git.changedPaths],
      observedChangedFingerprints: { ...git.changedPathFingerprints },
      attributedChangedPaths: [],
      attributedPathsTruncated: false,
      attributedPathEvidence: [],
      activityEpoch,
      currentTurnId,
      pendingCompletion: opened.turnStoppedAt ? {
        operationId: randomUUID(),
        turnId: currentTurnId,
        activityEpoch,
        phase: "stopped",
        recordedAt: opened.turnStoppedAt,
      } : undefined,
      leases: [],
      leaseAttributionComplete: opened.reused === false,
      openedAt: now,
      updatedAt: now,
    };
    await runtime.stateStore.save(runtime.state);
  } catch (error) {
    if (error instanceof HookGenerationAdoptionError) throw error;
    throw new HookGenerationAdoptionError(
      "无法重新建立 Git 基线并持久化新会话代际。",
      { cause: error },
    );
  }
}

async function registerAndAdoptHookGeneration(
  runtime: HookRuntime,
  input: CodexHookInput,
  turnId: string,
  activityEpoch: number,
  event: "UserPromptSubmit" | "stale_activity_epoch_recovery",
  options: Pick<RunCodexHookOptions, "gitExecutable">,
): Promise<void> {
  const response = await runtime.client.post<OpenHookSessionResponse>("/api/sessions", {
    clientVersion: AGENT_HUB_VERSION,
    protocolVersion: AGENT_HUB_PROTOCOL_VERSION,
    schemaVersion: AGENT_HUB_SCHEMA_VERSION,
    codexSessionId: input.session_id,
    turnId,
    activityEpoch,
    branch: runtime.git.branch,
    baseCommit: runtime.git.headCommit,
    repository: runtime.git.repositoryRoot,
    worktree: runtime.git.repositoryRoot,
    metadata: { source: "codex-hook", event },
  });
  await adoptHookSessionGeneration(runtime, response.session, turnId, activityEpoch, options);
}

function requireActiveHookSessionId(opened: OpenHookSessionResponse["session"]): string {
  const sessionId = typeof opened.id === "string" ? opened.id.trim() : "";
  if (!sessionId) {
    throw new HookGenerationAdoptionError("房间服务没有返回有效的 session.id。");
  }
  if (opened.status !== "active") {
    throw new HookGenerationAdoptionError(
      `房间服务返回的会话状态为 ${opened.status || "unknown"}，不是 active。`,
    );
  }
  return sessionId;
}

async function uploadLightweightScan(
  runtime: HookRuntime,
  event: string,
  attributedPaths: string[] = runtime.state.attributedChangedPaths ?? [],
): Promise<void> {
  await runtime.client.post(
    `/api/sessions/${encodeURIComponent(runtime.state.hubSessionId)}/scan`,
    {
      repository: runtime.git.repositoryRoot,
      branch: runtime.git.branch,
      worktree: runtime.git.repositoryRoot,
      baseCommit: runtime.git.headCommit,
      changedPaths: unique(attributedPaths).slice(0, 100),
      ruleFiles: [],
      systems: [],
      metadata: { source: "codex-hook", event },
    },
  );
}

async function renewExpiringLeases(runtime: HookRuntime): Promise<void> {
  const renewalThreshold = Date.now() + 10 * 60_000;
  const renewed: HookLeaseState[] = [];
  for (const lease of runtime.state.leases) {
    if (Date.parse(lease.expiresAt) > renewalThreshold) {
      renewed.push(lease);
      continue;
    }
    try {
      const response = await runtime.client.post<{ lease: { id: string; paths?: string[]; expiresAt: string } }>(
        `/api/leases/${encodeURIComponent(lease.id)}/renew`,
        { sessionId: runtime.state.hubSessionId, ttlMinutes: LEASE_TTL_MINUTES },
      );
      renewed.push({
        id: response.lease.id,
        paths: response.lease.paths?.length ? response.lease.paths : lease.paths,
        expiresAt: response.lease.expiresAt,
      });
    } catch (error) {
      // 404/409 means the server no longer considers this lease renewable.
      // Drop the stale local reference so the next edit check can claim the path again.
      if (!(error instanceof AgentHubHttpError) || (error.status !== 404 && error.status !== 409)) throw error;
    }
  }
  runtime.state.leases = renewed;
  await runtime.stateStore.save(runtime.state);
}

export function shouldDiscardLeaseRenewal(error: unknown): boolean {
  return error instanceof AgentHubHttpError && (error.status === 404 || error.status === 409);
}

export function extractWriteIntent(
  toolName: string | undefined,
  toolInput: unknown,
): { writes: boolean; pathCandidates: string[] } {
  const intent = extractAttributedWriteIntent(toolName, toolInput);
  return { writes: intent.writes, pathCandidates: intent.pathCandidates };
}

async function submitAutomaticFeatureDraft(
  client: AgentHubClient,
  state: SessionFinalizationContext,
  evidence: FeatureGitEvidence,
  verifications: AutomaticFeatureVerification[],
  finalizationId?: string,
): Promise<string> {
  if (evidence.changedPaths.length === 0) return "归因路径没有留下可记录的 Git 差异。";

  const systemId = evidence.inferredSystems[0] ?? inferSystemId(evidence.changedPaths[0] ?? "project");
  const primarySymbol = evidence.symbols[0] ?? path.parse(evidence.changedPaths[0] ?? "feature").name;
  const featureKey = `auto:${slugKey(systemId)}:${slugKey(primarySymbol)}`.slice(0, 240);
  const name = evidence.commits[0]?.subject.trim()
    || `${humanizeIdentifier(systemId)} / ${humanizeIdentifier(primarySymbol)}`;
  const query = await client.post<FeatureQueryResponse>("/api/features/query", {
    sessionId: state.hubSessionId,
    finalizationId,
    level: "detail",
    paths: evidence.changedPaths,
    systems: [systemId],
    symbols: evidence.symbols,
    statuses: ["draft", "candidate", "current", "conflict", "superseded", "deprecated"],
    limit: 3,
  });
  const existingSessionRevision = query.details?.find(
    (revision) => revision.sourceSessionId === state.hubSessionId,
  );
  if (existingSessionRevision) {
    return `当前 Agent 已通过 MCP 提交结构化功能修订 ${existingSessionRevision.id}（${existingSessionRevision.status}），Hook 未重复生成兜底草稿。`;
  }
  const parent = query.cards
    .filter((card) => card.featureKey === featureKey)
    .sort((left, right) => right.revisionNumber - left.revisionNumber)[0];
  const contractKey = `${slugKey(systemId)}.${slugKey(primarySymbol)}.behavior`;
  const completed = evidence.committed && evidence.uncommittedPaths.length === 0;
  const remainingRisks = [
    ...(!evidence.committed ? ["本次归因变更尚未形成 Git 提交。"] : []),
    ...(evidence.uncommittedPaths.length > 0
      ? [`仍有 ${evidence.uncommittedPaths.length} 个归因路径未提交。`]
      : []),
    ...(evidence.relatedTests.length === 0 ? ["尚未识别到关联回归测试文件。"] : []),
    ...(verifications.length === 0
      ? ["Hook 尚未找到与本会话租约关联的真实验证记录，不能自动提升为当前有效记忆。"]
      : []),
  ];
  const symbolTargets = evidence.symbolLocations.slice(0, 100).map(({ path: symbolPath, symbol }) => ({
    kind: "symbol" as const,
    role: "contract" as const,
    path: symbolPath,
    symbol,
  }));
  const symbolPaths = new Set(symbolTargets.map((target) => pathKey(target.path)));
  const testTargets = evidence.relatedTests.slice(0, 100).map((testPath) => ({
    kind: "test" as const,
    role: "verification" as const,
    path: testPath,
  }));
  const testPaths = new Set(testTargets.map((target) => pathKey(target.path)));
  const targets = [
    { kind: "system", role: "implementation", label: systemId },
    ...evidence.changedPaths.flatMap((targetPath) => {
      if (testPaths.has(pathKey(targetPath))) return [];
      if (isSourcePath(targetPath) && symbolPaths.has(pathKey(targetPath))) return [];
      return [{
        kind: isResourcePath(targetPath) ? "resource" : "path",
        role: "implementation",
        path: targetPath,
      }];
    }),
    ...symbolTargets,
    ...testTargets,
  ].slice(0, 300);
  await client.post("/api/features/revisions", {
    sessionId: state.hubSessionId,
    finalizationId,
    featureKey,
    name: name.slice(0, 240),
    systemId,
    parentRevisionId: parent?.revisionId,
    relation: parent ? "extend" : "add",
    objective: `保留并可追溯本次 Codex 会话实现的“${name}”行为。`,
    changeSummary: evidence.diffSummary
      ? `${name}\n${evidence.diffSummary}`
      : `${name}：${evidence.changedPaths.join("、")}`,
    contractChanges: [{
      operation: parent ? "update" : "add",
      key: contractKey,
      behavior: `保留“${name}”已经实现的行为；后续修改关联符号、接口、资源或测试时必须先确认影响并重新验证。`,
      constraints: [
        "不得因为后续摘要没有提及，就自动删除既有行为。",
        "修改关联实现前必须通过历史功能影响检查。",
      ],
    }],
    constraints: ["未验证证据不能自动提升为当前有效版本。"],
    dependencies: evidence.dependencies,
    targets,
    finalCommit: evidence.committed ? evidence.finalCommit : undefined,
    completed,
    verifications,
    remainingRisks,
    gitEvidence: evidence,
  });
  return completed
    ? `已生成“${name}”候选功能记忆，等待真实回归验证后生效。`
    : `已生成“${name}”功能记忆草稿，等待提交和验证。`;
}

async function collectSessionFeatureVerifications(
  client: AgentHubClient,
  state: SessionFinalizationContext,
): Promise<AutomaticFeatureVerification[]> {
  const snapshot = await client.get<RoomSnapshotLike>("/api/snapshot");
  const leaseIds = new Set(state.leases.map((lease) => lease.id));
  return (snapshot.verifications ?? []).filter(isRecord).flatMap((verification, index) => {
    const leaseId = textField(verification, "leaseId");
    const result = textField(verification, "result");
    const summary = textField(verification, "summary");
    if (!leaseId || !leaseIds.has(leaseId) || !summary || !["passed", "failed", "pending"].includes(result ?? "")) {
      return [];
    }
    return [{
      testKey: textField(verification, "kind") ?? `verification-${index + 1}`,
      result: result as AutomaticFeatureVerification["result"],
      summary,
      command: textField(verification, "command"),
      evidence: textField(verification, "evidence"),
    }];
  });
}

export function featureEvidenceAttestation(evidence: FeatureGitEvidence): Record<string, unknown> {
  const commitHashes = evidence.commits.map((commit) => commit.hash);
  return {
    version: 2,
    branch: evidence.branch,
    baseCommit: evidence.baseCommit,
    finalCommit: evidence.finalCommit,
    committed: evidence.committed,
    committedPathCount: unique(evidence.committedPaths).length,
    uncommittedPathCount: unique(evidence.uncommittedPaths).length,
    changedPathCount: unique(evidence.changedPaths).length,
    changedPathsSha256: digestStringSet(evidence.changedPaths, pathKey),
    commitHashCount: unique(commitHashes).length,
    commitHashesSha256: digestStringSet(commitHashes, normalizedEvidenceText),
    finalCommitIncluded: commitHashes.some((hash) => normalizedEvidenceText(hash) === normalizedEvidenceText(evidence.finalCommit)),
    diffSha256: evidence.diffSha256,
  };
}

function normalizeProposedEdits(
  repositoryRoot: string,
  cwd: string,
  intent: AttributedWriteIntent,
): HookProposedEditState[] {
  const normalized = new Map<string, HookProposedEditState>();
  for (const target of intent.targets) {
    const repositoryPath = toRepositoryRelativePath(repositoryRoot, cwd, target.pathCandidate);
    if (!repositoryPath) continue;
    const key = pathKey(repositoryPath);
    const operation = target.operation === "generate" ? "unknown" : target.operation;
    const existing = normalized.get(key);
    if (existing) {
      existing.symbols = unique([...existing.symbols, ...target.symbols]).slice(0, 100);
      continue;
    }
    normalized.set(key, {
      path: repositoryPath,
      precision: target.precision,
      symbols: unique(target.symbols).slice(0, 100),
      operation,
    });
  }
  return [...normalized.values()];
}

function setPendingWrite(
  runtime: HookRuntime,
  input: CodexHookInput,
  intent: AttributedWriteIntent,
  proposedEdits: HookProposedEditState[],
): void {
  if (!intent.proposalHash) return;
  runtime.state.pendingWrite = {
    proposalHash: intent.proposalHash,
    toolName: input.tool_name ?? "unknown",
    proposedEdits,
    attributedSideEffects: intent.attributedSideEffects,
    baselineChangedPaths: [...runtime.git.changedPaths],
    baselineChangedFingerprints: { ...runtime.git.changedPathFingerprints },
    recordedAt: new Date().toISOString(),
  };
}

function mergeTargetedObservation(
  state: CodexHookSessionState,
  repositoryTargets: string[],
  targeted: GitWorkingState,
): void {
  const coversTarget = (candidate: string) => repositoryTargets.some((target) =>
    pathScopeCovers(target, candidate) || pathScopeCovers(candidate, target));
  const retainedPaths = state.observedChangedPaths.filter((candidate) => !coversTarget(candidate));
  const retainedFingerprints = { ...state.observedChangedFingerprints };
  for (const candidate of state.observedChangedPaths) {
    if (coversTarget(candidate)) delete retainedFingerprints[pathKey(candidate)];
  }
  state.observedChangedPaths = unique([...retainedPaths, ...targeted.changedPaths]);
  state.observedChangedFingerprints = {
    ...retainedFingerprints,
    ...targeted.changedPathFingerprints,
  };
}

function updateRenewedLeases(
  state: CodexHookSessionState,
  renewedLeases: Array<{ id: string; paths?: string[]; expiresAt: string }>,
): void {
  for (const renewed of renewedLeases) {
    const existing = state.leases.find((lease) => lease.id === renewed.id);
    if (!existing) continue;
    existing.paths = renewed.paths?.length ? unique(renewed.paths) : existing.paths;
    existing.expiresAt = renewed.expiresAt;
  }
}

function synchronizeBlockedLeaseState(
  state: CodexHookSessionState,
  response: WriteBlockedResponse | undefined,
  dirty: boolean,
): void {
  const blockedLeaseIds = new Set(response?.blockedLeaseIds ?? []);
  // 服务端响应丢失时，已有 pendingWrite/脏差异仍要求本地先失败关闭；
  // 显式路径会继续走服务端检查，而未知输出路径不能绕过这个状态。
  if (dirty) {
    state.leases = response === undefined
      ? state.leases.map((lease) => ({ ...lease, coordinationState: "blocked" as const }))
      : state.leases
          .filter((lease) => blockedLeaseIds.has(lease.id))
          .map((lease) => ({ ...lease, coordinationState: "blocked" as const }));
    return;
  }
  // clean 转换成功即证明服务端已取消该会话的全部活动自动租约。重试响应可能因为首次响应丢失而返回空 ID，
  // 因此不能只按 releasedLeaseIds 删除，否则会保留可误放行 pathless 写入的本地旧租约。
  if (response) state.leases = [];
}

async function resynchronizeWriteBlockFence(
  runtime: HookRuntime,
  paths: string[],
): Promise<string | undefined> {
  const pending = runtime.state.writeBlockSyncPending;
  if (pending) {
    let response: WriteBlockedResponse;
    try {
      response = await runtime.client.post<WriteBlockedResponse>(
        `/api/sessions/${encodeURIComponent(runtime.state.hubSessionId)}/write-blocked`,
        {
          dirty: pending.dirty,
          reason: "Retrying an unconfirmed automatic lease transition.",
          paths: pending.paths,
        },
      );
    } catch (error) {
      if (!isSoftIntegrationFailure(error)) throw error;
      return "Agent Hub 尚未确认当前会话等待后的租约状态；"
        + "本次写入保持暂停，请恢复连接后用明确路径重试。";
    }
    synchronizeBlockedLeaseState(runtime.state, response, pending.dirty);
    runtime.state.writeBlockSyncPending = undefined;
    await runtime.stateStore.save(runtime.state);
    if (response.blockedLeaseIds.length > 0) {
      return "Agent Hub 已确认当前会话仍有阻塞的自动租约；在未提交改动清理并等待租约到期前不能继续写入。";
    }
  }
  if (!runtime.state.leases.some((lease) => lease.coordinationState === "blocked")) return undefined;
  let response: WriteBlockedResponse;
  try {
    response = await runtime.client.post<WriteBlockedResponse>(
      `/api/sessions/${encodeURIComponent(runtime.state.hubSessionId)}/write-blocked`,
      {
        dirty: true,
        reason: "Retrying a previously blocked or unconfirmed automatic lease transition.",
        paths,
      },
    );
  } catch (error) {
    if (!isSoftIntegrationFailure(error)) throw error;
    return "Agent Hub 尚未确认当前会话的自动租约已经在房间中停止续租；"
      + "本次写入保持暂停，请恢复连接后用明确路径重试。";
  }
  synchronizeBlockedLeaseState(runtime.state, response, true);
  await runtime.stateStore.save(runtime.state);
  if (response.blockedLeaseIds.length > 0) {
    return "Agent Hub 已确认当前会话仍有阻塞的自动租约；在未提交改动清理并等待租约到期前不能继续写入。";
  }
  return undefined;
}

function clearResolvedPassiveWriteBlock(state: CodexHookSessionState, checkedPaths: string[]): void {
  const block = state.passiveWriteBlock;
  if (!block) return;
  const requestedPaths = block.requestedPaths.length > 0 ? block.requestedPaths : block.paths;
  const recheckedEntireRequest = requestedPaths.every((requestedPath) =>
    checkedPaths.some((checkedPath) => pathScopeCovers(checkedPath, requestedPath)));
  if (recheckedEntireRequest) state.passiveWriteBlock = undefined;
}

function normalizeCandidates(repositoryRoot: string, cwd: string, candidates: string[]): string[] {
  return unique(
    candidates
      .map((candidate) => toRepositoryRelativePath(repositoryRoot, cwd, candidate))
      .filter((candidate): candidate is string => Boolean(candidate)),
  );
}

function mapRepositoryCwd(
  configuredRepositoryPath: string,
  canonicalRepositoryRoot: string,
  cwd: string,
): string {
  const relative = path.relative(path.resolve(configuredRepositoryPath), path.resolve(cwd));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return path.resolve(canonicalRepositoryRoot, relative);
  }
  return cwd;
}

export function formatRoomContext(
  snapshot: RoomSnapshotLike,
  connection: SavedRoomConnection,
  git: GitWorkingState,
  hubSessionId: string,
): string {
  const room = isRecord(snapshot.room) ? snapshot.room : {};
  const settings = isRecord(snapshot.settings) ? snapshot.settings : {};
  const roomName = textField(room, "name") ?? textField(room, "roomName") ?? connection.roomName ?? "当前房间";
  const blockingEnabled = settings.blockingProtectionEnabled !== false;
  const policyVersion = typeof settings.riskPolicyVersion === "number" ? settings.riskPolicyVersion : 1;
  const automaticTtl = typeof settings.automaticLeaseTtlMinutes === "number"
    ? settings.automaticLeaseTtlMinutes
    : LEASE_TTL_MINUTES;
  const header = [
    `Agent Hub 已连接：${roomName}。当前分支 ${git.branch}，提交 ${git.headCommit.slice(0, 12)}。`,
    `当前 Hook 与 MCP 必须共同使用 Agent Hub sessionId=${hubSessionId}；不要再调用 session_open 创建第二个会话。`,
    `当前实时模式：${blockingEnabled ? "保护模式，按服务端 decision 执行警告或阻止" : "纯监测模式，普通风险显示黄色、重点风险显示红色；仅服务端在线明确确认的其他成员手动独占仍可阻止写入"}；策略版本 ${policyVersion}；自动租期 ${automaticTtl} 分钟。`,
    "以下是房间的实时协作状态。Git、项目源码和人工批准的规则仍是最终事实来源。",
  ];
  const candidates: Array<ContextBudgetCandidate<string>> = [];
  addContextCandidates(candidates, "成员", snapshot.members, 45, (item) =>
    `${textField(item, "displayName") ?? textField(item, "name") ?? "成员"} (${textField(item, "role") ?? "member"})`);
  addContextCandidates(candidates, "正在占用", snapshot.activeLeases, 90, (item) => {
    const paths = pathArrayField(item, "paths");
    const pathSummary = paths.length <= 8
      ? paths.join("、")
      : `${paths.slice(0, 8).join("、")}（另有 ${paths.length - 8} 项，按需查询）`;
    return `${textField(item, "memberName") ?? "成员"}: ${textField(item, "title") ?? "工作"} [${pathSummary || "未登记路径"}]`;
  });
  addContextCandidates(candidates, "已确认决定", snapshot.decisions, 65, (item) =>
    contextIndexLine(textField(item, "title") ?? "决定", textField(item, "decision")));
  const risks = (snapshot.records ?? []).filter(
    (item) => isRecord(item) && item.kind === "risk" && item.status !== "resolved",
  );
  addContextCandidates(candidates, "未解决风险", risks, 100, (item) =>
    contextIndexLine(textField(item, "title") ?? "风险", textField(item, "summary")));
  addContextCandidates(candidates, "待处理释放申请", snapshot.releaseRequests, 110, (item) =>
    `${textField(item, "requesterName") ?? "成员"} 请求 ${textField(item, "holderName") ?? "租约持有人"} 交出 ${pathArrayField(item, "paths").join("、") || "冲突范围"}`);
  addContextCandidates(candidates, "最近验证", snapshot.verifications, 60, (item) =>
    contextIndexLine(
      `${textField(item, "kind") ?? "验证"}/${textField(item, "result") ?? "unknown"}`,
      textField(item, "summary"),
    ));
  addContextCandidates(candidates, "长期功能记忆", snapshot.featureMemories, 105, (item) => {
    const name = textField(item, "name") ?? textField(item, "featureKey") ?? "已完成功能";
    const systemId = textField(item, "systemId");
    const behavior = textField(item, "coreContract");
    const paths = pathArrayField(item, "paths");
    const detail = [
      behavior ? `既有行为：${behavior}` : undefined,
      paths.length ? `关键路径：${paths.slice(0, 4).join("、")}${paths.length > 4 ? `（另有 ${paths.length - 4} 项）` : ""}` : undefined,
    ].filter(Boolean).join("；");
    return contextIndexLine(systemId ? `${name} [${systemId}]` : name, detail || undefined);
  });

  const footer = blockingEnabled
    ? "Agent Hub 会在写入前自动领取最小路径并检查冲突，在写入后只登记可归因给当前 Agent 的实际变更。出现拒绝时不要绕过；先读取命中原因，只有业务规则确实冲突时再询问人。"
    : "Agent Hub 当前只监测、提示并登记可归因给当前 Agent 的实际变更；只有服务端在线明确确认的其他成员手动独占范围仍会阻止写入。";
  const truncatedNotice = "还有更多完整协作条目未在启动层加载；请通过 MCP 按路径、系统或目标继续查询。";
  const memoryUnavailableNotice = blockingEnabled
    ? "长期功能记忆索引本次未能加载；实时租约与冲突保护仍然有效，请通过 MCP 按需重试记忆查询。"
    : "长期功能记忆索引本次未能加载；实时租约监测仍会继续，但本次上下文可能缺少历史功能提示。";
  const baseTokens = estimateContextTokens([...header, truncatedNotice, footer].join("\n"));
  const packed = packContextByBudget(candidates, {
    budgetTokens: 2_500,
    baseTokens,
    serialize: (value) => value,
  });
  return [
    ...header,
    ...packed.items,
    ...(packed.truncated || snapshot.featureMemoryIndexHasMore ? [truncatedNotice] : []),
    ...(snapshot.featureMemoryIndexUnavailable ? [memoryUnavailableNotice] : []),
    footer,
  ].join("\n");
}

function addContextCandidates(
  target: Array<ContextBudgetCandidate<string>>,
  title: string,
  values: unknown[] | undefined,
  priority: number,
  render: (value: Record<string, unknown>) => string,
): void {
  (values ?? []).filter(isRecord).forEach((value, index) => {
    const rendered = render(value);
    if (!rendered) return;
    const line = `${title}：${rendered}`;
    target.push({
      id: `${title}:${textField(value, "id") ?? index}`,
      priority,
      value: line,
      text: line,
    });
  });
}

function contextIndexLine(title: string, detail: string | undefined): string {
  if (!detail) return title;
  const rendered = `${title}: ${detail}`;
  return estimateContextTokens(rendered) <= 320
    ? rendered
    : `${title}（正文较长，使用 MCP 按需读取完整条目）`;
}

function pathArrayField(value: Record<string, unknown>, key: string): string[] {
  const raw = value[key];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim()];
    if (isRecord(item)) {
      const itemPath = textField(item, "path");
      return itemPath ? [itemPath] : [];
    }
    return [];
  });
}

function formatEditBlockers(
  blockers: Array<Record<string, unknown>>,
  hubSessionId?: string,
): string {
  const rendered = blockers.slice(0, 8).map((blocker) => {
    const target = textField(blocker, "path");
    const message = textField(blocker, "message") ?? "范围未获许可";
    if (textField(blocker, "code") === "feature_confirmation_required") {
      const impact = isRecord(blocker.featureImpact) ? blocker.featureImpact : {};
      const featureName = textField(impact, "featureName") ?? "既有功能";
      const symbols = stringArrayField(impact, "symbols");
      const contracts = stringArrayField(impact, "contracts");
      const confirmationId = textField(blocker, "confirmationId");
      return [
        `${target ?? "目标范围"} 将影响历史功能“${featureName}”`,
        symbols.length ? `关联符号：${symbols.join("、")}` : undefined,
        contracts.length ? `既有行为：${contracts.join("；")}` : undefined,
        `原因：${textField(impact, "reason") ?? message}`,
        confirmationId
          ? `Codex 必须先在当前对话询问用户；用户明确同意后调用 feature_change_confirm，sessionId=${hubSessionId ?? "当前 Hook 会话"}，confirmationId=${confirmationId}`
          : "Codex 必须先在当前对话询问用户并取得明确同意",
      ].filter(Boolean).join("；");
    }
    const conflict = isRecord(blocker.conflict) ? blocker.conflict : undefined;
    const owner = conflict ? textField(conflict, "memberName") : undefined;
    const detail = owner ? `${message}（当前由 ${owner} 占用）` : message;
    return target ? `${target}: ${detail}` : detail;
  });
  return `Agent Hub 拒绝本次写入。${rendered.join("；") || "存在未解决的范围冲突。"}`;
}

function formatConflicts(conflicts: Array<Record<string, unknown>>, decision: string): string {
  const rendered = conflicts.slice(0, 8).map((conflict) => {
    const member = textField(conflict, "memberName") ?? "其他成员";
    const requested = textField(conflict, "requestedPath") ?? "请求路径";
    const existing = textField(conflict, "conflictingPath") ?? "已有范围";
    return `${requested} 与 ${member} 的 ${existing} 重叠`;
  });
  return `Agent Hub ${decision === "deny" ? "检测到严格冲突" : "检测到需要协调的重叠"}：${rendered.join("；") || "请查看房间面板"}。`;
}

function formatWarnings(warnings: Array<Record<string, unknown>>): string | undefined {
  if (warnings.length === 0) return undefined;
  return `Agent Hub 提醒：${warnings.slice(0, 5).map((item) => textField(item, "message") ?? "范围有重叠").join("；")}`;
}

function monitorContext(base: string | undefined, warnings: string[]): string | undefined {
  const normalizedBase = base
    ?.replace(/^Agent Hub 拒绝本次写入。/, "Agent Hub 风险提醒：")
    .trim();
  const lines = [
    normalizedBase || undefined,
    ...warnings.map((warning) => `Agent Hub 监测提醒：${warning.trim()}`),
  ].filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function appendMonitorDiagnostic(
  state: CodexHookSessionState,
  source: "quarantine" | "passive_wait" | "write_block_sync" | "blocked_lease",
  reason: string,
  paths: string[],
): void {
  state.advisoryDiagnostics = [
    ...(state.advisoryDiagnostics ?? []),
    { source, reason, paths: unique(paths), detectedAt: new Date().toISOString() },
  ].slice(-20);
}

function allowOutput(additionalContext?: string): Record<string, unknown> | undefined {
  if (!additionalContext) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext,
    },
  };
}

function denyOutput(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function contextOutput(additionalContext: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext,
    },
  };
}

function failureOutput(
  event: CodexHookEventName,
  error: unknown,
  enforceProtection = false,
): Record<string, unknown> | undefined {
  if (event === "Stop") return { continue: true };
  const message = humanError(error);
  if (isSoftIntegrationFailure(error)) {
    const warning = error instanceof AmbiguousRepositoryConnectionError
      ? `Agent Hub 检测到这个项目同时存在多个活动房间，无法安全判断本次会话属于哪一个房间（${message}）。本次操作不会被阻止，但没有完成跨成员协作检查；请在 Agent Hub 中明确打开目标房间。`
      : `Agent Hub 暂时无法连接（${message}）。本次操作不会因网络故障被阻止；恢复连接后再补登记和协作检查。`;
    if (event === "PreToolUse") return allowOutput(warning);
    if (event === "SessionStart") {
      return {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: warning,
        },
      };
    }
    if (event === "PostToolUse") return contextOutput(warning);
    return undefined;
  }
  if (event === "PreToolUse") {
    if (!enforceProtection) {
      return failOpenWriteHookOutput(
        event,
        `协作检查发生错误且未能确认权威保护模式（${message}）。`,
      );
    }
    return denyOutput(`Agent Hub 协作检查失败，已按保护策略暂停写入：${message}`);
  }
  if (event === "SessionStart") {
    return {
      systemMessage: `Agent Hub 暂时无法读取房间：${message}`,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "Agent Hub 当前不可用。不要声称已完成跨成员兼容性检查；恢复连接后再开始写入。",
      },
    };
  }
  if (event === "PostToolUse") {
    if (!enforceProtection) {
      return failOpenWriteHookOutput(
        event,
        `写入登记发生错误且未能确认权威保护模式（${message}）。`,
      );
    }
    return {
      continue: false,
      stopReason: `Agent Hub 无法登记刚才的写入：${message}`,
      systemMessage: `Agent Hub 无法登记刚才的写入：${message}`,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "协作状态同步失败。停止新增修改，保留当前差异并恢复 Agent Hub 连接。",
      },
    };
  }
  return undefined;
}

function isSoftIntegrationFailure(error: unknown): boolean {
  if (error instanceof AmbiguousRepositoryConnectionError) return true;
  if (error instanceof HookCleanupPendingError) return true;
  if (error instanceof AgentHubHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (!(error instanceof Error)) return false;
  return /(?:fetch failed|failed to fetch|offline|network|socket|econn|etimedout|timed out|did not respond|connection reset|connection refused|aborted)/i.test(
    error.message,
  );
}

function createHookGatedFetch(
  options: RunCodexHookOptions,
  connectionId: string,
): typeof fetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    await assertHookIntegrationActive(options, connectionId);
    return fetchImpl(input, init);
  }) as typeof fetch;
}

async function assertHookIntegrationActive(
  options: RunCodexHookOptions,
  connectionId: string,
): Promise<void> {
  const store = await openConnectionStore(options.userDataPath, options.protector);
  const connection = await store.get(connectionId);
  if (!connection) {
    throw new HookIntegrationInactiveError();
  }
  const status = await getLocalIntegrationStatus(
    options.userDataPath,
    connection,
    options.runtimePresencePath,
  );
  if (!status.active) throw new HookIntegrationInactiveError();
  if (!status.remoteAllowed) throw new HookCleanupPendingError(status.diagnostic);
}

class HookIntegrationInactiveError extends Error {
  constructor() {
    super("Agent Hub Codex integration is inactive.");
    this.name = "HookIntegrationInactiveError";
  }
}

class HookCleanupPendingError extends Error {
  constructor(diagnostic?: string) {
    super(diagnostic ?? "Agent Hub is finishing an earlier remote cleanup.");
    this.name = "HookCleanupPendingError";
  }
}

function parseHookInput(raw: string): CodexHookInput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Codex hook input is not valid JSON.");
  }
  if (!isRecord(value)) throw new Error("Codex hook input must be a JSON object.");
  const sessionId = textField(value, "session_id");
  const cwd = textField(value, "cwd");
  const event = textField(value, "hook_event_name");
  if (!sessionId || !cwd || !event) throw new Error("Codex hook input is missing session_id, cwd, or hook_event_name.");
  return {
    session_id: sessionId,
    cwd: path.resolve(cwd),
    hook_event_name: event,
    tool_name: textField(value, "tool_name"),
    tool_input: value.tool_input,
    source: textField(value, "source"),
    reason: textField(value, "reason"),
    turn_id: textField(value, "turn_id"),
    stop_hook_active: typeof value.stop_hook_active === "boolean" ? value.stop_hook_active : undefined,
  };
}

function postToolUseStopOutput(reason: string): Record<string, unknown> {
  return {
    continue: false,
    stopReason: reason,
    systemMessage: reason,
    decision: "block",
    reason,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        `${reason}\n写入已经发生，Agent 必须停止新增修改并保留当前差异，等待 Agent Hub 完成租约状态同步。`,
    },
  };
}

async function readHookInput(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_HOOK_INPUT_BYTES) throw new Error("Codex hook input exceeded 1 MiB.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function upsertLease(state: CodexHookSessionState, lease: HookLeaseState): void {
  state.leases = [...state.leases.filter((item) => item.id !== lease.id), lease];
}

function pathScopeCovers(scope: string, candidate: string): boolean {
  const normalizedScope = pathKey(scope).replace(/\/$/, "");
  const normalizedCandidate = pathKey(candidate).replace(/\/$/, "");
  return normalizedScope === "."
    || normalizedScope === normalizedCandidate
    || normalizedCandidate.startsWith(`${normalizedScope}/`);
}

function pathKey(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").toLocaleLowerCase("en-US");
}

function shortSessionId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12) || "session";
}

function completionTurnId(input: CodexHookInput, activityEpoch: number): string {
  return input.turn_id?.trim() || `${shortSessionId(input.session_id)}-${activityEpoch}`;
}

function mergeAttributedPathEvidence(
  existing: AttributedPathEvidence[],
  updates: AttributedPathEvidence[],
): AttributedPathEvidence[] {
  const merged = new Map(existing.map((evidence) => [pathKey(evidence.path), evidence]));
  for (const evidence of updates) merged.set(pathKey(evidence.path), evidence);
  return [...merged.values()];
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function digestStringSet(values: string[], normalize: (value: string) => string): string {
  const normalized = [...new Set(values.map(normalize).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right, "en-US"));
  return createHash("sha256").update(JSON.stringify(normalized), "utf8").digest("hex");
}

function normalizedEvidenceText(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function inferSystemId(relativePath: string): string {
  const ignored = new Set(["assets", "src", "source", "scripts", "packages", "tests", "test"]);
  return relativePath.replaceAll("\\", "/").split("/")
    .map((part) => part.replace(/\.[^.]+$/, ""))
    .find((part) => part && !ignored.has(part.toLocaleLowerCase("en-US")))
    ?.toLocaleLowerCase("en-US") ?? "project";
}

function slugKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "feature";
}

function humanizeIdentifier(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim() || "功能";
}

function isResourcePath(value: string): boolean {
  return /\.(?:anim|asset|controller|lighting|mat|meta|overridecontroller|physicmaterial|playable|prefab|rendertexture|unity)$/i.test(value);
}

function isSourcePath(value: string): boolean {
  return /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|py|rs|ts|tsx)$/i.test(value);
}

function textField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === "string" && value[key].trim() ? value[key].trim() : undefined;
}

function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  return Array.isArray(value[key])
    ? value[key].filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function humanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
