import { createHash } from "node:crypto";
import {
  packContextByBudget,
  type ContextBudgetCandidate,
} from "./context-budget.js";

export type FeatureMemoryState =
  | "current"
  | "draft"
  | "candidate"
  | "conflict"
  | "historical"
  | "deprecated";

export type ContextRetrievalMode = "startup" | "planning" | "detail" | "evidence";

export interface FeatureMemoryIndexEntry {
  memoryId: string;
  versionId: string;
  featureName: string;
  systemId: string;
  objective?: string;
  behaviorContract: string;
  paths?: readonly string[];
  symbols?: readonly string[];
  tests?: readonly string[];
  dependencies?: readonly string[];
  validationStatus?: string;
  state: FeatureMemoryState;
  sections?: Readonly<Record<string, unknown>>;
  sectionHashes?: Readonly<Record<string, string>>;
  evidence?: unknown;
  updatedAt?: string;
}

export interface KnownFeatureMemoryVersion {
  versionId: string;
  sectionHashes?: Readonly<Record<string, string>>;
}

export interface FeatureMemoryRetrievalQuery {
  mode: ContextRetrievalMode;
  objective?: string;
  paths?: readonly string[];
  systems?: readonly string[];
  symbols?: readonly string[];
  tests?: readonly string[];
  memoryIds?: readonly string[];
  sections?: readonly string[];
  knownVersions?: Readonly<Record<string, string | KnownFeatureMemoryVersion>>;
  includeNonCurrentDetails?: boolean;
  budgetTokens?: number;
  baseTokens?: number;
  limit?: number;
  cursor?: string;
}

export type FeatureHitKind = "memory_id" | "symbol" | "test" | "path" | "system" | "objective";

export interface FeatureHitReason {
  kind: FeatureHitKind;
  query: string;
  matched: string;
  score: number;
}

interface FeatureMemoryResultBase {
  kind: "stub" | "card" | "detail" | "evidence" | "status";
  memoryId: string;
  versionId: string;
  featureName: string;
  systemId: string;
  state: FeatureMemoryState;
  validationStatus?: string;
  score: number;
  hitReasons: FeatureHitReason[];
  versionChangedFrom?: string;
}

export interface FeatureMemoryStub extends FeatureMemoryResultBase {
  kind: "stub";
  candidate: true;
}

export interface FeatureMemoryCard extends FeatureMemoryResultBase {
  kind: "card";
  behaviorContract: string;
  keyPaths: string[];
  keySymbols: string[];
  linkedTests: string[];
}

export interface FeatureMemoryDetail extends FeatureMemoryResultBase {
  kind: "detail";
  behaviorContract: string;
  paths: string[];
  symbols: string[];
  tests: string[];
  dependencies: string[];
  sections: Record<string, unknown>;
  sectionHashes: Record<string, string>;
  unchangedSections: string[];
}

export interface FeatureMemoryEvidence extends FeatureMemoryResultBase {
  kind: "evidence";
  evidence: unknown;
  sectionHash: string;
}

export interface FeatureMemoryStatusHint extends FeatureMemoryResultBase {
  kind: "status";
  statusOnly: true;
}

export type FeatureMemoryRetrievalItem =
  | FeatureMemoryStub
  | FeatureMemoryCard
  | FeatureMemoryDetail
  | FeatureMemoryEvidence
  | FeatureMemoryStatusHint;

export interface FeatureMemoryRetrievalResult {
  mode: ContextRetrievalMode;
  items: FeatureMemoryRetrievalItem[];
  unchangedMemoryIds: string[];
  matchedCount: number;
  estimatedTokens: number;
  budgetTokens: number;
  truncated: boolean;
  nextCursor: string | null;
}

interface RankedMemory {
  entry: FeatureMemoryIndexEntry;
  score: number;
  hitReasons: FeatureHitReason[];
  originalIndex: number;
}

const HIGH_CONFIDENCE_SCORE = 100;
const CARD_ARRAY_LIMIT = 8;
const MODE_LIMITS: Record<ContextRetrievalMode, number> = {
  startup: 8,
  planning: 8,
  detail: 3,
  evidence: 3,
};

