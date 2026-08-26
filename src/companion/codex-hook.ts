import type { Readable, Writable } from "node:stream";
import path from "node:path";
import type { SecretProtector } from "../desktop/connection-store.js";
import type { SavedRoomConnection } from "../desktop/contracts.js";
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
  CodexHookStateStore,
  type CodexHookSessionState,
  type HookLeaseState,
} from "./hook-state.js";

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
}

interface EditCheckResponse {
  allowed: boolean;
  blockers: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
  coveredPaths: string[];
  uncoveredPaths: string[];
}

interface LeaseResponse {
  acquired: boolean;
  decision: "allow" | "warn" | "deny";
  lease?: { id: string; paths?: string[]; expiresAt: string };
  conflicts?: Array<Record<string, unknown>>;
}

const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const LEASE_TTL_MINUTES = 30;

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
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: formatRoomContext(snapshot, runtime.connection, runtime.git),
    },
  };
}

async function handlePreToolUse(
  options: RunCodexHookOptions,
  input: CodexHookInput,
): Promise<Record<string, unknown> | undefined> {
  const intent = extractWriteIntent(input.tool_name, input.tool_input);
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

  if (paths.length === 0) {
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
  });
  if (existing.allowed) {
    return allowOutput(formatWarnings(existing.warnings));
  }
  const onlyUncovered = existing.blockers.every((blocker) => blocker.code === "uncovered_path");
  if (!onlyUncovered) return denyOutput(formatEditBlockers(existing.blockers));

  const claim = await runtime.client.post<LeaseResponse>("/api/leases", {
    title: `Codex 自动范围 ${shortSessionId(input.session_id)}`,
    sessionId: runtime.state.hubSessionId,
    intent: `由 ${input.tool_name ?? "写入工具"} 在实际修改前自动领取`,
    branch: runtime.git.branch,
    baseCommit: runtime.git.headCommit,
    paths,
    mode: "write",
    ttlMinutes: LEASE_TTL_MINUTES,
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
  await runtime.stateStore.save(runtime.state);
  return allowOutput(`Agent Hub 已自动领取写入范围：${paths.join("、")}。`);
}

async function handlePostToolUse(
  options: RunCodexHookOptions,
  input: CodexHookInput,
): Promise<Record<string, unknown> | undefined> {
  const intent = extractWriteIntent(input.tool_name, input.tool_input);
  if (!intent.writes) return undefined;
  const runtime = await findHookRuntime(options, input);
  if (!runtime) return undefined;
  runtime.git = await inspectGitWorkingState(runtime.connection.repositoryPath, {
    gitExecutable: options.gitExecutable,
  });
  await uploadLightweightScan(runtime, "PostToolUse");

  const actualPaths = changedDuringSession(runtime.git, runtime.state);
  const newlyObserved = actualPaths.filter((item) =>
    runtime.state.observedChangedFingerprints[pathKey(item)]
      !== runtime.git.changedPathFingerprints[pathKey(item)]);
  runtime.state.observedChangedPaths = [...runtime.git.changedPaths];
  runtime.state.observedChangedFingerprints = { ...runtime.git.changedPathFingerprints };
  await runtime.stateStore.save(runtime.state);
  if (newlyObserved.length === 0) return undefined;

  const check = await runtime.client.post<EditCheckResponse>("/api/edits/check", {
    sessionId: runtime.state.hubSessionId,
    paths: newlyObserved,
  });
  if (check.allowed) {
    return contextOutput(`Agent Hub 已登记实际变更：${newlyObserved.join("、")}。`);
  }

  const reason = formatEditBlockers(check.blockers);
  runtime.state.quarantine = {
    reason,
    paths: newlyObserved,
    detectedAt: new Date().toISOString(),
  };
  await runtime.stateStore.save(runtime.state);
  await runtime.client.post("/api/records", {
    kind: "risk",
    title: "检测到未受租约保护的实际变更",
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
        `${reason}\n写入已经发生，Agent 必须停止继续修改，先检查差异并解决或登记范围冲突。`,
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
  const actualPaths = changedDuringSession(git, state);

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
      if (!(error instanceof AgentHubHttpError) || error.status !== 404) throw error;
    });
  }
  await client.post(`/api/sessions/${encodeURIComponent(state.hubSessionId)}/scan`, {
    repository: git.repositoryRoot,
    branch: git.branch,
    worktree: git.repositoryRoot,
    baseCommit: git.headCommit,
    changedPaths: git.changedPaths,
    ruleFiles: [],
    systems: [],
    metadata: { source: "codex-hook", event: "SessionEnd", actualPaths },
  });
  await client.post(`/api/sessions/${encodeURIComponent(state.hubSessionId)}/close`, {
    summary: `Codex session ended with ${actualPaths.length} changed path(s).`,
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

async function uploadLightweightScan(runtime: HookRuntime, event: string): Promise<void> {
  await runtime.client.post(
    `/api/sessions/${encodeURIComponent(runtime.state.hubSessionId)}/scan`,
    {
      repository: runtime.git.repositoryRoot,
      branch: runtime.git.branch,
      worktree: runtime.git.repositoryRoot,
      baseCommit: runtime.git.headCommit,
      changedPaths: runtime.git.changedPaths,
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
      if (!(error instanceof AgentHubHttpError) || error.status !== 404) throw error;
    }
  }
  runtime.state.leases = renewed;
  await runtime.stateStore.save(runtime.state);
}

export function extractWriteIntent(
  toolName: string | undefined,
  toolInput: unknown,
): { writes: boolean; pathCandidates: string[] } {
  const command = isRecord(toolInput) && typeof toolInput.command === "string"
    ? toolInput.command
    : "";
  if (toolName === "apply_patch") {
    const candidates: string[] = [];
    for (const match of command.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) {
      if (match[1]) candidates.push(match[1].trim());
    }
    for (const match of command.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) {
      if (match[1]) candidates.push(match[1].trim());
    }
    return { writes: true, pathCandidates: unique(candidates) };
  }
  if (toolName !== "Bash" || !isPotentialWriteCommand(command)) {
    return { writes: false, pathCandidates: [] };
  }
  return { writes: true, pathCandidates: extractShellPathCandidates(command) };
}

function isPotentialWriteCommand(command: string): boolean {
  return /(?:^|[\s;&|])(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|del|erase|move|copy|xcopy|robocopy|rm|mv|cp|touch|mkdir|tee)(?:\s|$)/i.test(command)
    || /(?:^|\s)(?:sed\s+-[^\r\n]*i|perl\s+-[^\r\n]*pi)(?:\s|$)/i.test(command)
    || /(?:^|\s)git\s+(?:apply|checkout|restore|clean|reset)(?:\s|$)/i.test(command)
    || /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall|update)(?:\s|$)/i.test(command)
    || /(?:^|\s)(?:prettier[^\r\n]*--write|eslint[^\r\n]*--fix|dotnet\s+format|cargo\s+fmt)(?:\s|$)/i.test(command)
    || /(^|[^<>])>{1,2}(?!=)/m.test(command);
}

function extractShellPathCandidates(command: string): string[] {
  const candidates: string[] = [];
  const patterns = [
    /(?:^|[^>])>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|]+)/gm,
    /-(?:Path|LiteralPath|Destination)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/gim,
    /(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|rm|mv|cp|touch|tee)\s+(?:-[A-Za-z]+\s+)*("[^"]+"|'[^']+'|[^\s;&|]+)/gim,
  ];
  for (const pattern of patterns) {
    for (const match of command.matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (candidate && !candidate.startsWith("http://") && !candidate.startsWith("https://")) {
        candidates.push(candidate);
      }
    }
  }
  for (const match of command.matchAll(/"([A-Za-z]:\\[^"]+|[^"\r\n]+[\\/][^"\r\n]+)"|'([^'\r\n]+[\\/][^'\r\n]+)'/g)) {
    const candidate = match[1] ?? match[2];
    if (candidate) candidates.push(candidate);
  }
  return unique(candidates.map(stripWrappingQuotes));
}

