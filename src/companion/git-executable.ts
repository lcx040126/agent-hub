import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GitExecutableResolutionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  isFile?: (candidate: string) => boolean;
  readDirectories?: (directory: string) => Dirent[];
}

export class GitExecutableUnavailableError extends Error {
  readonly code = "AGENT_HUB_GIT_UNAVAILABLE";
  readonly candidates: string[];

  constructor(candidates: string[]) {
    super(
      "Agent Hub 未找到可用的 Git。请安装 Git for Windows，或将 Git 加入 PATH 后重启 Agent Hub。"
        + ` 已检查 ${candidates.length} 个位置。`,
    );
    this.name = "GitExecutableUnavailableError";
    this.candidates = candidates;
  }
}

export function formatGitExecutionError(error: unknown, executable: string): string {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (code === "ENOENT") {
    return "Agent Hub 无法启动 Git。请确认 Git 已安装、已加入 PATH，并在修改环境变量后重启 Agent Hub。";
  }
  if (code === "EACCES" || code === "EPERM") {
    return `Agent Hub 找到了 Git，但当前进程没有权限执行 ${executable}。请检查文件权限或安全软件拦截。`;
  }
  return error instanceof Error ? error.message : String(error);
}

let cachedDefaultGitExecutable: string | undefined;

/** Resolve Git once at the process boundary so every repository operation uses the same executable. */
export function resolveGitExecutable(
  explicit?: string,
  options: GitExecutableResolutionOptions = {},
): string {
  const usesProcessDefaults = explicit === undefined
    && options.platform === undefined
    && options.env === undefined
    && options.homeDirectory === undefined
    && options.isFile === undefined
    && options.readDirectories === undefined;
  if (usesProcessDefaults && cachedDefaultGitExecutable) return cachedDefaultGitExecutable;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const isFile = options.isFile ?? defaultIsFile;
  const candidates = candidateGitPaths(
    platform,
    env,
    homeDirectory,
    explicit ?? env.AGENT_HUB_GIT_EXECUTABLE,
    options.readDirectories,
  );
  for (const candidate of candidates) {
    if (isFile(candidate)) {
      if (usesProcessDefaults) cachedDefaultGitExecutable = candidate;
      return candidate;
    }
  }
  throw new GitExecutableUnavailableError(candidates);
}

export function candidateGitPaths(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
  explicit?: string,
  readDirectories: (directory: string) => Dirent[] = (directory) => readdirSync(directory, { withFileTypes: true }),
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const candidates: string[] = [];
  const add = (value: string | undefined) => {
    const trimmed = value?.trim().replace(/^"|"$/g, "");
    if (!trimmed) return;
    const resolved = pathApi.resolve(trimmed);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };

  if (explicit) add(explicit);

  const pathValue = env.PATH ?? (platform === "win32" ? env.Path : undefined) ?? "";
  for (const entry of pathValue.split(platform === "win32" ? ";" : ":")) {
    if (!entry.trim()) continue;
    add(pathApi.join(entry, platform === "win32" ? "git.exe" : "git"));
  }

  if (platform !== "win32") return candidates;

  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = env.LOCALAPPDATA ?? pathApi.join(homeDirectory, "AppData", "Local");
  for (const root of [programFiles, programFilesX86, pathApi.join(localAppData, "Programs")]) {
    add(pathApi.join(root, "Git", "cmd", "git.exe"));
    add(pathApi.join(root, "Git", "bin", "git.exe"));
  }

  const ugitRoot = pathApi.join(localAppData, "UGit");
  let versions: string[] = [];
  try {
    versions = readDirectories(ugitRoot)
      .filter((entry) => entry.isDirectory() && /^app-/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {
    // UGit is optional; an absent install is handled by the final diagnostic.
  }
  for (const version of versions) {
    const root = pathApi.join(ugitRoot, version, "resources", "app", "git");
    add(pathApi.join(root, "cmd", "git.exe"));
    add(pathApi.join(root, "bin", "git.exe"));
  }

  return candidates;
}

function defaultIsFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile() && existsSync(candidate);
  } catch {
    return false;
  }
}