export function retrieveFeatureMemory(
  entries: readonly FeatureMemoryIndexEntry[],
  query: FeatureMemoryRetrievalQuery,
): FeatureMemoryRetrievalResult {
  const ranked = hasRetrievalCriteria(query)
    ? entries
      .map((entry, originalIndex) => rankMemory(entry, query, originalIndex))
      .filter((entry) => entry.score > 0)
      .sort(compareRankedMemories)
    : [];
  const unchangedMemoryIds: string[] = [];
  const rendered: FeatureMemoryRetrievalItem[] = [];

  for (const match of ranked) {
    const item = renderMatch(match, query);
    if (item === null) {
      unchangedMemoryIds.push(match.entry.memoryId);
    } else {
      rendered.push(item);
    }
  }

  const maximum = MODE_LIMITS[query.mode];
  const requestedLimit = query.limit === undefined ? maximum : normalizeLimit(query.limit, maximum);
  const budgetCandidates: ContextBudgetCandidate<FeatureMemoryRetrievalItem>[] = rendered.map((item) => ({
    id: `${item.memoryId}:${item.versionId}:${item.kind}`,
    priority: item.score,
    value: item,
  }));
  const packed = packContextByBudget(budgetCandidates, {
    budgetTokens: query.budgetTokens,
    baseTokens: query.baseTokens,
    limit: requestedLimit,
    cursor: query.cursor,
  });

  return {
    mode: query.mode,
    items: packed.items,
    unchangedMemoryIds,
    matchedCount: ranked.length,
    estimatedTokens: packed.estimatedTokens,
    budgetTokens: packed.budgetTokens,
    truncated: packed.truncated,
    nextCursor: packed.nextCursor,
  };
}

function rankMemory(
  entry: FeatureMemoryIndexEntry,
  query: FeatureMemoryRetrievalQuery,
  originalIndex: number,
): RankedMemory {
  const reasons: FeatureHitReason[] = [];
  const memoryIds = normalizedValues(query.memoryIds);
  if (memoryIds.includes(normalizeText(entry.memoryId))) {
    reasons.push(reason("memory_id", entry.memoryId, entry.memoryId, 1_000));
  }

  const entrySymbols = unique(entry.symbols ?? []);
  for (const requested of unique(query.symbols ?? [])) {
    const exact = entrySymbols.find((candidate) => normalizeSymbol(candidate) === normalizeSymbol(requested));
    if (exact) {
      reasons.push(reason("symbol", requested, exact, 240));
      continue;
    }
    const requestedTail = symbolTail(requested);
    const tail = entrySymbols.find((candidate) => symbolTail(candidate) === requestedTail);
    if (requestedTail && tail) reasons.push(reason("symbol", requested, tail, 130));
  }

  const entryTests = unique(entry.tests ?? []);
  for (const requested of unique(query.tests ?? [])) {
    const exact = entryTests.find((candidate) => normalizePath(candidate) === normalizePath(requested));
    if (exact) reasons.push(reason("test", requested, exact, 220));
  }

  const entryPaths = unique(entry.paths ?? []);
  for (const requested of unique(query.paths ?? [])) {
    const exact = entryPaths.find((candidate) => normalizePath(candidate) === normalizePath(requested));
    if (exact) {
      reasons.push(reason("path", requested, exact, 200));
      continue;
    }
    const overlap = entryPaths.find((candidate) => pathsOverlap(candidate, requested));
    if (overlap) reasons.push(reason("path", requested, overlap, 90));
  }

  const normalizedSystem = normalizeText(entry.systemId);
  for (const requested of unique(query.systems ?? [])) {
    const normalized = normalizeText(requested);
    if (normalized && normalized === normalizedSystem) {
      reasons.push(reason("system", requested, entry.systemId, 120));
    } else {
      const dependency = entry.dependencies?.find((candidate) => normalizeText(candidate) === normalized);
      if (dependency) reasons.push(reason("system", requested, dependency, 70));
    }
  }

  const objectiveReason = scoreObjective(entry, query.objective);
  if (objectiveReason) reasons.push(objectiveReason);

  return {
    entry,
    score: reasons.reduce((total, item) => total + item.score, 0),
    hitReasons: reasons.sort((left, right) => right.score - left.score).slice(0, 12),
    originalIndex,
  };
}

