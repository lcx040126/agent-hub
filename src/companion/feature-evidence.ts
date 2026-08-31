import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { formatGitExecutionError, resolveGitExecutable } from "./git-executable.js";

const execFileAsync = promisify(execFile);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export interface FeatureCommitEvidence {
  hash: string;
  author: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
}

export interface FeatureSymbolEvidence {
  path: string;
  symbol: string;
}

export interface FeatureGitEvidence {
  repositoryRoot: string;
  branch: string;
  baseCommit: string;
  finalCommit: string;
  committed: boolean;
  committedPaths: string[];
  uncommittedPaths: string[];
  changedPaths: string[];
  commits: FeatureCommitEvidence[];
  diffSummary: string;
  diffSha256: string;
  symbols: string[];
  symbolLocations: FeatureSymbolEvidence[];
  dependencies: string[];
  relatedTests: string[];
  inferredSystems: string[];
}

export interface CollectFeatureEvidenceOptions {
  gitExecutable?: string;
  includePaths?: readonly string[];
}

export async function collectFeatureGitEvidence(
  repositoryRoot: string,
  baseCommit: string,
  options: CollectFeatureEvidenceOptions = {},
): Promise<FeatureGitEvidence> {
  const git = resolveGitExecutable(options.gitExecutable);
  const root = path.resolve(repositoryRoot);
  const includedPathKeys = options.includePaths === undefined
    ? undefined
    : new Set(options.includePaths.map(pathKey).filter(Boolean));
  const [branch, finalCommit] = await Promise.all([
    safeGit(git, root, ["branch", "--show-current"]),
    runGit(git, root, ["rev-parse", "HEAD"]),
  ]);
  await runGit(git, root, ["cat-file", "-e", `${baseCommit}^{commit}`]);
  const headChanged = finalCommit.trim() !== baseCommit.trim();
  const [committedNames, unstagedNames, stagedNames, untrackedNames] = await Promise.all([
    headChanged ? safeGit(git, root, ["diff", "--name-only", "-z", `${baseCommit}..${finalCommit.trim()}`]) : Promise.resolve(""),
    safeGit(git, root, ["diff", "--name-only", "-z"]),
    safeGit(git, root, ["diff", "--cached", "--name-only", "-z"]),
    safeGit(git, root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);

  const committedPaths = filterIncluded(splitNull(committedNames), includedPathKeys);
  const uncommittedPaths = filterIncluded(
    unique([...splitNull(unstagedNames), ...splitNull(stagedNames), ...splitNull(untrackedNames)]),
    includedPathKeys,
  );
  const changedPaths = unique([...committedPaths, ...uncommittedPaths]);
  const committed = committedPaths.length > 0;
  const pathArguments = changedPaths.length > 0 ? ["--", ...changedPaths] : [];
  const [commitLog, committedDiff, workingDiff, diffSummary] = await Promise.all([
    committed
      ? safeGit(git, root, ["log", "-z", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s", `${baseCommit}..${finalCommit.trim()}`, ...pathArguments])
      : Promise.resolve(""),
    committed
      ? safeGit(git, root, ["diff", "--no-ext-diff", "--unified=0", `${baseCommit}..${finalCommit.trim()}`, ...pathArguments])
      : Promise.resolve(""),
    changedPaths.length > 0
      ? safeGit(git, root, ["diff", "--no-ext-diff", "--unified=0", "HEAD", ...pathArguments])
      : Promise.resolve(""),
    changedPaths.length > 0
      ? safeGit(git, root, ["diff", "--stat", `${baseCommit}`, ...pathArguments])
      : Promise.resolve(""),
  ]);
  const analysis = await analyzeChangedSources(root, changedPaths);
  const evidenceText = [
    `base:${baseCommit.trim()}`,
    `final:${finalCommit.trim()}`,
    committedDiff,
    workingDiff,
    ...uncommittedPaths.map((value) => `uncommitted:${value}`),
  ].join("\n");

  return {
    repositoryRoot: root,
    branch: branch.trim() || "(detached)",
    baseCommit: baseCommit.trim(),
    finalCommit: finalCommit.trim(),
    committed,
    committedPaths,
    uncommittedPaths,
    changedPaths,
    commits: parseCommitLog(commitLog),
    diffSummary: diffSummary.trim(),
    diffSha256: createHash("sha256").update(evidenceText, "utf8").digest("hex"),
    ...analysis,
  };
}

async function analyzeChangedSources(repositoryRoot: string, changedPaths: string[]): Promise<{
  symbols: string[];
  symbolLocations: FeatureSymbolEvidence[];
  dependencies: string[];
  relatedTests: string[];
  inferredSystems: string[];
}> {
  const symbols: string[] = [];
  const symbolLocations: FeatureSymbolEvidence[] = [];
  const dependencies: string[] = [];
  const relatedTests: string[] = [];
  const inferredSystems: string[] = [];
  for (const relativePath of changedPaths.slice(0, 500)) {
    if (isTestPath(relativePath)) relatedTests.push(relativePath);
    const system = inferSystem(relativePath);
    if (system) inferredSystems.push(system);
    if (!/\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|py|rs|ts|tsx)$/i.test(relativePath)) continue;
    const absolutePath = path.resolve(repositoryRoot, ...relativePath.split("/"));
    try {
      const info = await stat(absolutePath);
      if (!info.isFile() || info.size > MAX_SOURCE_BYTES) continue;
      const source = await readFile(absolutePath, "utf8");
      const sourceSymbols = extractSourceSymbols(source);
      symbols.push(...sourceSymbols);
      symbolLocations.push(...sourceSymbols.map((symbol) => ({ path: relativePath, symbol })));
      dependencies.push(...extractDependencies(source));
    } catch {
      // Deleted files remain part of Git evidence even when source analysis is unavailable.
    }
  }
  return {
    symbols: unique(symbols).slice(0, 1_000),
    symbolLocations: uniqueSymbolLocations(symbolLocations).slice(0, 1_000),
    dependencies: unique(dependencies).slice(0, 1_000),
    relatedTests: unique(relatedTests),
    inferredSystems: unique(inferredSystems),
  };
}

export function extractSourceSymbols(source: string): string[] {
  const symbols: string[] = [];
  const patterns = [
    /\b(?:class|interface|struct|record|enum|namespace)\s+([A-Za-z_$][A-Za-z0-9_.$]*)/g,
    /\b(?:function|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\b(?:public|private|protected|internal|static|virtual|override|async|sealed|abstract|partial|readonly|extern|new|\s)+\s*[A-Za-z_$][A-Za-z0-9_$<>,.?\[\]\s]*\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) if (match[1]) symbols.push(match[1]);
  }
  return unique(symbols);
}

export function extractDependencies(source: string): string[] {
  const dependencies: string[] = [];
  const patterns = [
    /^\s*using\s+([A-Za-z_][A-Za-z0-9_.]*);/gm,
    /^\s*import\s+.*?\s+from\s+["']([^"']+)["']/gm,
    /^\s*import\s+["']([^"']+)["']/gm,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) if (match[1]) dependencies.push(match[1]);
  }
  return unique(dependencies);
}

function parseCommitLog(value: string): FeatureCommitEvidence[] {
  return value.split("\0").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [hash = "", author = "", authorEmail = "", authoredAt = "", ...subject] = entry.split("\x1f");
    return { hash, author, authorEmail, authoredAt, subject: subject.join("\x1f") };
  }).filter((entry) => /^[0-9a-f]{7,64}$/i.test(entry.hash));
}

