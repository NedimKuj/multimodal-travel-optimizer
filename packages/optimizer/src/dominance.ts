import { compareMoney } from "@travel-optimizer/domain";

import {
  comparisonClass,
  type DestinationResult,
  type RankedCandidate,
} from "./flight-exploration.js";
import { transportPattern } from "./transport-pattern.js";

/*
 * Dominance (ADR 0017, spec §17).
 *
 * A candidate is redundant when another offers the same thing and is no worse
 * on every axis a traveler weighs, and better on at least one. Removing it
 * loses nothing.
 *
 * This is a **redundancy boundary, not a ranking preference**. It may thin the
 * routes to one place in one shape; it may never remove a place or a shape,
 * because destination discovery and trip-shape diversity are product outputs.
 *
 * Pure: no provider calls, no side effects, no dependence on input order.
 */

/**
 * The states of a candidate's stays, as a sorted multiset.
 *
 * Part of comparability rather than a dimension. `cost.total` sums priced
 * components only, so two candidates in the same class can differ in how much
 * of their cost is *known* — and comparing those totals would let the one with
 * **less** known cost look cheaper and eliminate the one with more. Different
 * accommodation amounts are fine; different completeness is not comparable.
 */
export function coverageProfile(candidate: RankedCandidate): string {
  return [...candidate.summary.accommodation.map((entry) => entry.state)].sort().join("+");
}

/**
 * What must match before two candidates may be compared at all.
 *
 * Destination is **not** here: pruning runs within a destination's candidates,
 * so a cheaper Rome can never reach Milan to eliminate it.
 */
export function comparabilityKey(candidate: RankedCandidate): string {
  return [
    transportPattern(candidate),
    String(comparisonClass(candidate)),
    candidate.summary.cost.scope,
    coverageProfile(candidate),
    // One currency per search, but never compare across one by accident.
    candidate.summary.cost.total.currency,
  ].join("|");
}

/** Changes the traveler makes: stops inside journeys plus changes between them. */
export function changesOf(candidate: RankedCandidate): number {
  return candidate.summary.stops + candidate.summary.connections;
}

/**
 * Whether `a` makes `b` redundant.
 *
 * Nights are deliberately absent. Two trips of different length are not
 * interchangeable — duration is product intent, and it changes what
 * accommodation is worth. `[minNights, maxNights]` already bounds what the
 * traveler will accept (ADR 0017 §4).
 *
 * A strict partial order: irreflexive, since equality is never domination;
 * antisymmetric, since a strict win on one axis is a strict loss for the other;
 * and transitive, since all three comparisons are numeric. The surviving set is
 * therefore its maximal elements, whatever order candidates arrive in.
 */
export function dominates(a: RankedCandidate, b: RankedCandidate): boolean {
  if (comparabilityKey(a) !== comparabilityKey(b)) return false;

  const byCost = compareMoney(a.summary.cost.total, b.summary.cost.total);
  const byTime = a.summary.travelTimeMinutes - b.summary.travelTimeMinutes;
  const byChanges = changesOf(a) - changesOf(b);

  // Worse on any axis is not domination, however much better elsewhere.
  if (byCost > 0 || byTime > 0 || byChanges > 0) return false;
  // Equal on every axis is not redundancy either: both survive.
  return byCost < 0 || byTime < 0 || byChanges < 0;
}

/**
 * What pruning did, reported apart from every other reduction.
 *
 * Deliberately not merged with budget skips, invalid candidates, the
 * accommodation shortlist or provider failures: those remove candidates for
 * entirely different reasons, and one number covering several of them would
 * explain none of them.
 *
 * `entered === pruned + remaining` always.
 */
export interface PruningRecord {
  readonly entered: number;
  readonly pruned: number;
  readonly remaining: number;
}

export interface PruningResult {
  readonly destinations: readonly DestinationResult[];
  readonly counts: PruningRecord;
}

/**
 * Removes redundant candidates from each destination.
 *
 * A candidate survives when **no other candidate dominates it**. That
 * predicate is evaluated identically for every candidate, so nothing depends
 * on which one is examined first — no first-wins, no insertion order, no
 * provider response order. Since dominance is a strict partial order, the
 * survivors are its maximal elements and the outcome is the same for any input
 * ordering (ADR 0017 §6).
 *
 * Comparison is per destination, so a cheaper trip to one city can never reach
 * another city to eliminate it. Within a destination, the comparability key
 * keeps trip shapes and pricing completeness apart.
 */
export function pruneDominated(
  destinations: readonly DestinationResult[],
): PruningResult {
  let entered = 0;
  let remaining = 0;

  const pruned = destinations.map((destination) => {
    const { candidates } = destination;
    entered += candidates.length;
    const kept = candidates.filter(
      (candidate) => !candidates.some((other) => dominates(other, candidate)),
    );
    remaining += kept.length;
    // Rebuilding only when something went keeps identity stable elsewhere.
    return kept.length === candidates.length ? destination : { ...destination, candidates: kept };
  });

  return {
    destinations: pruned,
    counts: { entered, pruned: entered - remaining, remaining },
  };
}
