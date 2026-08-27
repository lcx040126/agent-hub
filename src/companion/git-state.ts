import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitWorkingState {
  repositoryRoot: string;
  branch: string;
  headCommit: string;
  changedPaths: string[];
  changedPathFingerprints: Record<string, string>;
}

export type GitIdentity = Pick<GitWorkingState, "repositoryRoot" | "branch" | "headCommit">;

export interface GitWorkingStateOptions {
  gitExecutable?: string;
}

export async function inspectGitWorkingState(
  selectedPath: string,
  options: GitWorkingStateOptions = {},
): Promise<GitWorkingState> {
  const git = options.gitExecutable ?? "git";
  const identity = await inspectGitIdentity(selectedPath, options);
  return inspectGitWorkingStateFromIdentity(identity, { gitExecutable: git });
}

export async function inspectGitWorkingStateFromIdentity(
  identity: GitIdentity,
  options: GitWorkingStateOptions = {},
): Promise<GitWorkingState> {
  const git = options.gitExecutable ?? "git";
  const [unstaged, staged, untracked] = await Promise.all([
    safeGit(git, identity.repositoryRoot, ["diff", "--name-only", "-z"]),
    safeGit(git, identity.repositoryRoot, ["diff", "--cached", "--name-only", "-z"]),
    safeGit(git, identity.repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return buildWorkingState(identity, unstaged, staged, untracked);
}

export async function inspectGitIdentity(
  selectedPath: string,
  options: GitWorkingStateOptions = {},
): Promise<GitIdentity> {
  const git = options.gitExecutable ?? "git";
  const cwd = await realpath(selectedPath);
  const root = await runGit(git, cwd, ["rev-parse", "--show-toplevel"]);
  const repositoryRoot = await realpath(root.trim());
  const [branch, headCommit] = await Promise.all([
    safeGit(git, repositoryRoot, ["branch", "--show-current"]),
    runGit(git, repositoryRoot, ["rev-parse", "HEAD"]),
  ]);
  return {
    repositoryRoot,
    branch: branch?.trim() || "(detached)",
    headCommit: headCommit.trim(),
  };
}

export async function inspectGitWorkingPaths(
  selectedPath: string,
  repositoryPaths: string[],
  options: GitWorkingStateOptions = {},
): Promise<GitWorkingState> {
  const git = options.gitExecutable ?? "git";
  const identity = await inspectGitIdentity(selectedPath, options);
  return inspectGitWorkingPathsFromIdentity(identity, repositoryPaths, { gitExecutable: git });
}

export async function inspectGitWorkingPathsFromIdentity(
  identity: GitIdentity,
  repositoryPaths: string[],
  options: GitWorkingStateOptions = {},
): Promise<GitWorkingState> {
  const git = options.gitExecutable ?? "git";
  const paths = [...new Set(repositoryPaths.map((value) => value.trim()).filter(Boolean))];
  if (paths.length === 0) return { ...identity, changedPaths: [], changedPathFingerprints: {} };
  const pathspec = ["--", ...paths];
  const [unstaged, staged, untracked] = await Promise.all([
    safeGit(git, identity.repositoryRoot, ["diff", "--name-only", "-z", ...pathspec]),
    safeGit(git, identity.repositoryRoot, ["diff", "--cached", "--name-only", "-z", ...pathspec]),
    safeGit(git, identity.repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z", ...pathspec]),
  ]);
  return buildWorkingState(identity, unstaged, staged, untracked);
}

async function buildWorkingState(
  identity: GitIdentity,
  unstaged: string | null,
  staged: string | null,
  untracked: string | null,
): Promise<GitWorkingState> {
  const { repositoryRoot } = identity;

  const unstagedPaths = uniqueNullSeparated([unstaged]);
  const stagedPaths = uniqueNullSeparated([staged]);
  const untrackedPaths = uniqueNullSeparated([untracked]);
  const changedPaths = uniqueNullSeparated([unstaged, staged, untracked]);
  return {
    ...identity,
    changedPaths,
    changedPathFingerprints: await fingerprintChangedPaths(repositoryRoot, changedPaths, {
      unstaged: new Set(unstagedPaths.map(pathKey)),
      staged: new Set(stagedPaths.map(pathKey)),
      untracked: new Set(untrackedPaths.map(pathKey)),
    }),
  };
}

export function isPathInside(parentPath: string, candidatePath: string): boolean {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function toRepositoryRelativePath(
  repositoryRoot: string,
  cwd: string,
  candidate: string,
): string | null {
  const cleaned = candidate
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/:\d+(?::\d+)?$/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") return null;

  const absolute = path.isAbsolute(cleaned)
    ? path.resolve(cleaned)
    : path.resolve(cwd, cleaned);
  if (!isPathInside(repositoryRoot, absolute)) return null;
  const relative = path.relative(repositoryRoot, absolute).replaceAll(path.sep, "/");
  return relative || ".";
}

async function runGit(executable: string, cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(executable, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Git command failed in ${cwd}: ${detail}`);
  }
}

async function safeGit(executable: string, cwd: string, args: string[]): Promise<string | null> {
  try {
    return await runGit(executable, cwd, args);
  } catch {
    return null;
  }
}

function uniqueNullSeparated(outputs: Array<string | null>): string[] {
  return [...new Set(
    outputs
      .flatMap((output) => (output ?? "").split("\0"))
      .map((item) => item.trim().replaceAll("\\", "/"))
      .filter(Boolean),
  )].sort((left, right) => left.localeCompare(right, "en-US"));
}

async function fingerprintChangedPaths(
  repositoryRoot: string,
  changedPaths: string[],
  statuses: { unstaged: Set<string>; staged: Set<string>; untracked: Set<string> },
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, changedPaths.length) }, async () => {
    while (cursor < changedPaths.length) {
      const relativePath = changedPaths[cursor++];
      if (!relativePath) continue;
      const key = pathKey(relativePath);
      result[key] = await fingerprintPath(repositoryRoot, relativePath, [
        statuses.unstaged.has(key) ? "unstaged" : "",
        statuses.staged.has(key) ? "staged" : "",
        statuses.untracked.has(key) ? "untracked" : "",
      ].filter(Boolean).join(","));
    }
  });
  await Promise.all(workers);
  return result;
}

async function fingerprintPath(
  repositoryRoot: string,
  relativePath: string,
  status: string,
): Promise<string> {
  const target = path.resolve(repositoryRoot, ...relativePath.split("/"));
  const fingerprint = createHash("sha256").update(`status:${status}\0`);
  try {
    const entry = await lstat(target);
    fingerprint.update(`mode:${entry.mode}\0`);
    if (entry.isSymbolicLink()) {
      fingerprint.update(`symlink:${await readlink(target)}`);
    } else if (entry.isFile()) {
      for await (const chunk of createReadStream(target)) fingerprint.update(chunk as Buffer);
    } else if (entry.isDirectory()) {
      fingerprint.update("directory");
    } else {
      fingerprint.update(`other:${entry.size}:${entry.mtimeMs}`);
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    fingerprint.update("missing");
  }
  return fingerprint.digest("hex");
}

function pathKey(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").toLocaleLowerCase("en-US");
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
