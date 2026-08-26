import { createHash } from "node:crypto";

export const DEFAULT_CONTEXT_TOKEN_BUDGET = 2_500;
export const MAX_CONTEXT_TOKEN_BUDGET = 3_000;

const CURSOR_VERSION = 1;
const ITEM_SEPARATOR_TOKENS = 1;
const TOKEN_SAFETY_FACTOR = 1.2;

export interface ContextBudgetCandidate<T> {
  id: string;
  priority: number;
  value: T;
  /** Exact text that will be injected. Defaults to JSON serialization of value. */
  text?: string;
}

export interface ContextBudgetOptions<T> {
  budgetTokens?: number;
  baseTokens?: number;
  /** Maximum number of complete entries in this page. */
  limit?: number;
  cursor?: string;
  serialize?: (value: T) => string;
}

export interface ContextBudgetResult<T> {
  items: T[];
  estimatedTokens: number;
  budgetTokens: number;
  truncated: boolean;
  nextCursor: string | null;
}

export class ContextBudgetCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextBudgetCursorError";
  }
}

export class ContextBudgetItemTooLargeError extends Error {
  readonly itemId: string;
  readonly estimatedTokens: number;
  readonly budgetTokens: number;

  constructor(itemId: string, estimatedTokens: number, budgetTokens: number) {
    super(
      `Context item ${JSON.stringify(itemId)} needs approximately ${estimatedTokens} tokens, `
      + `which exceeds the ${budgetTokens}-token page capacity.`,
    );
    this.name = "ContextBudgetItemTooLargeError";
    this.itemId = itemId;
    this.estimatedTokens = estimatedTokens;
    this.budgetTokens = budgetTokens;
  }
}

/**
 * Estimates model tokens conservatively without depending on one model's tokenizer.
 * The safety factor intentionally leaves room for tokenizer and response-format variance.
 */
export function estimateContextTokens(text: string): number {
  if (!text) return 0;

  let baseTokens = 0;
  let asciiWordLength = 0;
  let whitespaceLength = 0;

  const flushAsciiWord = () => {
    if (asciiWordLength === 0) return;
    baseTokens += Math.ceil(asciiWordLength / 4);
    asciiWordLength = 0;
  };
  const flushWhitespace = () => {
    if (whitespaceLength === 0) return;
    baseTokens += Math.ceil(whitespaceLength / 4);
    whitespaceLength = 0;
  };

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isAsciiWordCharacter(codePoint)) {
      flushWhitespace();
      asciiWordLength += 1;
      continue;
    }
    flushAsciiWord();

    if (isAsciiWhitespace(codePoint)) {
      whitespaceLength += 1;
      continue;
    }
    flushWhitespace();

    if (codePoint <= 0x7f) {
      baseTokens += 1;
    } else if (isCjkLike(codePoint)) {
      baseTokens += 1;
    } else if (codePoint > 0xffff) {
      // Emoji and supplementary-plane symbols are frequently split into several tokens.
      baseTokens += 3;
    } else {
      baseTokens += 2;
    }
  }

  flushAsciiWord();
  flushWhitespace();
  return Math.max(1, Math.ceil(baseTokens * TOKEN_SAFETY_FACTOR));
}

/**
 * Sorts candidates by priority and packs a contiguous page of complete entries.
 * Entries are never shortened to make them fit. A single over-capacity entry is rejected.
 */