function renderMatch(
  match: RankedMemory,
  query: FeatureMemoryRetrievalQuery,
): FeatureMemoryRetrievalItem | null {
  const { entry } = match;
  const known = normalizeKnownVersion(query.knownVersions?.[entry.memoryId]);
  const versionChangedFrom = known && known.versionId !== entry.versionId
    ? known.versionId
    : undefined;
  const base: Omit<FeatureMemoryResultBase, "kind"> = {
    memoryId: entry.memoryId,
    versionId: entry.versionId,
    featureName: entry.featureName,
    systemId: entry.systemId,
    state: entry.state,
    validationStatus: entry.validationStatus,
    score: match.score,
    hitReasons: match.hitReasons,
    versionChangedFrom,
  };

  const nonCurrentDetailsAllowed = query.includeNonCurrentDetails === true
    && (query.mode === "detail" || query.mode === "evidence");
  if (entry.state !== "current" && !nonCurrentDetailsAllowed) {
    if (isVersionKnown(known, entry.versionId)) return null;
    return { ...base, kind: "status", statusOnly: true };
  }

  const highConfidence = match.score >= HIGH_CONFIDENCE_SCORE;
  if (!highConfidence) {
    if (isVersionKnown(known, entry.versionId)) return null;
    return { ...base, kind: "stub", candidate: true };
  }

  if (query.mode === "startup" || query.mode === "planning") {
    if (isVersionKnown(known, entry.versionId)) return null;
    return {
      ...base,
      kind: "card",
      behaviorContract: entry.behaviorContract,
      keyPaths: [...(entry.paths ?? [])].slice(0, CARD_ARRAY_LIMIT),
      keySymbols: [...(entry.symbols ?? [])].slice(0, CARD_ARRAY_LIMIT),
      linkedTests: [...(entry.tests ?? [])].slice(0, CARD_ARRAY_LIMIT),
    };
  }

  if (query.mode === "evidence") {
    const evidence = entry.evidence ?? entry.sections?.evidence ?? null;
    const sectionHash = entry.sectionHashes?.evidence ?? hashSection(evidence);
    if (known?.versionId === entry.versionId
      && (known.sectionHashes === undefined || known.sectionHashes.evidence === sectionHash)) {
      return null;
    }
    return { ...base, kind: "evidence", evidence, sectionHash };
  }

  const sectionNames = selectSectionNames(entry.sections, query.sections);
  if (known?.versionId === entry.versionId
    && (known.sectionHashes === undefined || sectionNames.length === 0)) return null;
  const sections: Record<string, unknown> = {};
  const sectionHashes: Record<string, string> = {};
  const unchangedSections: string[] = [];
  for (const name of sectionNames) {
    const value = entry.sections?.[name];
    const hash = entry.sectionHashes?.[name] ?? hashSection(value);
    if (known?.sectionHashes?.[name] === hash) {
      unchangedSections.push(name);
      continue;
    }
    sections[name] = value;
    sectionHashes[name] = hash;
  }
  if (known?.versionId === entry.versionId && sectionNames.length > 0 && Object.keys(sections).length === 0) {
    return null;
  }
  return {
    ...base,
    kind: "detail",
    behaviorContract: entry.behaviorContract,
    paths: [...(entry.paths ?? [])],
    symbols: [...(entry.symbols ?? [])],
    tests: [...(entry.tests ?? [])],
    dependencies: [...(entry.dependencies ?? [])],
    sections,
    sectionHashes,
    unchangedSections,
  };
}

