import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { resolveGitExecutable } from "../companion/git-executable.js";

const DEFAULT_SHARED_BRANCHES = ["main", "master", "develop", "development", "release/*"];
const DEFAULT_TIMEOUT_MS = 10_000;
const CRITICAL_RISK_STATUSES = new Set([
  "critical",
  "blocking",
  "critical-open",
  "open-critical",
]);
const FAILED_STATUSES = new Set(["failed", "fail", "failure"]);

export type PublicationBlockerKind =
  | "critical_risk"
  | "blocking_conflict"
  | "failed_verification";

export interface PublicationBlocker {
  kind: PublicationBlockerKind;
  id: string;
  title: string;
  summary: string;
  createdAt: string | null;
}

export interface PublicationGateEvaluation {
  allowed: boolean;
  blockers: PublicationBlocker[];
  blockingProtectionEnabled: boolean | null;
}

export interface PublicationGateOptions {
  branch: string;
  sharedBranches?: string[];
  serviceUrl?: string;
  memberToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

export interface PublicationGateRunResult extends PublicationGateEvaluation {
  exitCode: 0 | 1 | 2;
  skipped: boolean;
}

export async function runPublicationGate(
  options: PublicationGateOptions,
): Promise<PublicationGateRunResult> {
  const log = options.log ?? console.log;
  const error = options.error ?? console.error;
  const branch = normalizeBranch(options.branch);
  const sharedBranches = normalizeSharedBranches(options.sharedBranches);

  if (!branch) {
    error("Agent Hub 发布门禁失败：无法确定当前分支。请使用 --branch 明确指定待发布分支。");
    return failedRun(2);
  }
  if (!matchesSharedBranch(branch, sharedBranches)) {
    log(`Agent Hub 发布门禁：当前分支 \"${branch}\" 不是共享分支，跳过检查。`);
    return {
      allowed: true,
      blockers: [],
      blockingProtectionEnabled: null,
      exitCode: 0,
      skipped: true,
    };
  }

  const serviceUrl = normalizeServiceUrl(options.serviceUrl);
  if (!serviceUrl) {
    error(
      "Agent Hub 发布门禁失败：共享分支缺少服务地址。请设置 AGENT_HUB_URL 或使用 --url。共享分支采用默认拒绝策略，本次推送/发布已停止。",
    );
    return failedRun(2);
  }
  const memberToken = options.memberToken?.trim();
  if (!memberToken) {
    error(
      "Agent Hub 发布门禁失败：共享分支缺少成员令牌。请设置 AGENT_HUB_TOKEN。共享分支采用默认拒绝策略，本次推送/发布已停止。",
    );
    return failedRun(2);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const timeoutMs = normalizeTimeout(options.timeoutMs);
    const signal = AbortSignal.timeout(timeoutMs);
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${memberToken}`,
    };
    const dashboard = await fetchJson(`${serviceUrl}/api/dashboard`, headers, signal, fetchImpl);
    let snapshot: unknown;
    let snapshotError: string | undefined;
    try {
      snapshot = await fetchJson(`${serviceUrl}/api/snapshot`, headers, signal, fetchImpl);
    } catch (caught) {
      snapshotError = caught instanceof Error ? caught.message : "未知快照错误";
    }
    const evaluation = evaluatePublicationGate(dashboard, snapshot);
    if (snapshotError && evaluation.blockingProtectionEnabled !== false) {
      error(
        `Agent Hub 发布门禁失败：房间快照不可用（${snapshotError}），且写入阻塞保护未明确关闭。共享分支保持默认拒绝策略。`,
      );
      reportFindings(evaluation.blockers, error);
      return { ...evaluation, allowed: false, exitCode: 2, skipped: false };
    }
    if (evaluation.blockingProtectionEnabled === null) {
      error(
        `Agent Hub 发布门禁失败：无法确认房间阻塞保护设置${snapshotError ? `（${snapshotError}）` : ""}。共享分支保持默认拒绝策略。`,
      );
      reportFindings(evaluation.blockers, error);
      return { ...evaluation, allowed: false, exitCode: 2, skipped: false };
    }
    if (!evaluation.blockingProtectionEnabled) {
      log(`Agent Hub 发布门禁：房间处于纯监测模式，以下发现仅报告，不阻止共享分支 \"${branch}\"：`);
      reportFindings(evaluation.blockers, log);
      return { ...evaluation, allowed: true, exitCode: 0, skipped: false };
    }
    if (evaluation.allowed) {
      log(`Agent Hub 发布门禁通过：共享分支 \"${branch}\" 没有未解决的发布阻塞项。`);
      return { ...evaluation, exitCode: 0, skipped: false };
    }

    error(`Agent Hub 发布门禁拒绝发布：共享分支 \"${branch}\" 有 ${evaluation.blockers.length} 项未解决问题：`);
    for (const blocker of evaluation.blockers) {
      error(`- [${blockerLabel(blocker.kind)}] ${blocker.title}：${blocker.summary}`);
    }
    return { ...evaluation, exitCode: 1, skipped: false };
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : "未知网络错误";
    error(
      `Agent Hub 发布门禁失败：无法从 ${serviceUrl} 取得可信协作状态（${reason}）。共享分支采用默认拒绝策略，本次推送/发布已停止。`,
    );
    return failedRun(2);
  }
}