function normalizeCandidates(repositoryRoot: string, cwd: string, candidates: string[]): string[] {
  return unique(
    candidates
      .map((candidate) => toRepositoryRelativePath(repositoryRoot, cwd, candidate))
      .filter((candidate): candidate is string => Boolean(candidate)),
  ).slice(0, 100);
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

function formatRoomContext(
  snapshot: RoomSnapshotLike,
  connection: SavedRoomConnection,
  git: GitWorkingState,
): string {
  const room = isRecord(snapshot.room) ? snapshot.room : {};
  const roomName = textField(room, "name") ?? textField(room, "roomName") ?? connection.roomName ?? "当前房间";
  const lines = [
    `Agent Hub 已连接：${roomName}。当前分支 ${git.branch}，提交 ${git.headCommit.slice(0, 12)}。`,
    "以下是房间的实时协作状态。Git、项目源码和人工批准的规则仍是最终事实来源。",
  ];
  appendSummary(lines, "成员", snapshot.members, (item) =>
    `${textField(item, "displayName") ?? textField(item, "name") ?? "成员"} (${textField(item, "role") ?? "member"})`, 12);
  appendSummary(lines, "正在占用的范围", snapshot.activeLeases, (item) => {
    const paths = stringArrayField(item, "paths");
    return `${textField(item, "memberName") ?? "成员"}: ${textField(item, "title") ?? "工作"} [${paths.join(", ")}]`;
  }, 15);
  appendSummary(lines, "已确认决定", snapshot.decisions, (item) =>
    `${textField(item, "title") ?? "决定"}: ${textField(item, "decision") ?? ""}`, 10);
  const risks = (snapshot.records ?? []).filter((item) => isRecord(item) && item.kind === "risk" && item.status !== "resolved");
  appendSummary(lines, "未解决风险", risks, (item) =>
    `${textField(item, "title") ?? "风险"}: ${textField(item, "summary") ?? ""}`, 10);
  appendSummary(lines, "最近验证", snapshot.verifications, (item) =>
    `${textField(item, "kind") ?? "验证"}/${textField(item, "result") ?? "unknown"}: ${textField(item, "summary") ?? ""}`, 10);
  appendSummary(lines, "本地分析影响范围", snapshot.localScans, (item) => {
    const metadata = isRecord(item.metadata) ? item.metadata : {};
    const impacted = stringArrayField(metadata, "impactedSystemIds");
    return impacted.length ? impacted.join(", ") : "未发现新增影响系统";
  }, 5);
  lines.push(
    "Agent Hub 会在写入前自动领取最小路径并检查冲突，在写入后登记实际变更。出现拒绝时不要绕过；先缩小范围，只有业务规则确实冲突时再询问人。",
  );
  return lines.join("\n").slice(0, 12_000);
}

function appendSummary(
  lines: string[],
  title: string,
  values: unknown[] | undefined,
  render: (value: Record<string, unknown>) => string,
  limit: number,
): void {
  const entries = (values ?? []).filter(isRecord).slice(0, limit).map(render).filter(Boolean);
  lines.push(`${title}：${entries.length ? entries.join("；") : "无"}`);
}

function formatEditBlockers(blockers: Array<Record<string, unknown>>): string {
  const rendered = blockers.slice(0, 8).map((blocker) => {
    const target = textField(blocker, "path");
    const message = textField(blocker, "message") ?? "范围未获许可";
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

function changedDuringSession(git: GitWorkingState, state: CodexHookSessionState): string[] {
  const initial = new Set(state.initialChangedPaths.map(pathKey));
  return git.changedPaths.filter((item) => {
    const key = pathKey(item);
    if (!initial.has(key)) return true;
    const initialFingerprint = state.initialChangedFingerprints[key];
    return initialFingerprint !== undefined
      && initialFingerprint !== git.changedPathFingerprints[key];
  });
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

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
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
