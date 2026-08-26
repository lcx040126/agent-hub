import type { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import path from "node:path";
import type { SecretProtector } from "../desktop/connection-store.js";
import type { SavedRoomConnection } from "../desktop/contracts.js";
import {
  estimateContextTokens,
  packContextByBudget,
  type ContextBudgetCandidate,
} from "../server/context-budget.js";
import {
  resolveConnectionById,
  resolveConnectionForPath,
  type ResolvedRoomConnection,
} from "./connection-runtime.js";
import {
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
  CodexHookStateStore,
  type CodexHookSessionState,
  type HookLeaseState,
  type HookProposedEditState,
} from "./hook-state.js";
import {
  attributedChangedPaths,
  extractAttributedWriteIntent,
  type AttributedWriteIntent,
} from "./write-attribution.js";

export type CodexHookEventName =
  | "SessionStart"
  | "PreToolUse"
  | "PostToolUse"
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
}

export interface CodexHookInput {
  session_id: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  source?: string;
  reason?: string;
}

interface HookRuntime {
  input: CodexHookInput;
  connection: SavedRoomConnection;
  client: AgentHubClient;
  git: GitWorkingState;
  state: CodexHookSessionState;
  stateStore: CodexHookStateStore;
}

interface RoomSnapshotLike {
  room?: Record<string, unknown>;
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
  decision: "allow" | "warn" | "deny";
  lease?: { id: string; paths?: string[]; expiresAt: string };
  conflicts?: Array<Record<string, unknown>>;
}

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const MAX_SESSION_FEATURE_PATHS = 100;
const LEASE_TTL_MINUTES = 10;