export function evaluatePublicationGate(
  dashboardValue: unknown,
  snapshotValue: unknown,
): PublicationGateEvaluation {
  const dashboard = asObject(dashboardValue);
  const snapshot = asObject(snapshotValue);
  const snapshotSettings = asObject(snapshot.settings);
  const dashboardSettings = asObject(dashboard.settings);
  const blockingProtectionEnabled = typeof snapshotSettings.blockingProtectionEnabled === "boolean"
    ? snapshotSettings.blockingProtectionEnabled
    : typeof dashboardSettings.blockingProtectionEnabled === "boolean"
      ? dashboardSettings.blockingProtectionEnabled
      : null;
  const blockers = new Map<string, PublicationBlocker>();

  const records = newestByKey(
    asArray(dashboard.records).map(asObject),
    (record) => recordScopeKey(record),
  );
  for (const record of records) {
    const kind = normalizedWord(record.kind);
    const status = normalizedWord(record.status);
    if (kind === "risk" && CRITICAL_RISK_STATUSES.has(status)) {
      putBlocker(blockers, {
        kind: "critical_risk",
        id: stableId(record, "risk"),
        title: displayString(record.title, "未命名 critical 风险"),
        summary: displayString(record.summary, "该 critical 风险尚未解决。"),
        createdAt: nullableDisplayString(record.createdAt),
      });
    }
    if (kind === "validation" && FAILED_STATUSES.has(status)) {
      putBlocker(blockers, {
        kind: "failed_verification",
        id: stableId(record, "validation"),
        title: displayString(record.title, "失败验证"),
        summary: displayString(record.summary, "最新验证结果失败。"),
        createdAt: nullableDisplayString(record.createdAt),
      });
    }
  }

  const verifications = newestByKey(
    asArray(snapshot.verifications).map(asObject),
    (verification) =>
      `${displayString(verification.leaseId, "room").toLowerCase()}|${normalizedWord(verification.kind)}`,
  );
  for (const verification of verifications) {
    if (!FAILED_STATUSES.has(normalizedWord(verification.result))) continue;
    putBlocker(blockers, {
      kind: "failed_verification",
      id: stableId(verification, "verification"),
      title: `${displayString(verification.kind, "manual")} 验证失败`,
      summary: displayString(verification.summary, "最新验证结果失败。"),
      createdAt: nullableDisplayString(verification.createdAt),
    });
  }

  for (const conflictValue of asArray(dashboard.conflicts)) {
    const conflict = asObject(conflictValue);
    const decision = normalizedWord(conflict.decision);
    if (decision !== "deny") continue;
    putBlocker(blockers, {
      kind: "blocking_conflict",
      id: stableId(conflict, "conflict"),
      title: displayString(conflict.title, "高风险范围冲突"),
      summary: displayString(
        conflict.summary,
        displayString(conflict.reason, "高风险工作范围仍被其他成员占用。"),
      ),
      createdAt: nullableDisplayString(conflict.createdAt),
    });
  }

  const values = [...blockers.values()].sort((left, right) =>
    `${left.kind}:${left.title}`.localeCompare(`${right.kind}:${right.title}`),
  );
  return {
    allowed: blockingProtectionEnabled === false || (blockingProtectionEnabled === true && values.length === 0),
    blockers: values,
    blockingProtectionEnabled,
  };
}

export function matchesSharedBranch(branchValue: string, patterns: string[]): boolean {
  const branch = normalizeBranch(branchValue).toLowerCase();
  return patterns.some((patternValue) => {
    const pattern = normalizeBranch(patternValue).toLowerCase();
    if (pattern.endsWith("/*")) {
      return branch.startsWith(pattern.slice(0, -1));
    }
    return branch === pattern;
  });
}

interface ParsedArguments {
  help: boolean;
  branch?: string;
  serviceUrl?: string;
  sharedBranches: string[];
  timeoutMs?: number;
}

