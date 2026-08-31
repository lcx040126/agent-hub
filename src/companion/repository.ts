import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import csharp from "@ast-grep/lang-csharp";
import { parse, registerDynamicLanguage, type SgNode } from "@ast-grep/napi";
import { formatGitExecutionError, resolveGitExecutable } from "./git-executable.js";

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 1_500_000;
const MAX_TRACKED_FILES = 30_000;

// Rust cannot load a parser from Electron's virtual asar path. electron-builder
// places this package in app.asar.unpacked, so point ast-grep at the physical file.
registerDynamicLanguage({
  csharp: {
    ...csharp,
    libraryPath: resolveAsarUnpackedPath(csharp.libraryPath),
  },
});

export function resolveAsarUnpackedPath(value: string): string {
  return value.replace(/([\\/])app\.asar([\\/])/i, "$1app.asar.unpacked$2");
}

export interface RepositoryIdentity {
  root: string;
  name: string;
  remote: string | null;
  branch: string;
  headCommit: string;
  rootCommit: string;
  fingerprint: string;
}

export interface RuleFileSummary {
  path: string;
  sha256: string;
  bytes: number;
}

export interface CodeFileSummary {
  path: string;
  systemId: string;
  namespace: string | null;
  imports: string[];
  declarations: string[];
  publicContracts: string[];
}

export interface SystemSummary {
  id: string;
  name: string;
  paths: string[];
  fileCount: number;
  changedFileCount: number;
  publicContracts: string[];
}

export type DependencyKind = "code" | "unity_asset" | "assembly" | "history";

export interface DependencyEdge {
  fromSystemId: string;
  toSystemId: string;
  kind: DependencyKind;
  confidence: number;
  evidenceCount: number;
}

export interface RepositorySnapshot {
  repository: RepositoryIdentity;
  generatedAt: string;
  changedPaths: string[];
  ruleFiles: RuleFileSummary[];
  systems: SystemSummary[];
  dependencies: DependencyEdge[];
  impactedSystemIds: string[];
  analysis: {
    trackedFileCount: number;
    parsedCSharpFileCount: number;
    unityReferenceCount: number;
    historyCommitCount: number;
    truncated: boolean;
  };
}

export interface InspectRepositoryOptions {
  gitExecutable?: string;
  historyCommitLimit?: number;
}

type MutableEdge = DependencyEdge;

function normalizeSlash(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeRemote(remote: string): string {
  return remote
    .trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLocaleLowerCase("en-US");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function systemNameFromId(id: string): string {
  const segments = id.split("/");
  return segments.at(-1) ?? id;
}

export function inferSystemId(filePath: string): string {
  const normalized = normalizeSlash(filePath);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return ".";

  if (segments[0].toLocaleLowerCase("en-US") === "assets") {
    if (segments.length >= 3) return segments.slice(0, 3).join("/");
    return segments.slice(0, 2).join("/");
  }
  if (segments[0].toLocaleLowerCase("en-US") === "packages") {
    return segments.slice(0, 2).join("/");
  }
  if (segments.length >= 2) return segments.slice(0, 2).join("/");
  return segments[0];
}

function declarationName(node: SgNode): string | null {
  return node.find({ rule: { kind: "identifier" } })?.text() ?? null;
}

function namespaceText(node: SgNode): string | null {
  const candidate = node.namedChildren().find((child) =>
    ["identifier", "qualified_name"].includes(String(child.kind())),
  );
  return candidate?.text() ?? null;
}

function cleanUsing(text: string): string | null {
  const withoutKeyword = text
    .replace(/^global\s+using\s+/, "")
    .replace(/^using\s+/, "")
    .replace(/;\s*$/, "")
    .trim();
  if (!withoutKeyword || withoutKeyword.startsWith("static ")) return null;
  const aliasParts = withoutKeyword.split("=");
  return (aliasParts.at(-1) ?? "").trim() || null;
}

export function analyzeCSharpSource(filePath: string, source: string): CodeFileSummary {
  const root = parse("csharp", source).root();
  const namespaceNode =
    root.find({ rule: { kind: "file_scoped_namespace_declaration" } }) ??
    root.find({ rule: { kind: "namespace_declaration" } });
  const namespace = namespaceNode ? namespaceText(namespaceNode) : null;
  const imports = unique(
    root
      .findAll({ rule: { kind: "using_directive" } })
      .map((node) => cleanUsing(node.text()))
      .filter((value): value is string => Boolean(value)),
  );

  const declarationKinds = [
    "class_declaration",
    "interface_declaration",
    "struct_declaration",
    "record_declaration",
    "enum_declaration",
  ];
  const declarations: string[] = [];
  for (const kind of declarationKinds) {
    for (const node of root.findAll({ rule: { kind } })) {
      const name = declarationName(node);
      if (name) declarations.push(namespace ? `${namespace}.${name}` : name);
    }
  }

  const contractKinds = [
    "method_declaration",
    "property_declaration",
    "event_declaration",
    "delegate_declaration",
  ];
  const publicContracts: string[] = [];
  for (const kind of contractKinds) {
    for (const node of root.findAll({ rule: { kind } })) {
      const text = node.text().trim();
      if (!/^(?:\[[^\]]+\]\s*)*(?:public|protected)\b/.test(text)) continue;
      const name = declarationName(node);
      if (name) publicContracts.push(name);
    }
  }

  return {
    path: normalizeSlash(filePath),
    systemId: inferSystemId(filePath),
    namespace,
    imports,
    declarations: unique(declarations),
    publicContracts: unique(publicContracts),
  };
}

async function runGit(
  gitExecutable: string,
  repositoryPath: string,
  args: string[],
  maxBuffer = 16 * 1024 * 1024,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(gitExecutable, ["-C", repositoryPath, ...args], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer,
    });
    return stdout;
  } catch (error) {
    throw new Error(formatGitExecutionError(error, gitExecutable), { cause: error });
  }
}