export async function runCodexHook(options: RunCodexHookOptions): Promise<number> {
  const input = parseHookInput(await readHookInput(options.stdin ?? process.stdin));
  const output = options.stdout ?? process.stdout;
  try {
    const result = await handleCodexHook(options, input);
    if (result !== undefined) output.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const message = humanError(error);
    const result = failureOutput(options.eventName, message);
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
  switch (options.eventName) {
    case "SessionStart":
      return handleSessionStart(options, input);
    case "PreToolUse":
      return handlePreToolUse(options, input);
    case "PostToolUse":
      return handlePostToolUse(options, input);
    case "SessionEnd":
      await handleSessionEnd(options, input);
      return undefined;
  }
}

async function handleSessionStart(
  options: RunCodexHookOptions,
  input: CodexHookInput,
): Promise<Record<string, unknown> | undefined> {
  const resolved = await resolveConnectionForPath(
    options.userDataPath,
    input.cwd || options.cwd || process.cwd(),
    options.protector,
  );
  if (!resolved) return undefined;
  const stateStore = new CodexHookStateStore(options.userDataPath);
  const existingState = await stateStore.load(input.session_id);
  const runtime = await openHookRuntime(options, input, resolved, !existingState, existingState);
  const snapshot = await runtime.client.get<RoomSnapshotLike>("/api/snapshot");
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
): Promise<Record<string, unknown> | undefined> {
  const intent = extractAttributedWriteIntent(input.tool_name, input.tool_input);
  if (!intent.writes) return undefined;
  const runtime = await findHookRuntime(options, input);
  if (!runtime) return undefined;
  runtime.git = await inspectGitWorkingState(runtime.connection.repositoryPath, { gitExecutable: options.gitExecutable });
  try {
    await runtime.client.post(`/api/sessions/${encodeURIComponent(runtime.state.hubSessionId)}/sync`, {
      branch: runtime.git.branch,
      baseCommit: runtime.git.headCommit,
    });
  } catch (error) {
    if (error instanceof AgentHubHttpError && (error.code === "branch_changed" || error.code === "session_frozen")) {
      runtime.state.quarantine = { reason: error.message, paths: [], detectedAt: new Date().toISOString() };
      await runtime.stateStore.save(runtime.state);
      return denyOutput(`${error.message} 请确认新分支基线后重新开始 Codex 会话。`);
    }
    throw error;
  }
  if (runtime.state.quarantine) {
    return denyOutput(
      `Agent Hub 已隔离当前会话，因为先前检测到越界写入：${runtime.state.quarantine.reason}`
      + " 请停止新增修改，人工检查现有 Git 差异，并结束当前 Codex 会话后再继续。",
    );
  }
  await renewExpiringLeases(runtime);
  const paths = normalizeCandidates(
    runtime.git.repositoryRoot,
    mapRepositoryCwd(
      runtime.connection.repositoryPath,
      runtime.git.repositoryRoot,
      input.cwd,
    ),
    intent.pathCandidates,
  );
  const proposedEdits = normalizeProposedEdits(
    runtime.git.repositoryRoot,
    mapRepositoryCwd(runtime.connection.repositoryPath, runtime.git.repositoryRoot, input.cwd),
    intent,
  );

  if (paths.length > MAX_SESSION_FEATURE_PATHS || proposedEdits.length > MAX_SESSION_FEATURE_PATHS) {
    return denyOutput(
      `Agent Hub 单次最多协调 ${MAX_SESSION_FEATURE_PATHS} 个明确写入路径；本次命令解析到 ${Math.max(paths.length, proposedEdits.length)} 个。`
      + " 请让 Agent 把修改拆成多个较小的工具调用，确保每个路径都能在写入前完成租约和历史功能检查。",
    );
  }

  if (paths.length === 0) {
    if (intent.attributedSideEffects && intent.proposalHash) {
      setPendingWrite(runtime, input, intent, proposedEdits);
      await runtime.stateStore.save(runtime.state);
      return allowOutput(
        "Agent Hub 已识别这是一项生成、格式化或构建写入；输出路径将在工具结束后按本次增量归因并立即检查。",
      );
    }
    const hasRepositoryLease = runtime.state.leases.some((lease) =>
      lease.paths.some((leasePath) => leasePath === "."),
    );
    if (hasRepositoryLease) return allowOutput("Agent Hub 已确认当前会话持有整个仓库的写入范围。");
    return denyOutput(
      "Agent Hub 无法从这条命令确定将写入哪些文件。请让 Agent 改用 apply_patch，或先通过 lease_acquire 明确领取最小路径后再执行。",
    );
  }

  const existing = await runtime.client.post<EditCheckResponse>("/api/edits/check", {
    sessionId: runtime.state.hubSessionId,
    paths,
    proposedEdits,
  });
  if (existing.allowed) {
    setPendingWrite(runtime, input, intent, proposedEdits);
    await runtime.stateStore.save(runtime.state);
    return allowOutput(formatWarnings(existing.warnings));
  }
  const onlyUncovered = existing.blockers.every((blocker) => blocker.code === "uncovered_path");
  if (!onlyUncovered) {
    return denyOutput(formatEditBlockers(existing.blockers, runtime.state.hubSessionId));
  }

  const claim = await runtime.client.post<LeaseResponse>("/api/leases", {
    title: `Codex 自动范围 ${shortSessionId(input.session_id)}`,
    sessionId: runtime.state.hubSessionId,
    intent: `由 ${input.tool_name ?? "写入工具"} 在实际修改前自动领取`,
    branch: runtime.git.branch,
    baseCommit: runtime.git.headCommit,
    paths,
    mode: "write",
    autoClaim: true,
  });
  if (!claim.acquired || !claim.lease) {
    return denyOutput(formatConflicts(claim.conflicts ?? [], claim.decision));
  }

  upsertLease(runtime.state, {
    id: claim.lease.id,
    paths: claim.lease.paths?.length ? claim.lease.paths : paths,
    expiresAt: claim.lease.expiresAt,
  });
  setPendingWrite(runtime, input, intent, proposedEdits);
  await runtime.stateStore.save(runtime.state);
  const warning = claim.decision === "warn" ? " 当前存在黄色重叠提醒，但不会阻止本次写入。" : "";
  return allowOutput(`Agent Hub 已自动领取写入范围：${paths.join("、")}。${warning}`);
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

async function handlePostToolUse(
  options: RunCodexHookOptions,
  input: CodexHookInput,
): Promise<Record<string, unknown> | undefined> {
  const intent = extractAttributedWriteIntent(input.tool_name, input.tool_input);
  if (!intent.writes) return undefined;
  const runtime = await findHookRuntime(options, input);
  if (!runtime) return undefined;
  runtime.git = await inspectGitWorkingState(runtime.connection.repositoryPath, {
    gitExecutable: options.gitExecutable,
  });
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
  runtime.state.observedChangedPaths = [...runtime.git.changedPaths];
  runtime.state.observedChangedFingerprints = { ...runtime.git.changedPathFingerprints };
  runtime.state.pendingWrite = undefined;
  await runtime.stateStore.save(runtime.state);
  if (newlyObserved.length === 0) return undefined;

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
    return {
      continue: false,
      stopReason: reason,
      systemMessage: reason,
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: reason,
      },
    };
  }
  let check = await runtime.client.post<EditCheckResponse>("/api/edits/check", {
    sessionId: runtime.state.hubSessionId,
    paths: newlyObserved,
    proposedEdits,
  });
  const onlyUncovered = !check.allowed
    && check.blockers.length > 0
    && check.blockers.every((blocker) => blocker.code === "uncovered_path");
  if (onlyUncovered) {
    const uncovered = check.uncoveredPaths.length ? check.uncoveredPaths : newlyObserved;
    const claim = await runtime.client.post<LeaseResponse>("/api/leases", {
      title: `Codex 归因范围 ${shortSessionId(input.session_id)}`,
      sessionId: runtime.state.hubSessionId,
      intent: `由 ${input.tool_name ?? "写入工具"} 产生的已识别增量`,
      branch: runtime.git.branch,
      baseCommit: runtime.state.baseCommit,
      paths: uncovered,
      mode: "write",
      autoClaim: true,
    });
    if (claim.acquired && claim.lease) {
      upsertLease(runtime.state, {
        id: claim.lease.id,
        paths: claim.lease.paths?.length ? claim.lease.paths : uncovered,
        expiresAt: claim.lease.expiresAt,
      });
      await runtime.stateStore.save(runtime.state);
      check = await runtime.client.post<EditCheckResponse>("/api/edits/check", {
        sessionId: runtime.state.hubSessionId,
        paths: newlyObserved,
        proposedEdits,
      });
    }
  }
  await uploadLightweightScan(runtime, "PostToolUse", newlyObserved);
  if (check.allowed) {
    const warnings = formatWarnings(check.warnings);
    return contextOutput(
      `Agent Hub 已登记本次 Agent 实际变更：${newlyObserved.join("、")}。`
      + (warnings ? `\n${warnings}` : ""),
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
  return {
    continue: false,
    stopReason: reason,
    systemMessage: reason,
    decision: "block",
    reason,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        `${reason}\n写入已经发生，Agent 必须停止继续修改并保留现有差异；人工、IDE 或 Unity 的无关变化没有被上传为风险。`,
    },
  };
}

async function handleSessionEnd(options: RunCodexHookOptions, input: CodexHookInput): Promise<void> {
  const stateStore = new CodexHookStateStore(options.userDataPath);
  const state = await stateStore.load(input.session_id);
  if (!state) return;
  const resolved = await resolveConnectionById(
    options.userDataPath,
    state.connectionId,
    options.protector,
  );
  const client = new AgentHubClient({
    serverUrl: resolved.connection.serverUrl,
    memberToken: resolved.memberToken,
    fetchImpl: options.fetchImpl,
  });
  const git = await inspectGitWorkingState(resolved.connection.repositoryPath, {
    gitExecutable: options.gitExecutable,
  });
  const actualPaths = unique(state.attributedChangedPaths ?? []);

  let featureMemorySummary = "未发现可归因给本次 Agent 的代码变化。";
  let featureEvidence: FeatureGitEvidence | undefined;
  let featureVerifications: AutomaticFeatureVerification[] = [];
  if (state.attributedPathsTruncated) {
    featureMemorySummary = `本次 Agent 会话涉及超过 ${MAX_SESSION_FEATURE_PATHS} 个归因路径，自动功能记忆未生成，以免用不完整证据覆盖稳定版本。`;
    await client.post("/api/records", {
      kind: "risk",
      title: "自动功能证据超过单会话上限",
      summary: featureMemorySummary,
      paths: actualPaths,
      status: "open",
      evidence: [`Codex session ${input.session_id}`],
    }).catch(() => undefined);
  } else if (actualPaths.length > 0) {
    try {
      [featureEvidence, featureVerifications] = await Promise.all([
        collectFeatureGitEvidence(git.repositoryRoot, state.baseCommit, {
          gitExecutable: options.gitExecutable,
          includePaths: actualPaths,
        }),
        collectSessionFeatureVerifications(client, state),
      ]);
    } catch (error) {
      featureMemorySummary = `自动功能证据收集失败：${humanError(error)}`;
      await client.post("/api/records", {
        kind: "risk",
        title: "自动功能证据尚未生成",
        summary: featureMemorySummary,
        paths: actualPaths,
        status: "open",
        evidence: [`Codex session ${input.session_id}`],
      }).catch(() => undefined);
    }
  }

  await client.post(`/api/sessions/${encodeURIComponent(state.hubSessionId)}/scan`, {
    repository: git.repositoryRoot,
    branch: git.branch,
    worktree: git.repositoryRoot,
    baseCommit: state.baseCommit,
    changedPaths: featureEvidence?.changedPaths ?? actualPaths,
    ruleFiles: [],
    systems: featureEvidence?.inferredSystems ?? [],
    metadata: {
      source: "codex-hook",
      event: "SessionEnd",
      attributedPathCount: actualPaths.length,
      attributedPathsTruncated: state.attributedPathsTruncated === true,
      featureEvidence: featureEvidence ? featureEvidenceAttestation(featureEvidence) : undefined,
      externalChangeCount: state.externalChangeDiagnostics?.reduce(
        (total, diagnostic) => total + diagnostic.paths.length,
        0,
      ) ?? 0,
    },
  });

  if (featureEvidence) {
    try {
      featureMemorySummary = await submitAutomaticFeatureDraft(
        client,
        state,
        featureEvidence,
        featureVerifications,
      );
    } catch (error) {
      featureMemorySummary = `自动功能记忆生成失败：${humanError(error)}`;
      await client.post("/api/records", {
        kind: "risk",
        title: "自动功能记忆尚未生成",
        summary: featureMemorySummary,
        paths: actualPaths,
        status: "open",
        evidence: [`Codex session ${input.session_id}`],
      }).catch(() => undefined);
    }
  }

  for (const lease of state.leases) {
    const leasePaths = actualPaths.filter((candidate) =>
      lease.paths.some((scope) => pathScopeCovers(scope, candidate)),
    );
    await client.post(`/api/leases/${encodeURIComponent(lease.id)}/close`, {
      sessionId: state.hubSessionId,
      status: "completed",
      summary: "Codex 会话结束，Agent Hub 已自动同步实际变更并释放范围。",
      changedPaths: leasePaths,
      validations: [],
      remainingRisks: [],
    }).catch((error: unknown) => {
      if (!shouldDiscardLeaseRenewal(error)) throw error;
    });
  }
  await client.post(`/api/sessions/${encodeURIComponent(state.hubSessionId)}/close`, {
    summary: `Codex session ended with ${actualPaths.length} attributed path(s). ${featureMemorySummary}`,
  });
  await stateStore.remove(input.session_id);
}

async function findHookRuntime(
  options: RunCodexHookOptions,
  input: CodexHookInput,
): Promise<HookRuntime | undefined> {
  const stateStore = new CodexHookStateStore(options.userDataPath);
  const state = await stateStore.load(input.session_id);
  const resolved = state
    ? await resolveConnectionById(options.userDataPath, state.connectionId, options.protector)
    : await resolveConnectionForPath(
        options.userDataPath,
        input.cwd || options.cwd || process.cwd(),
        options.protector,
      );
  if (!resolved) return undefined;
  return openHookRuntime(options, input, resolved, false, state);
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
    fetchImpl: options.fetchImpl,
  });
  let state = existingState ?? (await stateStore.load(input.session_id));
  if (!state || refreshInitial) {
    const opened = await client.post<{ session: { id: string } }>("/api/sessions", {
      clientName: "Agent Hub Codex hook",
      agentName: "Codex",
      repository: git.repositoryRoot,
      branch: git.branch,
      worktree: git.repositoryRoot,
      baseCommit: git.headCommit,
      task: `Codex session ${input.session_id}`,
      metadata: {
        source: "codex-hook",
        codexSessionId: input.session_id,
        startSource: input.source,
      },
    });
    const now = new Date().toISOString();
    state = {
      version: 1,
      codexSessionId: input.session_id,
      connectionId: resolved.connection.id,
      hubSessionId: opened.session.id,
      repositoryPath: git.repositoryRoot,
      branch: git.branch,
      baseCommit: git.headCommit,
      initialChangedPaths: git.changedPaths,
      initialChangedFingerprints: { ...git.changedPathFingerprints },
      observedChangedPaths: git.changedPaths,
      observedChangedFingerprints: { ...git.changedPathFingerprints },
      leases: [],
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
  state: CodexHookSessionState,
  evidence: FeatureGitEvidence,
  verifications: AutomaticFeatureVerification[],
): Promise<string> {
  if (evidence.changedPaths.length === 0) return "归因路径没有留下可记录的 Git 差异。";

  const systemId = evidence.inferredSystems[0] ?? inferSystemId(evidence.changedPaths[0] ?? "project");
  const primarySymbol = evidence.symbols[0] ?? path.parse(evidence.changedPaths[0] ?? "feature").name;
  const featureKey = `auto:${slugKey(systemId)}:${slugKey(primarySymbol)}`.slice(0, 240);
  const name = evidence.commits[0]?.subject.trim()
    || `${humanizeIdentifier(systemId)} / ${humanizeIdentifier(primarySymbol)}`;
  const query = await client.post<FeatureQueryResponse>("/api/features/query", {
    sessionId: state.hubSessionId,
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
  state: CodexHookSessionState,
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
  const roomName = textField(room, "name") ?? textField(room, "roomName") ?? connection.roomName ?? "当前房间";
  const blockingEnabled = room.blockingProtectionEnabled !== false;
  const policyVersion = typeof room.riskPolicyVersion === "number" ? room.riskPolicyVersion : 1;
  const automaticTtl = typeof room.automaticLeaseTtlMinutes === "number"
    ? room.automaticLeaseTtlMinutes
    : LEASE_TTL_MINUTES;
  const header = [
    `Agent Hub 已连接：${roomName}。当前分支 ${git.branch}，提交 ${git.headCommit.slice(0, 12)}。`,
    `当前 Hook 与 MCP 必须共同使用 Agent Hub sessionId=${hubSessionId}；不要再调用 session_open 创建第二个会话。`,
    `当前实时保护：${blockingEnabled ? "按策略执行黄色警告/红色阻塞" : "普通重叠全部降为黄色警告"}；策略版本 ${policyVersion}；自动租期 ${automaticTtl} 分钟。`,
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

  const footer = "Agent Hub 会在写入前自动领取最小路径并检查冲突，在写入后只登记可归因给当前 Agent 的实际变更。出现拒绝时不要绕过；先读取命中原因，只有业务规则确实冲突时再询问人。";
  const truncatedNotice = "还有更多完整协作条目未在启动层加载；请通过 MCP 按路径、系统或目标继续查询。";
  const memoryUnavailableNotice = "长期功能记忆索引本次未能加载；实时租约与冲突保护仍然有效，请通过 MCP 按需重试记忆查询。";
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

function failureOutput(event: CodexHookEventName, message: string): Record<string, unknown> | undefined {
  if (event === "PreToolUse") {
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