export function parsePublicationGateArguments(arguments_: string[]): ParsedArguments {
  const parsed: ParsedArguments = { help: false, sharedBranches: [] };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    const [name, inlineValue] = argument.split("=", 2);
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      const next = arguments_[index];
      if (!next || next.startsWith("--")) {
        throw new Error(`参数 ${name} 缺少值。`);
      }
      return next;
    };
    if (name === "--url") parsed.serviceUrl = takeValue();
    else if (name === "--branch") parsed.branch = takeValue();
    else if (name === "--shared-branch") parsed.sharedBranches.push(takeValue());
    else if (name === "--timeout-ms") parsed.timeoutMs = Number(takeValue());
    else throw new Error(`未知参数：${argument}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  let arguments_: ParsedArguments;
  try {
    arguments_ = parsePublicationGateArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "发布门禁参数无效。");
    console.error("运行 pnpm gate:publish -- --help 查看用法。");
    process.exitCode = 2;
    return;
  }
  if (arguments_.help) {
    console.log(HELP_TEXT);
    return;
  }

  const result = await runPublicationGate({
    branch:
      arguments_.branch ??
      process.env.AGENT_HUB_BRANCH ??
      process.env.GITHUB_BASE_REF ??
      process.env.GITHUB_REF_NAME ??
      detectCurrentBranch(),
    sharedBranches:
      arguments_.sharedBranches.length > 0
        ? arguments_.sharedBranches
        : splitList(process.env.AGENT_HUB_SHARED_BRANCHES),
    serviceUrl: arguments_.serviceUrl ?? process.env.AGENT_HUB_URL,
    memberToken: process.env.AGENT_HUB_TOKEN,
    timeoutMs: arguments_.timeoutMs,
  });
  process.exitCode = result.exitCode;
}

const HELP_TEXT = `Agent Hub 共享分支发布门禁

用法：
  pnpm gate:publish -- --url http://192.168.1.20:4173 --branch develop

参数：
  --url <地址>              Agent Hub 房间服务地址，也可设置 AGENT_HUB_URL
  --branch <分支>           待推送或合并的分支；默认读取 CI 环境或当前 Git 分支
  --shared-branch <模式>    共享分支，可重复；支持 release/* 形式的前缀模式
  --timeout-ms <毫秒>       服务请求超时，默认 10000

环境变量：
  AGENT_HUB_TOKEN           房间成员令牌，只从环境变量读取，避免出现在命令历史中
  AGENT_HUB_SHARED_BRANCHES 逗号分隔的共享分支；默认 main,master,develop,development,release/*

该命令不会安装或执行本地 commit Hook。仅在共享分支推送、合并或 CI 发布前调用。
共享分支上服务不可达、令牌缺失或无法确认阻塞保护设置时默认拒绝发布。只有房间明确设置为纯监测模式时，才只报告发现并返回成功。`;

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(url, { method: "GET", headers, signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const message = displayString(body.message, `HTTP ${response.status}`);
    throw new Error(`${url} 返回 ${response.status}：${message}`);
  }
  return response.json();
}

function newestByKey(
  values: Record<string, unknown>[],
  key: (value: Record<string, unknown>) => string,
): Record<string, unknown>[] {
  const sorted = [...values].sort((left, right) =>
    displayString(right.createdAt).localeCompare(displayString(left.createdAt)),
  );
  const latest = new Map<string, Record<string, unknown>>();
  for (const value of sorted) {
    const valueKey = key(value);
    if (!latest.has(valueKey)) latest.set(valueKey, value);
  }
  return [...latest.values()];
}

function recordScopeKey(record: Record<string, unknown>): string {
  const kind = normalizedWord(record.kind);
  const paths = asArray(record.paths)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .sort();
  let title = displayString(record.title).trim().toLowerCase();
  if (kind === "validation") {
    title = title.replace(/:\s*(passed|failed|pending|pass|fail|success)$/i, "");
  }
  return `${kind}|${title}|${paths.join(",")}`;
}

function putBlocker(blockers: Map<string, PublicationBlocker>, blocker: PublicationBlocker): void {
  const existing = blockers.get(blocker.id);
  if (!existing || blocker.kind === "failed_verification") blockers.set(blocker.id, blocker);
}

function stableId(value: Record<string, unknown>, prefix: string): string {
  const id = displayString(value.id).trim();
  if (id) return id;
  return `${prefix}:${displayString(value.title, displayString(value.summary, "unknown"))}`;
}

function blockerLabel(kind: PublicationBlockerKind): string {
  if (kind === "critical_risk") return "critical 风险";
  if (kind === "blocking_conflict") return "阻塞冲突";
  return "失败验证";
}

function reportFindings(
  blockers: PublicationBlocker[],
  report: (message: string) => void,
): void {
  if (blockers.length === 0) {
    report("- 没有发现未解决的 critical 风险、deny 冲突或最新失败验证。");
    return;
  }
  for (const blocker of blockers) {
    report(`- [${blockerLabel(blocker.kind)}] ${blocker.title}：${blocker.summary}`);
  }
}

function normalizeSharedBranches(values: string[] | undefined): string[] {
  const normalized = (values ?? []).map(normalizeBranch).filter(Boolean);
  return normalized.length > 0 ? normalized : DEFAULT_SHARED_BRANCHES;
}

function normalizeBranch(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/^refs\/heads\//i, "")
    .replace(/^origin\//i, "");
}

function normalizeServiceUrl(value: string | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 100 || value > 60_000) {
    throw new Error("请求超时必须在 100 到 60000 毫秒之间。");
  }
  return Math.round(value);
}

function detectCurrentBranch(): string {
  try {
    return execFileSync(resolveGitExecutable(), ["branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizedWord(value: unknown): string {
  return displayString(value)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function displayString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function nullableDisplayString(value: unknown): string | null {
  const string = displayString(value);
  return string || null;
}

function failedRun(exitCode: 1 | 2): PublicationGateRunResult {
  return {
    allowed: false,
    blockers: [],
    blockingProtectionEnabled: null,
    exitCode,
    skipped: false,
  };
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  void main();
}
