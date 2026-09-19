import type { Location } from "@travel-optimizer/domain";

/*
 * The provider call budget (spec §15, ADR 0015).
 *
 * One application-level limit for the whole search, shared by every optional
 * dimension: alternative origins, return-leg enrichment, onward-leg discovery.
 * The number is ours, chosen for safety. It is NOT a claim about the provider's
 * quota, which remains unverified (docs/provider-compliance.md).
 *
 * The unit is a provider call. A *logical* query — one question, such as "how
 * do I get home from Rome?" — costs one call per calendar month its date range
 * spans, because this provider is queried at month granularity (ADR 0006). A
 * two-month window therefore makes a single return-leg query cost two calls.
 */

export const DEFAULT_CALL_BUDGET = 12;

/**
 * Return-leg queries guaranteed before any budget reaches onward discovery.
 *
 * An itinerary with no way home does not exist, while one with no onward leg is
 * simply a shorter trip, so ways home earn a floor. The guarantee binds onward
 * discovery, never the global budget: where even this does not fit, the search
 * runs with fewer returns rather than overspending (ADR 0015).
 */
export const GUARANTEED_RETURN_QUERIES = 2;

/** The stages of the funnel, in the order a search runs them. */
export type SearchStageName = "origin" | "outbound" | "return" | "onward";

/**
 * Why a query the search would have made never ran.
 *
 * `call_budget` means there was nothing left to spend; `cap` means a limit of
 * our own stopped it before the budget did.
 */
export type SkipReason = "call_budget" | "cap";

/**
 * A query that was not made, and why.
 *
 * Every stage records skips in this shape, so a search that came back thin has
 * one vocabulary explaining it rather than one per stage.
 */
export interface SkippedQuery {
  readonly stage: SearchStageName;
  /** What the query would have been about. */
  readonly airport: Location;
  readonly reason: SkipReason;
}

/** Provider calls one logical query costs, from the range it covers. */
export function costOfQuery(range: { readonly from: string; readonly to: string }): number {
  let cursor = range.from.slice(0, 7);
  const last = range.to.slice(0, 7);
  let months = 0;
  // The guard bounds a range that is somehow inverted or absurd, rather than
  // looping: a budget that cannot be computed must not become an unbounded one.
  while (cursor <= last && months <= 24) {
    months += 1;
    const [year = "", month = ""] = cursor.split("-");
    cursor =
      Number(month) === 12
        ? `${String(Number(year) + 1)}-01`
        : `${year}-${String(Number(month) + 1).padStart(2, "0")}`;
  }
  return months;
}

/** What a search has spent, and what it chose not to. */
export interface SearchBudget {
  readonly maxProviderCalls: number;
  usedProviderCalls: number;
  readonly skipped: SkippedQuery[];
}

export function createSearchBudget(maxProviderCalls: number): SearchBudget {
  return { maxProviderCalls, usedProviderCalls: 0, skipped: [] };
}

export function remainingCalls(budget: SearchBudget): number {
  return Math.max(0, budget.maxProviderCalls - budget.usedProviderCalls);
}

/** Whether a query of this cost still fits. Never exceed the global budget. */
export function canAfford(budget: SearchBudget, calls: number): boolean {
  return budget.usedProviderCalls + calls <= budget.maxProviderCalls;
}

export function spend(budget: SearchBudget, calls: number): void {
  budget.usedProviderCalls += calls;
}

export function recordSkip(budget: SearchBudget, query: SkippedQuery): void {
  budget.skipped.push(query);
}

export function skippedInStage(budget: SearchBudget, stage: SearchStageName): SkippedQuery[] {
  return budget.skipped.filter((query) => query.stage === stage);
}
