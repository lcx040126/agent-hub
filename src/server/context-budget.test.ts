import { describe, expect, it } from "vitest";
import {
  ContextBudgetCursorError,
  ContextBudgetItemTooLargeError,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  MAX_CONTEXT_TOKEN_BUDGET,
  estimateContextTokens,
  packContextByBudget,
} from "./context-budget.js";

describe("context token estimation", () => {
  it("conservatively estimates ASCII, Chinese, and supplementary symbols", () => {
    expect(estimateContextTokens("a".repeat(40))).toBeGreaterThanOrEqual(10);
    expect(estimateContextTokens("功能记忆".repeat(10))).toBeGreaterThanOrEqual(40);
    expect(estimateContextTokens("😀".repeat(10))).toBeGreaterThanOrEqual(30);
    expect(estimateContextTokens("")).toBe(0);
  });
});

describe("packContextByBudget", () => {
  it("uses the default budget and caps requested budgets at the hard maximum", () => {
    const defaultResult = packContextByBudget([
      { id: "one", priority: 1, value: "short" },
    ]);
    expect(defaultResult.budgetTokens).toBe(DEFAULT_CONTEXT_TOKEN_BUDGET);

    const cappedResult = packContextByBudget([
      { id: "one", priority: 1, value: "short" },
    ], { budgetTokens: 9_999 });
    expect(cappedResult.budgetTokens).toBe(MAX_CONTEXT_TOKEN_BUDGET);
    expect(cappedResult.estimatedTokens).toBeLessThanOrEqual(MAX_CONTEXT_TOKEN_BUDGET);
    expect(() => packContextByBudget([], { budgetTokens: 0.5 })).toThrow(RangeError);
  });

  it("packs complete entries in stable priority order", () => {
    const result = packContextByBudget([
      { id: "low", priority: 1, value: { name: "low", body: "low body" } },
      { id: "high", priority: 100, value: { name: "high", body: "high body" } },
      { id: "medium", priority: 50, value: { name: "medium", body: "medium body" } },
      { id: "medium-later", priority: 50, value: { name: "medium-later", body: "later" } },
    ]);

    expect(result.items.map((item) => item.name)).toEqual([
      "high",
      "medium",
      "medium-later",
      "low",
    ]);
    expect(result.truncated).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("returns a cursor and resumes at the first complete item that did not fit", () => {
    const candidates = [
      { id: "first", priority: 3, value: { id: "first", body: "甲".repeat(900) } },
      { id: "second", priority: 2, value: { id: "second", body: "乙".repeat(900) } },
      { id: "third", priority: 1, value: { id: "third", body: "丙".repeat(900) } },
    ];
    const firstPage = packContextByBudget(candidates);

    expect(firstPage.items.map((item) => item.id)).toEqual(["first", "second"]);
    expect(firstPage.items[0]).toEqual(candidates[0]!.value);
    expect(firstPage.items[1]).toEqual(candidates[1]!.value);
    expect(firstPage.estimatedTokens).toBeLessThanOrEqual(DEFAULT_CONTEXT_TOKEN_BUDGET);
    expect(firstPage.truncated).toBe(true);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = packContextByBudget(candidates, { cursor: firstPage.nextCursor! });
    expect(secondPage.items).toEqual([candidates[2]!.value]);
    expect(secondPage.truncated).toBe(false);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("paginates by a complete-entry limit without losing the remaining candidates", () => {
    const candidates = Array.from({ length: 5 }, (_, index) => ({
      id: `item-${index}`,
      priority: 5 - index,
      value: { id: `item-${index}`, body: "complete" },
    }));
    const first = packContextByBudget(candidates, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(["item-0", "item-1"]);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = packContextByBudget(candidates, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.id)).toEqual(["item-2", "item-3"]);
    expect(second.truncated).toBe(true);

    const third = packContextByBudget(candidates, { limit: 2, cursor: second.nextCursor! });
    expect(third.items.map((item) => item.id)).toEqual(["item-4"]);
    expect(third.nextCursor).toBeNull();
    expect(() => packContextByBudget(candidates, { limit: 0.5 })).toThrow(RangeError);
  });

  it("accounts for already reserved startup context", () => {
    const result = packContextByBudget([
      { id: "first", priority: 2, value: "甲".repeat(700) },
      { id: "second", priority: 1, value: "乙".repeat(700) },
    ], { baseTokens: 1_500 });

    expect(result.items).toEqual(["甲".repeat(700)]);
    expect(result.estimatedTokens).toBeGreaterThanOrEqual(1_500);
    expect(result.estimatedTokens).toBeLessThanOrEqual(DEFAULT_CONTEXT_TOKEN_BUDGET);
    expect(result.truncated).toBe(true);
  });

  it("rejects an over-capacity item instead of truncating its text", () => {
    const body = "超".repeat(2_600);
    expect(() => packContextByBudget([
      { id: "oversized", priority: 1, value: { body } },
    ], { budgetTokens: MAX_CONTEXT_TOKEN_BUDGET })).toThrow(ContextBudgetItemTooLargeError);
  });

  it("rejects a cursor after candidate content changes", () => {
    const candidates = [
      { id: "first", priority: 2, value: "甲".repeat(1_100) },
      { id: "second", priority: 1, value: "乙".repeat(1_100) },
      { id: "third", priority: 0, value: "丙".repeat(1_100) },
    ];
    const firstPage = packContextByBudget(candidates);
    expect(firstPage.nextCursor).not.toBeNull();

    expect(() => packContextByBudget([
      ...candidates.slice(0, 2),
      { ...candidates[2]!, value: "内容已经改变" },
    ], { cursor: firstPage.nextCursor! })).toThrow(ContextBudgetCursorError);
  });
});
