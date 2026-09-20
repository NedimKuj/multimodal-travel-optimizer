import type { SearchRequest } from "@travel-optimizer/domain";

import { compareCandidates, type RankedCandidate } from "./flight-exploration.js";
import {
  enabledPatterns,
  transportPattern,
  type TransportPattern,
} from "./transport-pattern.js";

/*
 * Choosing which candidates are worth an accommodation call (ADR 0016 §5).
 *
 * Pricing every transport candidate is prohibitive, and taking the cheapest N
 * fills the list with near-identical trips. So each eligible pattern reserves
 * one slot first, and the rest is filled from the ordinary ranking.
 *
 * Reserving before filling is the point: taking the top N and then swapping in
 * missing patterns can evict a pattern it has just guaranteed, and its answer
 * depends on the order patterns happen to be considered in. Nothing here is
 * ever evicted.
 */

export interface ShortlistOptions {
  readonly request: SearchRequest;
  /** How many candidates may be priced. */
  readonly limit: number;
}

/** A pattern that had an eligible candidate but no room for it. */
export interface DroppedPattern {
  readonly pattern: TransportPattern;
  readonly reason: "shortlist_too_small";
}

export interface Shortlist {
  /** Candidates to price, in the order they were chosen. */
  readonly selected: readonly RankedCandidate[];
  /** Eligible candidates that did not make it. */
  readonly excluded: readonly RankedCandidate[];
  /** Candidates no accommodation call may be spent on, with the reason. */
  readonly ineligible: readonly {
    readonly candidate: RankedCandidate;
    readonly reason: IneligibleReason;
  }[];
  /** Patterns represented in `selected`. */
  readonly patterns: readonly TransportPattern[];
  /**
   * Patterns that had an eligible candidate the shortlist had no room for.
   * Empty whenever the limit is at least the number of eligible patterns.
   */
  readonly dropped: readonly DroppedPattern[];
}

export type IneligibleReason =
  /** Its transport cost already leaves a sector out (ADR 0016 §6). */
  | "unpriced_transport_sector"
  /**
   * At least one stay cannot be turned into a search at all.
   *
   * Implied by the reason above today, since a stay is only unresolvable when
   * an unpriced sector splits it. Kept because eligibility is about whether a
   * search can be *constructed*, which is a separate question from whether the
   * transport cost is complete, and the two could come apart.
   */
  | "unresolved_stay";

/**
 * Whether a candidate may be priced at all.
 *
 * A trip whose transport cost is already incomplete would make accommodation
 * ranking misleading, so no call is spent on it — and it is not made eligible
 * merely to fill a pattern slot. It is kept, with its exclusions intact.
 */
export function ineligibleReason(candidate: RankedCandidate): IneligibleReason | undefined {
  if (candidate.summary.cost.exclusions.includes("unpriced_segment")) {
    return "unpriced_transport_sector";
  }
  if (candidate.summary.accommodation.some((entry) => entry.state === "unresolved")) {
    return "unresolved_stay";
  }
  return undefined;
}

/**
 * Chooses the candidates to price.
 *
 * Whenever `limit` is at least the number of eligible patterns, every eligible
 * pattern is represented. Below that, the patterns that did not fit are
 * reported rather than silently lost.
 */
export function buildShortlist(
  candidates: readonly RankedCandidate[],
  options: ShortlistOptions,
): Shortlist {
  const ineligible: { candidate: RankedCandidate; reason: IneligibleReason }[] = [];
  const eligible: RankedCandidate[] = [];
  for (const candidate of candidates) {
    const reason = ineligibleReason(candidate);
    if (reason === undefined) eligible.push(candidate);
    else ineligible.push({ candidate, reason });
  }

  // One deterministic order underlies every choice below, so the shortlist
  // never depends on the order candidates happened to be built in.
  const ranked = [...eligible].sort(compareCandidates);
  const allowed = new Set(enabledPatterns(options.request));

  // Reserve: the cheapest eligible candidate of each pattern. Patterns are
  // mutually exclusive, so no candidate can be reserved twice.
  const reserved: RankedCandidate[] = [];
  const seenPatterns = new Set<TransportPattern>();
  for (const candidate of ranked) {
    const pattern = transportPattern(candidate);
    if (!allowed.has(pattern) || seenPatterns.has(pattern)) continue;
    seenPatterns.add(pattern);
    reserved.push(candidate);
  }

  // Too small to hold the floor: keep the cheapest reservations and say which
  // patterns that cost us, rather than appearing to honour a floor we cannot.
  const keptReservations = [...reserved].sort(compareCandidates).slice(0, options.limit);
  const dropped: DroppedPattern[] = reserved
    .filter((candidate) => !keptReservations.includes(candidate))
    .map((candidate) => ({
      pattern: transportPattern(candidate),
      reason: "shortlist_too_small" as const,
    }));

  // Fill: the remaining slots, cheapest first, skipping what is already in.
  const selected = [...keptReservations];
  for (const candidate of ranked) {
    if (selected.length >= options.limit) break;
    if (selected.includes(candidate)) continue;
    selected.push(candidate);
  }

  const chosen = new Set(selected);
  return {
    selected,
    excluded: ranked.filter((candidate) => !chosen.has(candidate)),
    ineligible,
    patterns: [...new Set(selected.map(transportPattern))],
    dropped,
  };
}
