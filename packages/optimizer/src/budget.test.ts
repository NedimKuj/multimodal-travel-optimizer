import { parseLocalDate } from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import {
  canAfford,
  canAffordStay,
  costOfQuery,
  createAccommodationBudget,
  createSearchBudget,
  DEFAULT_CALL_BUDGET,
  recordSkip,
  recordStaySkip,
  remainingCalls,
  skippedInStage,
  spend,
  spendOnStay,
} from "./budget.js";
import { FCO, ROME, SAW } from "./test-fixtures.js";

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

describe("AccommodationSearchBudget", () => {
  it("starts unspent at the limit it was given", () => {
    const budget = createAccommodationBudget(4);
    expect(budget.maxProviderCalls).toBe(4);
    expect(budget.usedProviderCalls).toBe(0);
    expect(budget.skipped).toEqual([]);
  });

  it("refuses a search that would take it past its limit", () => {
    const budget = createAccommodationBudget(3);
    spendOnStay(budget, 2);
    expect(canAffordStay(budget, 1)).toBe(true);
    expect(canAffordStay(budget, 2)).toBe(false);
  });

  it("is wholly independent of the transport budget", () => {
    // Spending one must never move the other: different sources, different
    // quotas (ADR 0016 §7).
    const transport = createSearchBudget(DEFAULT_CALL_BUDGET);
    const accommodation = createAccommodationBudget(4);
    spendOnStay(accommodation, 4);
    expect(transport.usedProviderCalls).toBe(0);
    expect(remainingCalls(transport)).toBe(DEFAULT_CALL_BUDGET);

    spend(transport, DEFAULT_CALL_BUDGET);
    expect(accommodation.usedProviderCalls).toBe(4);
    expect(canAffordStay(accommodation, 1)).toBe(false);
  });

  it("records a search it had no budget for, naming the city and dates", () => {
    // A transport skip names an airport; an accommodation skip names where the
    // traveler would have slept. Same stage-and-reason vocabulary, honest
    // subjects.
    const budget = createAccommodationBudget(0);
    const skipped = {
      stage: "accommodation" as const,
      city: ROME,
      checkIn: parseLocalDate("2026-12-27"),
      checkOut: parseLocalDate("2027-01-02"),
      reason: "call_budget" as const,
    };
    recordStaySkip(budget, skipped);
    expect(budget.skipped).toEqual([skipped]);
  });
});
