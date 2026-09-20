import {
  summarizeTrip,
  type AccommodationProvider,
  type AccommodationStay,
  type CurrencyCode,
  type ProviderCallMetrics,
  type ProviderFailure,
  type DomainIssue,
  type SearchRequest,
  type Stay,
  type StaySearchQuery,
  type TripCandidate,
} from "@travel-optimizer/domain";

import type { StayInterval } from "./accommodation-stays.js";
import {
  canAffordStay,
  recordStaySkip,
  spendOnStay,
  type AccommodationSearchBudget,
  type SkippedStaySearch,
} from "./budget.js";
import { buildShortlist, type Shortlist } from "./accommodation-shortlist.js";
import {
  compareCandidates,
  type DestinationResult,
  type RankedCandidate,
} from "./flight-exploration.js";

/*
 * Pricing the shortlist (ADR 0016 §7).
 *
 * Shortlisted candidates often want the same bed: five itineraries that differ
 * only in their flights share one city, one set of dates and one party. Those
 * are one question, asked once.
 *
 * Nothing here assumes a provider. Until one is licensed the caller passes
 * none, and every stay comes back `not_searched / no_provider` — which is a
 * true statement about the trip, not a placeholder standing in for a price.
 */

export interface AccommodationSearchOptions {
  readonly provider?: AccommodationProvider;
  readonly budget: AccommodationSearchBudget;
  readonly travelers: number;
  readonly currency: CurrencyCode;
  readonly rooms?: number;
  readonly signal?: AbortSignal;
}

export interface AccommodationSearchResult {
  /** The coverage of every shortlisted candidate, by candidate id. */
  readonly byCandidate: ReadonlyMap<string, readonly AccommodationStay[]>;
  /** Distinct searches the shortlist implied. */
  readonly queriesPlanned: number;
  /** Of those, the ones a call was actually spent on. */
  readonly queriesMade: number;
  readonly failures: readonly ProviderFailure[];
  readonly metrics: readonly ProviderCallMetrics[];
}

/**
 * What identifies one accommodation search.
 *
 * Two candidates wanting the same city, dates and party are asking the same
 * question, however different their flights.
 */
export function stayQueryKey(query: StaySearchQuery): string {
  return [
    query.city.id,
    query.checkIn,
    query.checkOut,
    String(query.guests),
    String(query.rooms),
    query.currency,
  ].join("|");
}

function queryFor(
  interval: StayInterval,
  options: AccommodationSearchOptions,
): StaySearchQuery | undefined {
  // An unresolvable stay has no single city, so there is no search to make.
  if (interval.unresolved) return undefined;
  const city = interval.cities[0];
  // A stay whose city never resolved leaves only an airport to ask about, and
  // accommodation attaches to cities. Nothing to search rather than a guess.
  if (city.type !== "city") return undefined;
  return {
    city,
    checkIn: interval.checkIn,
    checkOut: interval.checkOut,
    guests: options.travelers,
    rooms: options.rooms ?? 1,
    currency: options.currency,
  };
}

/** What one distinct search came back with. */
type Answer =
  | { readonly kind: "priced"; readonly stay: Stay }
  /** The provider answered, and had nothing. */
  | { readonly kind: "empty" }
  /** The provider could not be reached. Not the same fact as `empty`. */
  | { readonly kind: "failed" }
  /** There was no budget left to ask. */
  | { readonly kind: "unasked" };

/** The cheapest stay a provider returned, deterministically. */
function cheapest(stays: readonly Stay[]): Stay | undefined {
  return [...stays]
    .sort((a, b) => a.price.amountMinor - b.price.amountMinor || a.id.localeCompare(b.id))
    .at(0);
}

/** The coverage an interval gets when nothing was asked about it. */
function unsearched(
  interval: StayInterval,
  reason: "no_provider" | "outside_shortlist" | "other",
): AccommodationStay {
  const shared = {
    checkIn: interval.checkIn,
    checkOut: interval.checkOut,
    nights: interval.nights,
  };
  if (interval.unresolved) {
    return {
      state: "unresolved",
      reason: "unresolved_open_jaw_split",
      cities: [...interval.cities],
      ...shared,
    };
  }
  return { state: "not_searched", reason, city: interval.cities[0], ...shared };
}