export function packContextByBudget<T>(
  candidates: readonly ContextBudgetCandidate<T>[],
  options: ContextBudgetOptions<T> = {},
): ContextBudgetResult<T> {
  const budgetTokens = normalizeBudget(options.budgetTokens);
  const baseTokens = normalizeBaseTokens(options.baseTokens, budgetTokens);
  const limit = normalizeItemLimit(options.limit);
  const serialize = options.serialize ?? defaultSerialize;
  const seenIds = new Set<string>();
  const normalized = candidates.map((candidate, originalIndex) => {
    const id = candidate.id.trim();
    if (!id) throw new TypeError("Every context candidate must have a non-empty ID.");
    if (seenIds.has(id)) throw new TypeError(`Duplicate context candidate ID: ${JSON.stringify(id)}.`);
    if (!Number.isFinite(candidate.priority)) {
      throw new TypeError(`Context candidate ${JSON.stringify(id)} has a non-finite priority.`);
    }
    seenIds.add(id);
    const text = candidate.text ?? serialize(candidate.value);
    if (typeof text !== "string") {
      throw new TypeError(`Context candidate ${JSON.stringify(id)} did not serialize to text.`);
    }
    return {
      ...candidate,
      id,
      text,
      originalIndex,
      tokenEstimate: estimateContextTokens(text),
    };
  }).sort((left, right) => right.priority - left.priority || left.originalIndex - right.originalIndex);

  const fingerprint = fingerprintCandidates(normalized);
  const offset = options.cursor === undefined
    ? 0
    : decodeCursor(options.cursor, fingerprint, normalized.length);
  const availableItemTokens = budgetTokens - baseTokens;
  let estimatedTokens = baseTokens;
  let nextOffset = offset;
  const items: T[] = [];

  while (nextOffset < normalized.length && items.length < limit) {
    const candidate = normalized[nextOffset]!;
    const separatorTokens = items.length === 0 ? 0 : ITEM_SEPARATOR_TOKENS;
    const candidateCost = candidate.tokenEstimate + separatorTokens;
    if (estimatedTokens + candidateCost > budgetTokens) {
      if (items.length === 0 && candidate.tokenEstimate > availableItemTokens) {
        throw new ContextBudgetItemTooLargeError(
          candidate.id,
          candidate.tokenEstimate,
          availableItemTokens,
        );
      }
      break;
    }
    items.push(candidate.value);
    estimatedTokens += candidateCost;
    nextOffset += 1;
  }

  const truncated = nextOffset < normalized.length;
  return {
    items,
    estimatedTokens,
    budgetTokens,
    truncated,
    nextCursor: truncated ? encodeCursor(nextOffset, fingerprint) : null,
  };
}

function normalizeItemLimit(requested: number | undefined): number {
  if (requested === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(requested) || requested <= 0 || !Number.isInteger(requested)) {
    throw new RangeError("The context item limit must be a positive integer.");
  }
  return requested;
}

function normalizeBudget(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_CONTEXT_TOKEN_BUDGET;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new RangeError("The context token budget must be a positive finite number.");
  }
  const normalized = Math.floor(requested);
  if (normalized < 1) {
    throw new RangeError("The context token budget must contain at least one whole token.");
  }
  return Math.min(normalized, MAX_CONTEXT_TOKEN_BUDGET);
}

function normalizeBaseTokens(requested: number | undefined, budgetTokens: number): number {
  if (requested === undefined) return 0;
  if (!Number.isFinite(requested) || requested < 0) {
    throw new RangeError("The base context token count must be a non-negative finite number.");
  }
  const normalized = Math.floor(requested);
  if (normalized >= budgetTokens) {
    throw new RangeError("The base context token count must leave room for at least one item.");
  }
  return normalized;
}

function defaultSerialize(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("A context candidate could not be serialized to JSON text.");
  }
  return serialized;
}

function fingerprintCandidates(
  candidates: ReadonlyArray<{ id: string; priority: number; text: string }>,
): string {
  const hash = createHash("sha256");
  for (const candidate of candidates) {
    hash.update(candidate.id);
    hash.update("\0");
    hash.update(String(candidate.priority));
    hash.update("\0");
    hash.update(candidate.text);
    hash.update("\0");
  }
  return hash.digest("base64url");
}

function encodeCursor(offset: number, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, offset, fingerprint }), "utf8")
    .toString("base64url");
}

function decodeCursor(cursor: string, expectedFingerprint: string, itemCount: number): number {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ContextBudgetCursorError("The context cursor is not valid.");
  }
  if (!isRecord(value)
    || value.v !== CURSOR_VERSION
    || !Number.isInteger(value.offset)
    || typeof value.offset !== "number"
    || value.offset < 0
    || value.offset > itemCount
    || value.fingerprint !== expectedFingerprint) {
    throw new ContextBudgetCursorError("The context cursor is stale or does not match this query.");
  }
  return value.offset;
}

function isAsciiWordCharacter(codePoint: number): boolean {
  return (codePoint >= 0x30 && codePoint <= 0x39)
    || (codePoint >= 0x41 && codePoint <= 0x5a)
    || (codePoint >= 0x61 && codePoint <= 0x7a)
    || codePoint === 0x24
    || codePoint === 0x5f;
}

function isAsciiWhitespace(codePoint: number): boolean {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x20;
}

function isCjkLike(codePoint: number): boolean {
  return (codePoint >= 0x3040 && codePoint <= 0x30ff)
    || (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0x20000 && codePoint <= 0x323af);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
