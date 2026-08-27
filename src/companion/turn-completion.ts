import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MISSING_GIT_ENTRY = "missing";

export interface AttributedPathEvidence {
  path: string;
  baseEntry: string | null;
  attributedEntry: string | null;
}

export interface CollectAttributedPathEvidenceOptions {
  gitExecutable?: string;
  timeoutMs?: number;
}

export interface TurnCompletionEvidenceInput {
  repositoryPath: string;
  branch: string;
  baseCommit: string;
  attributedPaths: string[];
  baselineEvidence: AttributedPathEvidence[];
  attributedPathsTruncated?: boolean;
  attributionComplete: boolean;
}

export type TurnCompletionEvidenceResult =
  | { status: "committed" | "reverted"; headCommit: string }
  | { status: "awaiting_commit"; headCommit: string; reason: string }
  | { status: "incomplete"; headCommit?: string; reason: string };

/**
 * 记录与 Git 暂存状态无关的内容证据。后续只有 HEAD 中的 blob 与这里完全一致，
 * 才能证明 Agent 最后一次可信写入已经进入提交；删除则用 missing 表示。
 */
export async function collectAttributedPathEvidence(
  repositoryPath: string,
  baseCommit: string,
  attributedPaths: string[],
  options: CollectAttributedPathEvidenceOptions = {},
): Promise<AttributedPathEvidence[]> {
  const git = options.gitExecutable ?? "git";
  const timeoutMs = options.timeoutMs ?? 5_000;
  const paths = concretePaths(attributedPaths);
  return Promise.all(paths.map(async (relativePath) => {
    const [baseEntry, attributedEntry] = await Promise.all([
      readTreeEntry(git, repositoryPath, baseCommit, relativePath, timeoutMs).catch(() => null),
      readWorkingEntry(git, repositoryPath, relativePath, timeoutMs).catch(() => null),
    ]);
    return { path: relativePath, baseEntry, attributedEntry };
  }));
}

/**
 * 只检查本次任务实际归因的文件。仓库中其他成员或 IDE 的脏文件不会阻止释放，
 * 但任一归因文件仍在工作区、证据缺失或 HEAD 不匹配时都保持等待。
 */
export async function evaluateTurnCompletionEvidence(
  input: TurnCompletionEvidenceInput,
  options: CollectAttributedPathEvidenceOptions = {},
): Promise<TurnCompletionEvidenceResult> {
  const git = options.gitExecutable ?? "git";
  const timeoutMs = options.timeoutMs ?? 5_000;
  const attributedPaths = concretePaths(input.attributedPaths);
  if (
    !input.attributionComplete
    || input.attributedPathsTruncated
    || attributedPaths.length !== new Set(input.attributedPaths.map(pathKey)).size
  ) {
    return { status: "incomplete", reason: "Attributed path evidence is empty, truncated, or non-concrete." };
  }

  const evidenceByPath = new Map<string, AttributedPathEvidence>();
  for (const evidence of input.baselineEvidence) {
    const key = pathKey(evidence.path);
    if (evidenceByPath.has(key)) {
      return { status: "incomplete", reason: `Duplicate completion evidence for ${evidence.path}.` };
    }
    evidenceByPath.set(key, evidence);
  }
  if (
    evidenceByPath.size !== attributedPaths.length
    || attributedPaths.some((candidate) => {
      const evidence = evidenceByPath.get(pathKey(candidate));
      return !evidence || evidence.baseEntry === null || evidence.attributedEntry === null;
    })
  ) {
    return { status: "incomplete", reason: "One or more attributed paths do not have complete content evidence." };
  }

  let branch: string;
  let headCommit: string;
  try {
    [branch, headCommit] = await Promise.all([
      runGit(git, input.repositoryPath, ["branch", "--show-current"], timeoutMs),
      runGit(git, input.repositoryPath, ["rev-parse", "HEAD"], timeoutMs),
    ]).then(([currentBranch, head]) => [currentBranch.trim(), head.trim()]);
  } catch (error) {
    return { status: "incomplete", reason: errorMessage(error) };
  }
  if (branch !== input.branch) {
    return { status: "incomplete", headCommit, reason: "The repository branch no longer matches the task baseline." };
  }

  const ancestor = await isAncestor(git, input.repositoryPath, input.baseCommit, headCommit, timeoutMs);
  if (ancestor !== true) {
    return {
      status: "incomplete",
      headCommit,
      reason: ancestor === false
        ? "The task base commit is not an ancestor of HEAD."
        : "Git could not verify the task base commit ancestry.",
    };
  }

  // PreToolUse 可能已经领取租约，但工具最终没有产生任何净写入；可信空集按完整回退处理。
  if (attributedPaths.length === 0) return { status: "reverted", headCommit };

  try {
    const dirty = await runGit(
      git,
      input.repositoryPath,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...attributedPaths],
      timeoutMs,
    );
    if (dirty.length > 0) {
      return { status: "awaiting_commit", headCommit, reason: "Attributed paths still have staged, unstaged, or untracked changes." };
    }
  } catch (error) {
    return { status: "incomplete", headCommit, reason: errorMessage(error) };
  }

  let headEntries: string[];
  try {
    headEntries = await Promise.all(attributedPaths.map((relativePath) =>
      readTreeEntry(git, input.repositoryPath, headCommit, relativePath, timeoutMs)));
  } catch (error) {
    return { status: "incomplete", headCommit, reason: errorMessage(error) };
  }
  let hasCommittedChange = false;
  for (const [index, relativePath] of attributedPaths.entries()) {
    const evidence = evidenceByPath.get(pathKey(relativePath))!;
    const headEntry = headEntries[index]!;
    if (headEntry === evidence.baseEntry) continue;
    if (headEntry === evidence.attributedEntry) {
      hasCommittedChange = true;
      continue;
    }
    return {
      status: "incomplete",
      headCommit,
      reason: `HEAD does not match the task baseline or last attributed content for ${relativePath}.`,
    };
  }
  return { status: hasCommittedChange ? "committed" : "reverted", headCommit };
}