async function safeGit(
  gitExecutable: string,
  repositoryPath: string,
  args: string[],
): Promise<string | null> {
  try {
    return (await runGit(gitExecutable, repositoryPath, args)).trim();
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function discoverRules(repositoryRoot: string, trackedFiles: string[]): Promise<RuleFileSummary[]> {
  const candidates = new Set<string>();
  for (const trackedFile of trackedFiles) {
    const lower = trackedFile.toLocaleLowerCase("en-US");
    if (
      lower.endsWith("/agents.md") ||
      lower.endsWith("/agentrules.md") ||
      lower.endsWith("/agent-rules.md") ||
      lower === "agents.md" ||
      lower === "agentrules.md" ||
      lower === "rule.md" ||
      lower === "assets/projectrules/readme.md"
    ) {
      candidates.add(trackedFile);
    }
  }

  const summaries: RuleFileSummary[] = [];
  for (const candidate of [...candidates].sort()) {
    const absolute = path.join(repositoryRoot, candidate);
    if (!(await fileExists(absolute))) continue;
    const content = await readFile(absolute);
    summaries.push({ path: normalizeSlash(candidate), sha256: sha256(content), bytes: content.length });
  }
  return summaries;
}

function addEdge(
  edges: Map<string, MutableEdge>,
  fromSystemId: string,
  toSystemId: string,
  kind: DependencyKind,
  confidence: number,
  count = 1,
): void {
  if (!fromSystemId || !toSystemId || fromSystemId === toSystemId) return;
  const key = `${fromSystemId}\u0000${toSystemId}\u0000${kind}`;
  const existing = edges.get(key);
  if (existing) {
    existing.evidenceCount += count;
    existing.confidence = Math.max(existing.confidence, confidence);
    return;
  }
  edges.set(key, { fromSystemId, toSystemId, kind, confidence, evidenceCount: count });
}

function parseChangedPaths(outputs: Array<string | null>): string[] {
  return unique(
    outputs.flatMap((output) =>
      output ? output.split("\0").filter(Boolean).map(normalizeSlash) : [],
    ),
  );
}

function findNamespaceTarget(
  importedNamespace: string,
  namespaceSystems: Map<string, Set<string>>,
): Set<string> {
  let bestLength = -1;
  const result = new Set<string>();
  for (const [candidate, systems] of namespaceSystems) {
    if (
      importedNamespace !== candidate &&
      !importedNamespace.startsWith(`${candidate}.`) &&
      !candidate.startsWith(`${importedNamespace}.`)
    ) {
      continue;
    }
    if (candidate.length < bestLength) continue;
    if (candidate.length > bestLength) {
      result.clear();
      bestLength = candidate.length;
    }
    for (const system of systems) result.add(system);
  }
  return result;
}

async function inspectUnityReferences(
  repositoryRoot: string,
  trackedFiles: string[],
  edges: Map<string, MutableEdge>,
): Promise<number> {
  const guidToPath = new Map<string, string>();
  const metaFiles = trackedFiles.filter((file) => file.toLocaleLowerCase("en-US").endsWith(".meta"));
  for (const metaFile of metaFiles) {
    try {
      const content = await readFile(path.join(repositoryRoot, metaFile), "utf8");
      const match = /^guid:\s*([0-9a-f]{32})\s*$/im.exec(content);
      if (match) guidToPath.set(match[1].toLocaleLowerCase("en-US"), metaFile.slice(0, -5));
    } catch {
      // A file can disappear between git enumeration and analysis.
    }
  }

  const serializedExtensions = new Set([".asset", ".controller", ".mat", ".prefab", ".unity"]);
  let referenceCount = 0;
  for (const file of trackedFiles) {
    if (!serializedExtensions.has(path.extname(file).toLocaleLowerCase("en-US"))) continue;
    try {
      const absolute = path.join(repositoryRoot, file);
      if ((await stat(absolute)).size > MAX_FILE_BYTES) continue;
      const content = await readFile(absolute, "utf8");
      const fromSystem = inferSystemId(file);
      for (const match of content.matchAll(/guid:\s*([0-9a-f]{32})/gi)) {
        const targetPath = guidToPath.get(match[1].toLocaleLowerCase("en-US"));
        if (!targetPath) continue;
        referenceCount += 1;
        addEdge(edges, fromSystem, inferSystemId(targetPath), "unity_asset", 0.98);
      }
    } catch {
      // The scanner is best effort and will retry on the next heartbeat.
    }
  }
  return referenceCount;
}

async function inspectAssemblyReferences(
  repositoryRoot: string,
  trackedFiles: string[],
  edges: Map<string, MutableEdge>,
): Promise<void> {
  const assemblyOwners = new Map<string, string>();
  const parsed: Array<{ file: string; name: string; references: string[] }> = [];
  for (const file of trackedFiles.filter((candidate) => candidate.endsWith(".asmdef"))) {
    try {
      const value = JSON.parse(await readFile(path.join(repositoryRoot, file), "utf8")) as {
        name?: unknown;
        references?: unknown;
      };
      if (typeof value.name !== "string") continue;
      const references = Array.isArray(value.references)
        ? value.references.filter((item): item is string => typeof item === "string")
        : [];
      assemblyOwners.set(value.name, inferSystemId(file));
      parsed.push({ file, name: value.name, references });
    } catch {
      // Invalid asmdef files are surfaced by Unity; the scanner simply skips them.
    }
  }
  for (const assembly of parsed) {
    const from = inferSystemId(assembly.file);
    for (const reference of assembly.references) {
      const normalized = reference.replace(/^GUID:/, "");
      const to = assemblyOwners.get(normalized) ?? assemblyOwners.get(reference);
      if (to) addEdge(edges, from, to, "assembly", 0.95);
    }
  }
}

function inspectHistory(
  logOutput: string | null,
  edges: Map<string, MutableEdge>,
): number {
  if (!logOutput) return 0;
  const commits = logOutput.split("__AGENT_HUB_COMMIT__").slice(1);
  for (const commit of commits) {
    const systems = unique(
      commit
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map(inferSystemId),
    );
    for (const from of systems) {
      for (const to of systems) {
        if (from !== to) addEdge(edges, from, to, "history", 0.45);
      }
    }
  }
  return commits.length;
}

export function deriveImpactedSystems(
  changedPaths: string[],
  dependencies: DependencyEdge[],
): string[] {
  const direct = new Set(changedPaths.map(inferSystemId));
  const impacted = new Set(direct);
  for (const edge of dependencies) {
    if (direct.has(edge.toSystemId)) impacted.add(edge.fromSystemId);
    if (direct.has(edge.fromSystemId) && edge.kind === "unity_asset") impacted.add(edge.toSystemId);
  }
  return [...impacted].sort();
}

export async function inspectRepository(
  selectedPath: string,
  options: InspectRepositoryOptions = {},
): Promise<RepositorySnapshot> {
  const gitExecutable = resolveGitExecutable(options.gitExecutable);
  const selectedRealPath = await realpath(selectedPath);
  const rootOutput = await runGit(gitExecutable, selectedRealPath, ["rev-parse", "--show-toplevel"]);
  const repositoryRoot = await realpath(rootOutput.trim());
  const [remote, branch, headCommit, rootCommit] = await Promise.all([
    safeGit(gitExecutable, repositoryRoot, ["remote", "get-url", "origin"]),
    safeGit(gitExecutable, repositoryRoot, ["branch", "--show-current"]),
    safeGit(gitExecutable, repositoryRoot, ["rev-parse", "HEAD"]),
    safeGit(gitExecutable, repositoryRoot, ["rev-list", "--max-parents=0", "HEAD"]),
  ]);
  if (!headCommit) throw new Error("The selected repository does not have a commit yet.");

  const trackedOutput = await runGit(gitExecutable, repositoryRoot, ["ls-files", "-z"]);
  const allTrackedFiles = trackedOutput.split("\0").filter(Boolean).map(normalizeSlash);
  const truncated = allTrackedFiles.length > MAX_TRACKED_FILES;
  const trackedFiles = allTrackedFiles.slice(0, MAX_TRACKED_FILES);
  const changedPaths = parseChangedPaths(
    await Promise.all([
      safeGit(gitExecutable, repositoryRoot, ["diff", "--name-only", "-z"]),
      safeGit(gitExecutable, repositoryRoot, ["diff", "--cached", "--name-only", "-z"]),
      safeGit(gitExecutable, repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]),
  );

  const codeFiles: CodeFileSummary[] = [];
  for (const file of trackedFiles.filter((candidate) => candidate.endsWith(".cs"))) {
    try {
      const absolute = path.join(repositoryRoot, file);
      if ((await stat(absolute)).size > MAX_FILE_BYTES) continue;
      codeFiles.push(analyzeCSharpSource(file, await readFile(absolute, "utf8")));
    } catch {
      // Syntax errors and transient file changes are retried during the next scan.
    }
  }

  const namespaceSystems = new Map<string, Set<string>>();
  for (const file of codeFiles) {
    if (!file.namespace) continue;
    const systems = namespaceSystems.get(file.namespace) ?? new Set<string>();
    systems.add(file.systemId);
    namespaceSystems.set(file.namespace, systems);
  }

  const edges = new Map<string, MutableEdge>();
  for (const file of codeFiles) {
    for (const importedNamespace of file.imports) {
      for (const targetSystem of findNamespaceTarget(importedNamespace, namespaceSystems)) {
        addEdge(edges, file.systemId, targetSystem, "code", 0.8);
      }
    }
  }
  await inspectAssemblyReferences(repositoryRoot, trackedFiles, edges);
  const unityReferenceCount = await inspectUnityReferences(repositoryRoot, trackedFiles, edges);
  const historyLimit = Math.max(0, Math.min(options.historyCommitLimit ?? 150, 500));
  const historyOutput = historyLimit
    ? await safeGit(gitExecutable, repositoryRoot, [
        "log",
        `-${historyLimit}`,
        "--name-only",
        "--pretty=format:__AGENT_HUB_COMMIT__",
      ])
    : null;
  const historyCommitCount = inspectHistory(historyOutput, edges);

  const changedSet = new Set(changedPaths.map((item) => item.toLocaleLowerCase("en-US")));
  const systemMap = new Map<string, SystemSummary>();
  for (const file of trackedFiles) {
    const id = inferSystemId(file);
    const existing = systemMap.get(id) ?? {
      id,
      name: systemNameFromId(id),
      paths: [id],
      fileCount: 0,
      changedFileCount: 0,
      publicContracts: [],
    };
    existing.fileCount += 1;
    if (changedSet.has(file.toLocaleLowerCase("en-US"))) existing.changedFileCount += 1;
    systemMap.set(id, existing);
  }
  for (const file of codeFiles) {
    const system = systemMap.get(file.systemId);
    if (system) system.publicContracts.push(...file.publicContracts);
  }
  for (const system of systemMap.values()) {
    system.publicContracts = unique(system.publicContracts).slice(0, 200);
  }

  const dependencies = [...edges.values()].sort((left, right) =>
    `${left.fromSystemId}\u0000${left.toSystemId}\u0000${left.kind}`.localeCompare(
      `${right.fromSystemId}\u0000${right.toSystemId}\u0000${right.kind}`,
    ),
  );
  const identitySource = `${remote ? normalizeRemote(remote) : path.basename(repositoryRoot)}|${rootCommit ?? headCommit}`;

  return {
    repository: {
      root: repositoryRoot,
      name: path.basename(repositoryRoot),
      remote,
      branch: branch || "(detached)",
      headCommit,
      rootCommit: rootCommit ?? headCommit,
      fingerprint: sha256(identitySource),
    },
    generatedAt: new Date().toISOString(),
    changedPaths,
    ruleFiles: await discoverRules(repositoryRoot, trackedFiles),
    systems: [...systemMap.values()].sort((left, right) => left.id.localeCompare(right.id)),
    dependencies,
    impactedSystemIds: deriveImpactedSystems(changedPaths, dependencies),
    analysis: {
      trackedFileCount: allTrackedFiles.length,
      parsedCSharpFileCount: codeFiles.length,
      unityReferenceCount,
      historyCommitCount,
      truncated,
    },
  };
}