function splitNull(value: string): string[] {
  return unique(value.split("\0").map((entry) => entry.trim().replaceAll("\\", "/")).filter(Boolean));
}

function filterIncluded(values: string[], includedPathKeys: Set<string> | undefined): string[] {
  if (includedPathKeys === undefined) return values;
  return values.filter((value) => includedPathKeys.has(pathKey(value)));
}

function pathKey(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "").toLocaleLowerCase("en-US");
}

function isTestPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/i.test(normalized)
    || /(?:\.test|\.spec|tests?)\.[^.\/]+$/i.test(normalized);
}

function inferSystem(value: string): string | undefined {
  const parts = value.replaceAll("\\", "/").split("/").filter(Boolean);
  const ignored = new Set(["assets", "src", "source", "scripts", "packages", "projectsettings", "tests", "test"]);
  return parts.map((part) => part.replace(/\.[^.]+$/, "")).find((part) => !ignored.has(part.toLocaleLowerCase("en-US")))?.toLocaleLowerCase("en-US");
}

async function runGit(executable: string, cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(executable, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    const detail = formatGitExecutionError(error, executable);
    throw new Error(`Git evidence command failed in ${cwd}: ${detail}`);
  }
}

async function safeGit(executable: string, cwd: string, args: string[]): Promise<string> {
  try {
    return await runGit(executable, cwd, args);
  } catch {
    return "";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((entry) => entry.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right, "en-US"));
}

function uniqueSymbolLocations(values: FeatureSymbolEvidence[]): FeatureSymbolEvidence[] {
  const result = new Map<string, FeatureSymbolEvidence>();
  for (const value of values) {
    const symbol = value.symbol.trim();
    const relativePath = value.path.trim().replaceAll("\\", "/");
    if (!symbol || !relativePath) continue;
    result.set(`${pathKey(relativePath)}\0${symbol.toLocaleLowerCase("en-US")}`, {
      path: relativePath,
      symbol,
    });
  }
  return [...result.values()].sort((left, right) =>
    left.path.localeCompare(right.path, "en-US") || left.symbol.localeCompare(right.symbol, "en-US"));
}