/** Turns one answer into the coverage it implies for an interval. */
function coverageFrom(
  answer: Answer,
  interval: StayInterval,
  query: StaySearchQuery,
): AccommodationStay {
  const shared = {
    city: query.city,
    checkIn: interval.checkIn,
    checkOut: interval.checkOut,
  };
  switch (answer.kind) {
    case "priced":
      return { state: "priced", ...shared, nights: answer.stay.nights, stay: answer.stay };
    case "empty":
      return {
        state: "unpriced",
        reason: "provider_no_results",
        ...shared,
        nights: interval.nights,
      };
    case "failed":
      return {
        state: "unpriced",
        reason: "provider_unavailable",
        ...shared,
        nights: interval.nights,
      };
    case "unasked":
      // No query ran, so this is not `unpriced`. The budget's skipped list
      // carries the precise reason; the coverage says only that we did not ask.
      return { state: "not_searched", reason: "other", ...shared, nights: interval.nights };
  }
}

/**
 * Prices the shortlist, asking each distinct question once.
 *
 * A provider failure leaves the stay `unpriced / provider_unavailable` and the
 * candidate otherwise intact: one source falling over must not invalidate a
 * transport itinerary that is perfectly good (spec §23).
 */
export async function searchAccommodation(
  shortlisted: readonly RankedCandidate[],
  options: AccommodationSearchOptions,
): Promise<AccommodationSearchResult> {
  const byCandidate = new Map<string, readonly AccommodationStay[]>();
  const failures: ProviderFailure[] = [];
  const metrics: ProviderCallMetrics[] = [];
  const { provider } = options;

  if (provider === undefined) {
    for (const candidate of shortlisted) {
      byCandidate.set(
        candidate.candidate.id,
        candidate.stayIntervals.map((interval) => unsearched(interval, "no_provider")),
      );
    }
    return { byCandidate, queriesPlanned: 0, queriesMade: 0, failures, metrics };
  }

  // The distinct questions, in a deterministic order, so the budget is spent
  // on the same searches however the candidates happened to be ordered.
  const queries = new Map<string, StaySearchQuery>();
  for (const candidate of shortlisted) {
    for (const interval of candidate.stayIntervals) {
      const query = queryFor(interval, options);
      if (query === undefined) continue;
      const key = stayQueryKey(query);
      if (!queries.has(key)) queries.set(key, query);
    }
  }

  const answers = new Map<string, Answer>();
  let queriesMade = 0;

  for (const [key, query] of queries) {
    if (!canAffordStay(options.budget, 1)) {
      const skipped: SkippedStaySearch = {
        stage: "accommodation",
        city: query.city,
        checkIn: query.checkIn,
        checkOut: query.checkOut,
        reason: "call_budget",
      };
      recordStaySkip(options.budget, skipped);
      answers.set(key, { kind: "unasked" });
      continue;
    }
    spendOnStay(options.budget, 1);
    queriesMade += 1;
    const result = await provider.search(
      query,
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    metrics.push(result.metrics);
    failures.push(...result.failures);

    if (result.status === "failed") {
      answers.set(key, { kind: "failed" });
      continue;
    }
    const best = cheapest(result.data);
    answers.set(key, best === undefined ? { kind: "empty" } : { kind: "priced", stay: best });
  }

  for (const candidate of shortlisted) {
    byCandidate.set(
      candidate.candidate.id,
      candidate.stayIntervals.map((interval) => {
        const query = queryFor(interval, options);
        if (query === undefined) return unsearched(interval, "other");
        const answer = answers.get(stayQueryKey(query));
        return answer === undefined
          ? unsearched(interval, "other")
          : coverageFrom(answer, interval, query);
      }),
    );
  }

  return { byCandidate, queriesPlanned: queries.size, queriesMade, failures, metrics };
}

export type ApplyAccommodationResult =
  | { readonly ok: true; readonly candidate: RankedCandidate }
  | { readonly ok: false; readonly issues: readonly DomainIssue[] };

/**
 * Puts coverage back on a candidate and recomputes its cost.
 *
 * Priced coverage is written to **both** `accommodation` and `stays` in one
 * step. They are two views of one fact, and the domain rejects a trip where
 * they disagree — so writing only one would make a correctly priced candidate
 * invalid, and it would vanish rather than complain.
 *
 * A candidate that cannot be re-summarized is returned as issues, never
 * silently dropped: a bad accommodation result must not delete a transport
 * itinerary that was perfectly good.
 */
export function applyAccommodation(
  candidate: RankedCandidate,
  entries: readonly AccommodationStay[],
): ApplyAccommodationResult {
  const priced = entries.flatMap((entry) => (entry.state === "priced" ? [entry.stay] : []));
  const trip: TripCandidate = {
    ...candidate.candidate,
    stays: priced,
    accommodation: [...entries],
  };
  const summarized = summarizeTrip(trip);
  if (!summarized.ok) return { ok: false, issues: summarized.issues };
  return {
    ok: true,
    candidate: { ...candidate, candidate: trip, summary: summarized.summary },
  };
}

export interface PriceDestinationsOptions extends AccommodationSearchOptions {
  readonly request: SearchRequest;
  /** How many candidates may be priced (ADR 0016 §5). */
  readonly shortlistLimit: number;
}

export interface PricedDestinations {
  readonly destinations: readonly DestinationResult[];
  readonly shortlist: Shortlist;
  readonly search: AccommodationSearchResult;
  /** Candidates whose coverage could not be applied, which is a defect. */
  readonly issues: readonly DomainIssue[];
}

/**
 * Prices a search's finalists and re-ranks everything around them.
 *
 * The order after pricing may differ substantially from the transport order
 * that chose the shortlist. That is the point: a trip is judged on what it
 * costs to take, not on its fares alone.
 */
export async function priceDestinations(
  destinations: readonly DestinationResult[],
  options: PriceDestinationsOptions,
): Promise<PricedDestinations> {
  const all = destinations.flatMap((destination) => destination.candidates);
  const shortlist = buildShortlist(all, {
    request: options.request,
    limit: options.shortlistLimit,
  });
  const search = await searchAccommodation(shortlist.selected, options);
  const issues: DomainIssue[] = [];

  // Anything not priced says why it was not: no provider at all, or a
  // shortlist it did not make. Never "unpriced", which would claim an answer.
  const fallback = options.provider === undefined ? "no_provider" : "outside_shortlist";
  const updated = new Map<string, RankedCandidate>();
  for (const candidate of all) {
    const entries =
      search.byCandidate.get(candidate.candidate.id) ??
      candidate.stayIntervals.map((interval) => unsearched(interval, fallback));
    const applied = applyAccommodation(candidate, entries);
    if (applied.ok) {
      updated.set(candidate.candidate.id, applied.candidate);
      continue;
    }
    // Keep the transport candidate rather than losing it to a coverage defect.
    updated.set(candidate.candidate.id, candidate);
    issues.push(...applied.issues);
  }

  const repriced = destinations
    .map((destination) => ({
      ...destination,
      candidates: destination.candidates
        .map((candidate) => updated.get(candidate.candidate.id) ?? candidate)
        .sort(compareCandidates),
    }))
    .sort((a, b) => {
      const [first] = a.candidates;
      const [second] = b.candidates;
      if (first === undefined || second === undefined) return 0;
      const byCandidate = compareCandidates(first, second);
      if (byCandidate !== 0) return byCandidate;
      const aKey = a.city?.id ?? a.airports[0]?.id ?? "";
      const bKey = b.city?.id ?? b.airports[0]?.id ?? "";
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });

  return { destinations: repriced, shortlist, search, issues };
}
