import { createHash } from "node:crypto";
import { parsePowerShellWriteTargets } from "./powershell-path-parser.js";

export type EditPrecision = "symbol" | "resource" | "path";
export type EditOperation = "add" | "update" | "delete" | "move" | "generate";

export interface AttributedEditTarget {
  pathCandidate: string;
  operation: EditOperation;
  precision: EditPrecision;
  symbols: string[];
}

export interface AttributedWriteIntent {
  writes: boolean;
  pathCandidates: string[];
  targets: AttributedEditTarget[];
  proposalHash: string | null;
  attributedSideEffects: boolean;
  pathDiagnostics: string[];
}

export interface ChangeFingerprintState {
  changedPaths: string[];
  changedPathFingerprints: Record<string, string>;
}

const SHELL_WRITE_COMMAND = /(?:^|[\s;&|])(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|del|erase|move|copy|xcopy|robocopy|rm|mv|cp|touch|mkdir|tee)(?:\s|$)/i;
const KNOWN_SIDE_EFFECT_COMMAND = /(?:gen[_-]?luban|\bluban\b|prettier[^\r\n]*--write|eslint[^\r\n]*--fix|dotnet\s+format|cargo\s+fmt|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|generate|gen|format)\b)/i;

export function extractAttributedWriteIntent(
  toolName: string | undefined,
  toolInput: unknown,
): AttributedWriteIntent {
  const command = isRecord(toolInput) && typeof toolInput.command === "string"
    ? toolInput.command
    : "";
  if (toolName === "apply_patch") return extractPatchIntent(command);
  if (toolName !== "Bash" || !isPotentialWriteCommand(command)) return emptyIntent();

  const attributedSideEffects = KNOWN_SIDE_EFFECT_COMMAND.test(command);
  // 构建器、生成器与格式化器的真实输出只能由 PostToolUse Git 差异确认，
  // 对这类纯副作用命令启动 PowerShell AST 既得不到路径，也会把冷启动超时误报为路径诊断。
  const parsed = requiresPowerShellPathParsing(command)
    ? parsePowerShellWriteTargets(command)
    : { pathCandidates: [], targets: [], diagnostics: [] };
  const pathCandidates = parsed.pathCandidates;
  const targets = parsed.targets.map((target) => ({
    pathCandidate: target.pathCandidate,
    operation: attributedSideEffects ? "generate" as const : target.operation,
    precision: resourcePrecision(target.pathCandidate),
    symbols: [],
  }));
  return {
    writes: true,
    pathCandidates,
    targets,
    proposalHash: proposalHash(toolName, command),
    attributedSideEffects,
    pathDiagnostics: parsed.diagnostics,
  };
}

export function attributedChangedPaths(
  before: ChangeFingerprintState,
  after: ChangeFingerprintState,
  repositoryTargets: string[],
  attributedSideEffects: boolean,
): { attributed: string[]; external: string[] } {
  // 恢复为干净状态或删除初始未跟踪文件时，路径只存在于 before；并集才能保留这类真实写入。
  const changedSinceBaseline = unique([...after.changedPaths, ...before.changedPaths]).filter((candidate) => {
    const key = pathKey(candidate);
    return before.changedPathFingerprints[key] !== after.changedPathFingerprints[key];
  });
  const targets = repositoryTargets.map(pathKey);
  const attributed: string[] = [];
  const external: string[] = [];
  for (const candidate of changedSinceBaseline) {
    const key = pathKey(candidate);
    const matchesTarget = targets.some((scope) => pathScopeCovers(scope, key));
    if (matchesTarget || attributedSideEffects) attributed.push(candidate);
    else external.push(candidate);
  }
  return { attributed: unique(attributed), external: unique(external) };
}

export function extractShellPathCandidates(command: string): string[] {
  return parsePowerShellWriteTargets(command).pathCandidates;
}

