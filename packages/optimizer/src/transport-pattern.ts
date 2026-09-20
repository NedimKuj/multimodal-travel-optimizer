import type { SearchRequest } from "@travel-optimizer/domain";

/*
 * The shape of a trip (ADR 0016 §5).
 *
 * Used to keep the accommodation shortlist from filling with near-identical
 * itineraries, and to label a candidate in output. One definition, so the two
 * can never disagree about what a trip is.
 */

export const TRANSPORT_PATTERNS = [
  "round_trip",
  "open_jaw",
  "multi_city",
  "multi_city_open_jaw",
] as const;

export type TransportPattern = (typeof TRANSPORT_PATTERNS)[number];

/**
 * The only two facts a pattern depends on. `RankedCandidate` satisfies this
 * structurally, so nothing needs converting to ask.
 */
export interface PatternInput {
  /** One entry per place the traveler sleeps. */
  readonly nightsByStay: readonly number[];
  readonly summary: { readonly unpricedGaps: readonly unknown[] };
}

/**
 * Which pattern a candidate is.
 *
 * A total function of two independent facts — whether the traveler sleeps in
 * more than one place, and whether any sector is unpriced — so every candidate
 * has exactly **one** pattern. Four inputs, four outputs, no overlap. That
 * exclusivity is what lets the shortlist reserve one slot per pattern without
 * any deduplication.
 */
export function transportPattern(candidate: PatternInput): TransportPattern {
  const multiCity = candidate.nightsByStay.length > 1;
  const openJaw = candidate.summary.unpricedGaps.length > 0;
  if (multiCity) return openJaw ? "multi_city_open_jaw" : "multi_city";
  return openJaw ? "open_jaw" : "round_trip";
}

/** The patterns a request permits a search to build. */
export function enabledPatterns(request: SearchRequest): TransportPattern[] {
  return TRANSPORT_PATTERNS.filter((pattern) => {
    const needsOpenJaw = pattern === "open_jaw" || pattern === "multi_city_open_jaw";
    const needsMultiCity = pattern === "multi_city" || pattern === "multi_city_open_jaw";
    if (needsOpenJaw && !request.allowOpenJaw) return false;
    if (needsMultiCity && !request.allowMultiCity) return false;
    return true;
  });
}

/** How a pattern reads in output. */
export const PATTERN_LABELS: Readonly<Record<TransportPattern, string>> = {
  round_trip: "round trip",
  open_jaw: "open jaw",
  multi_city: "multi-city",
  multi_city_open_jaw: "multi-city, open jaw",
};
