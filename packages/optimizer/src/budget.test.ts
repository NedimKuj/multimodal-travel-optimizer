import { describe, expect, it } from "vitest";

import {
  canAfford,
  costOfQuery,
  createSearchBudget,
  DEFAULT_CALL_BUDGET,
  recordSkip,
  remainingCalls,
  skippedInStage,
  spend,
} from "./budget.js";
import { FCO, SAW } from "./test-fixtures.js";

describe("costOfQuery", () => {
  it("counts every calendar month a range touches", () => {
    expect(costOfQuery({ from: "2026-12-24", to: "2026-12-31" })).toBe(1);
    expect(costOfQuery({ from: "2026-12-29", to: "2027-01-05" })).toBe(2);
    expect(costOfQuery({ from: "2026-11-01", to: "2027-01-31" })).toBe(3);
  });

  it("costs a single day one call", () => {
    expect(costOfQuery({ from: "2026-12-26", to: "2026-12-26" })).toBe(1);
  });

  it("stays bounded rather than looping on a range it cannot make sense of", () => {
    expect(costOfQuery({ from: "2027-01-05", to: "2026-12-24" })).toBe(0);
    expect(costOfQuery({ from: "2020-01-01", to: "2099-12-31" })).toBeLessThanOrEqual(25);
  });
});

describe("SearchBudget", () => {
  it("starts unspent", () => {
    const budget = createSearchBudget(DEFAULT_CALL_BUDGET);
    expect(budget.usedProviderCalls).toBe(0);
    expect(remainingCalls(budget)).toBe(12);
    expect(budget.skipped).toEqual([]);
  });

  it("refuses a query that would take it past the limit", () => {
    const budget = createSearchBudget(12);
    spend(budget, 10);
    expect(canAfford(budget, 2)).toBe(true);
    expect(canAfford(budget, 3)).toBe(false);
  });

  it("never reports a negative remainder", () => {
    const budget = createSearchBudget(12);
    spend(budget, 20);
    expect(remainingCalls(budget)).toBe(0);
  });

  it("records what each stage did not get to ask", () => {
    const budget = createSearchBudget(12);
    recordSkip(budget, { stage: "return", airport: FCO, reason: "call_budget" });
    recordSkip(budget, { stage: "onward", airport: SAW, reason: "call_budget" });
    expect(skippedInStage(budget, "return").map((query) => query.airport.iata)).toEqual(["FCO"]);
    expect(skippedInStage(budget, "onward").map((query) => query.airport.iata)).toEqual(["SAW"]);
    expect(skippedInStage(budget, "origin")).toEqual([]);
  });
});