function extractPatchIntent(command: string): AttributedWriteIntent {
  const targets: AttributedEditTarget[] = [];
  let active: AttributedEditTarget | undefined;
  for (const line of command.split(/\r?\n/)) {
    const file = line.match(/^\*\*\* (Add|Update|Delete) File:\s*(.+)$/);
    if (file?.[1] && file[2]) {
      active = {
        pathCandidate: file[2].trim(),
        operation: file[1].toLocaleLowerCase("en-US") as "add" | "update" | "delete",
        precision: resourcePrecision(file[2].trim()),
        symbols: [],
      };
      targets.push(active);
      continue;
    }
    const move = line.match(/^\*\*\* Move to:\s*(.+)$/);
    if (move?.[1]) {
      active = {
        pathCandidate: move[1].trim(),
        operation: "move",
        precision: resourcePrecision(move[1].trim()),
        symbols: [],
      };
      targets.push(active);
      continue;
    }
    if (!active || (!line.startsWith("+") && !line.startsWith("-"))) continue;
    active.symbols.push(...extractSymbols(line.slice(1)));
  }
  for (const target of targets) {
    target.symbols = unique(target.symbols).slice(0, 100);
    if (
      target.operation === "update"
      && target.precision === "path"
      && isSourcePath(target.pathCandidate)
      && target.symbols.length > 0
    ) {
      target.precision = "symbol";
    }
  }
  const pathCandidates = unique(targets.map((target) => target.pathCandidate));
  return {
    writes: true,
    pathCandidates,
    targets,
    proposalHash: proposalHash("apply_patch", command),
    attributedSideEffects: false,
    pathDiagnostics: [],
  };
}

function extractSymbols(line: string): string[] {
  const symbols: string[] = [];
  const declarationPatterns = [
    /\b(?:class|interface|struct|record|enum|namespace)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
    /\b(?:function|def|func|fn|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /^\s*(?:(?:export|default|declare|public|private|protected|internal|static|virtual|override|async|sealed|abstract|partial|readonly|extern|new)\s+)*(?:get\s+|set\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>{};]*>)?\s*\([^)]*\)\s*(?::[^={;]+)?\s*(?:\{|=>)/g,
    /^\s*(?!(?:return|throw|yield|await|new|if|for|foreach|while|switch|catch|using|lock)\b)(?:(?:export|default|declare|public|private|protected|internal|static|virtual|override|async|sealed|abstract|partial|readonly|extern|new)\s+)*(?:[A-Za-z_$][A-Za-z0-9_$<>,.?\[\]]*\s+)+([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*(?:\{|=>|;|where\b)/g,
  ];
  for (const pattern of declarationPatterns) {
    for (const match of line.matchAll(pattern)) if (match[1]) symbols.push(match[1]);
  }
  return unique(symbols);
}

function isPotentialWriteCommand(command: string): boolean {
  return SHELL_WRITE_COMMAND.test(command)
    || /(?:^|\s)(?:sed\s+-[^\r\n]*i|perl\s+-[^\r\n]*pi)(?:\s|$)/i.test(command)
    || /(?:^|\s)git\s+(?:apply|checkout|restore|clean|reset)(?:\s|$)/i.test(command)
    || /(?:^|\s)(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall|update|run\s+(?:build|generate|gen|format))(?:\s|$)/i.test(command)
    || KNOWN_SIDE_EFFECT_COMMAND.test(command)
    || /(^|[^<>])>{1,2}(?!=)/m.test(command);
}

function requiresPowerShellPathParsing(command: string): boolean {
  return SHELL_WRITE_COMMAND.test(command) || /(^|[^<>])>{1,2}(?!=)/m.test(command);
}

function resourcePrecision(pathCandidate: string): EditPrecision {
  return /\.(?:anim|asset|controller|lighting|mat|meta|overridecontroller|physicmaterial|playable|prefab|rendertexture|unity)$/i.test(pathCandidate)
    ? "resource"
    : "path";
}

function isSourcePath(pathCandidate: string): boolean {
  return /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|py|rs|ts|tsx)$/i.test(pathCandidate);
}

function proposalHash(toolName: string | undefined, command: string): string {
  return createHash("sha256")
    .update(`${toolName ?? "unknown"}\0${command.replace(/\r\n/g, "\n").trim()}`, "utf8")
    .digest("hex");
}

function emptyIntent(): AttributedWriteIntent {
  return {
    writes: false,
    pathCandidates: [],
    targets: [],
    proposalHash: null,
    attributedSideEffects: false,
    pathDiagnostics: [],
  };
}

function pathScopeCovers(scope: string, candidate: string): boolean {
  const normalizedScope = scope.replace(/\/$/, "");
  const normalizedCandidate = candidate.replace(/\/$/, "");
  return normalizedScope === "."
    || normalizedScope === normalizedCandidate
    || normalizedCandidate.startsWith(`${normalizedScope}/`);
}

function pathKey(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").toLocaleLowerCase("en-US");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