function scoreObjective(
  entry: FeatureMemoryIndexEntry,
  requestedObjective: string | undefined,
): FeatureHitReason | undefined {
  const query = normalizeText(requestedObjective ?? "");
  if (!query) return undefined;
  const target = normalizeText([
    entry.featureName,
    entry.objective ?? "",
    entry.behaviorContract,
    entry.systemId,
    ...(entry.dependencies ?? []),
  ].join(" "));
  if (!target) return undefined;

  const queryTerms = objectiveTerms(query);
  if (queryTerms.length === 0) return undefined;
  const targetTerms = new Set(objectiveTerms(target));
  const overlap = queryTerms.filter((term) => targetTerms.has(term)).length;
  if (overlap === 0 && !target.includes(query)) return undefined;
  const coverage = overlap / queryTerms.length;
  const score = Math.max(target.includes(query) ? 70 : 0, Math.round(80 * coverage));
  return reason("objective", requestedObjective ?? "", entry.objective ?? entry.featureName, Math.min(80, score));
}

function objectiveTerms(value: string): string[] {
  const result = new Set<string>();
  for (const match of value.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const segment = match[0];
    if (containsCjk(segment)) {
      for (const character of segment) result.add(character);
      const characters = [...segment];
      for (let index = 0; index + 1 < characters.length; index += 1) {
        result.add(`${characters[index]}${characters[index + 1]}`);
      }
    } else if (segment.length > 1) {
      result.add(segment);
    }
  }
  return [...result];
}

function compareRankedMemories(left: RankedMemory, right: RankedMemory): number {
  if (left.score !== right.score) return right.score - left.score;
  const updated = (right.entry.updatedAt ?? "").localeCompare(left.entry.updatedAt ?? "");
  if (updated !== 0) return updated;
  const byId = left.entry.memoryId.localeCompare(right.entry.memoryId);
  return byId || left.originalIndex - right.originalIndex;
}

function hasRetrievalCriteria(query: FeatureMemoryRetrievalQuery): boolean {
  return Boolean(query.objective?.trim()
    || query.paths?.some((value) => value.trim())
    || query.systems?.some((value) => value.trim())
    || query.symbols?.some((value) => value.trim())
    || query.tests?.some((value) => value.trim())
    || query.memoryIds?.some((value) => value.trim()));
}

function selectSectionNames(
  sections: Readonly<Record<string, unknown>> | undefined,
  requested: readonly string[] | undefined,
): string[] {
  const available = new Set(Object.keys(sections ?? {}).filter((name) => name !== "evidence"));
  if (requested === undefined || requested.length === 0) return [...available].sort();
  return unique(requested).filter((name) => available.has(name));
}

function normalizeKnownVersion(
  known: string | KnownFeatureMemoryVersion | undefined,
): KnownFeatureMemoryVersion | undefined {
  if (typeof known === "string") return known.trim() ? { versionId: known.trim() } : undefined;
  if (!known?.versionId.trim()) return undefined;
  return { versionId: known.versionId.trim(), sectionHashes: known.sectionHashes };
}

function isVersionKnown(
  known: KnownFeatureMemoryVersion | undefined,
  versionId: string,
): boolean {
  return known?.versionId === versionId;
}

function normalizeLimit(requested: number, maximum: number): number {
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new RangeError("The feature-memory result limit must be a positive finite number.");
  }
  const normalized = Math.floor(requested);
  if (normalized < 1) {
    throw new RangeError("The feature-memory result limit must contain at least one whole item.");
  }
  return Math.min(normalized, maximum);
}

function reason(
  kind: FeatureHitKind,
  query: string,
  matched: string,
  score: number,
): FeatureHitReason {
  return { kind, query, matched, score };
}

function normalizedValues(values: readonly string[] | undefined): string[] {
  return unique(values ?? []).map(normalizeText).filter(Boolean);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function normalizeSymbol(value: string): string {
  return normalizeText(value).replace(/\s+/g, "").replace(/\(.*\)$/, "");
}

function symbolTail(value: string): string {
  const normalized = normalizeSymbol(value);
  return normalized.split(/[.:/#]/).filter(Boolean).at(-1) ?? "";
}

function normalizePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
  return normalized.replace(/\/$/, "").toLocaleLowerCase("en-US");
}

function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight}/`)
    || normalizedRight.startsWith(`${normalizedLeft}/`);
}

function hashSection(value: unknown): string {
  const serialized = JSON.stringify(value) ?? "null";
  return createHash("sha256").update(serialized).digest("base64url");
}

function containsCjk(value: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/u.test(value);
}