async function readWorkingEntry(
  git: string,
  repositoryPath: string,
  relativePath: string,
  timeoutMs: number,
): Promise<string> {
  const absolute = path.resolve(repositoryPath, ...relativePath.split("/"));
  try {
    const entry = await lstat(absolute);
    if (!entry.isFile()) throw new Error(`Completion evidence only supports regular files: ${relativePath}.`);
  } catch (error) {
    if (isMissingFile(error)) return MISSING_GIT_ENTRY;
    throw error;
  }
  const oid = (await runGit(
    git,
    repositoryPath,
    ["hash-object", "--filters", `--path=${relativePath}`, "--", relativePath],
    timeoutMs,
  )).trim();
  if (!isObjectId(oid)) throw new Error(`Git returned invalid content evidence for ${relativePath}.`);
  return `blob:${oid}`;
}

async function readTreeEntry(
  git: string,
  repositoryPath: string,
  commit: string,
  relativePath: string,
  timeoutMs: number,
): Promise<string> {
  const output = await runGit(
    git,
    repositoryPath,
    ["ls-tree", "-z", commit, "--", relativePath],
    timeoutMs,
  );
  if (!output) return MISSING_GIT_ENTRY;
  const records = output.split("\0").filter(Boolean);
  const exact = records.find((record) => record.slice(record.indexOf("\t") + 1) === relativePath);
  if (!exact) return MISSING_GIT_ENTRY;
  const header = exact.slice(0, exact.indexOf("\t")).split(/\s+/);
  const type = header[1];
  const oid = header[2];
  if (type !== "blob" || !oid || !isObjectId(oid)) {
    throw new Error(`Git tree evidence is not a regular file for ${relativePath}.`);
  }
  return `blob:${oid}`;
}

async function isAncestor(
  git: string,
  repositoryPath: string,
  baseCommit: string,
  headCommit: string,
  timeoutMs: number,
): Promise<boolean | null> {
  try {
    await runGit(git, repositoryPath, ["merge-base", "--is-ancestor", baseCommit, headCommit], timeoutMs);
    return true;
  } catch (error) {
    return exitCode(error) === 1 ? false : null;
  }
}

async function runGit(
  executable: string,
  cwd: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  try {
    const result = await execFileAsync(executable, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    throw new Error(`Git completion check failed in ${cwd}: ${errorMessage(error)}`, { cause: error });
  }
}

function concretePaths(values: string[]): string[] {
  return [...new Map(values.map((value) => {
    const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    return [pathKey(normalized), normalized] as const;
  }).filter(([, value]) => Boolean(value) && value !== ".")).values()];
}

function pathKey(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "")
    .toLocaleLowerCase("en-US");
}

function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value);
}

function exitCode(error: unknown): number | undefined {
  if (!(error instanceof Error) || !("cause" in error)) return undefined;
  const cause = error.cause;
  if (!cause || typeof cause !== "object" || !("code" in cause)) return undefined;
  return typeof cause.code === "number" ? cause.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
