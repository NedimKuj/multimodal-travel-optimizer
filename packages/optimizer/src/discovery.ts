import type {
  CurrencyCode,
  FlightProvider,
  Location,
  ProviderCallMetrics,
  ProviderFailure,
  TransportOffer,
  TransportSegment,
} from "@travel-optimizer/domain";

import {
  canAfford,
  costOfQuery,
  createSearchBudget,
  DEFAULT_CALL_BUDGET,
  recordSkip,
  spend,
  type SkippedQuery,
} from "./budget.js";
import type { SelectedOrigin } from "./origin-expansion.js";
import type { TravelWindow } from "./travel-window.js";

/*
 * Two-stage one-way discovery (docs/implementation-plan.md §48).
 *
 * Stage 1 asks one broad question: where can we fly from here? Stage 2 spends
 * what the budget has left finding ways home, for destinations chosen
 * deterministically rather than by whatever order the provider answered in.
 *
 * The call budget is an application-level safety limit shared by every optional
 * dimension of a search. It is not a claim about the provider's own quota,
 * which is unverified (docs/provider-compliance.md).
 */

export interface EnrichmentRecord {
  readonly airport: Location;
  /** Cheapest outbound fare found for it, in minor units. */
  readonly cheapestOutboundMinor: number;
  readonly returnOffersFound: number;
}

/** A destination whose return legs were never queried (`budget.ts`). */
export interface SkippedDestination extends SkippedQuery {
  readonly cheapestOutboundMinor: number;
}

export interface DiscoveryResult {
  readonly outboundSegments: readonly TransportSegment[];
  readonly outboundOffers: readonly TransportOffer[];
  /** Return legs keyed by the destination airport they depart from. */
  readonly returnsByAirport: ReadonlyMap<
    string,
    { readonly segments: readonly TransportSegment[]; readonly offers: readonly TransportOffer[] }
  >;
  readonly enriched: readonly EnrichmentRecord[];
  readonly skipped: readonly SkippedDestination[];
  readonly failures: readonly ProviderFailure[];
  readonly metrics: readonly ProviderCallMetrics[];
  /** Provider calls this search planned, against the budget. */
  readonly callsPlanned: number;
  readonly callBudget: number;
  readonly status: "ok" | "partial" | "failed";
}

export interface DiscoveryOptions {
  readonly window: TravelWindow;
  readonly currency: CurrencyCode;
  readonly travelers: number;
  readonly origins: readonly SelectedOrigin[];
  readonly callBudget?: number;
  /** Cap on destinations enriched, before the budget is even considered. */
  readonly maxEnrichedDestinations?: number;
  readonly signal?: AbortSignal;
}

interface Candidate {
  readonly airport: Location;
  readonly cheapestOutboundMinor: number;
}

/** Cheapest outbound fare first, then IATA: a total order, so runs repeat. */
function rankDestinations(
  segments: readonly TransportSegment[],
  offers: readonly TransportOffer[],
): Candidate[] {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const cheapest = new Map<string, Candidate>();

  for (const offer of offers) {
    const [segmentId] = offer.segmentIds;
    if (segmentId === undefined || offer.segmentIds.length !== 1) continue;
    const segment = byId.get(segmentId);
    if (segment === undefined) continue;
    const airport = segment.destination;
    const current = cheapest.get(airport.id);
    if (current === undefined || offer.price.amountMinor < current.cheapestOutboundMinor) {
      cheapest.set(airport.id, { airport, cheapestOutboundMinor: offer.price.amountMinor });
    }
  }

  return [...cheapest.values()].sort(
    (a, b) =>
      a.cheapestOutboundMinor - b.cheapestOutboundMinor ||
      (a.airport.iata ?? a.airport.id).localeCompare(b.airport.iata ?? b.airport.id),
  );
}

/**
 * Runs the funnel: one outbound discovery call, then return-leg queries for as
 * many destinations as the remaining budget allows.
 */
export async function discoverOneWayLegs(
  provider: FlightProvider,
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const callBudget =
    options.callBudget ?? provider.descriptor.maxCallsPerSearch ?? DEFAULT_CALL_BUDGET;
  const budget = createSearchBudget(callBudget);
  const failures: ProviderFailure[] = [];
  const metrics: ProviderCallMetrics[] = [];
  const originCodes = options.origins.map((origin) => origin.airport.iata ?? origin.airport.id);
  const [primary] = options.origins;

  // Stage 1 asks every origin the same broad question, so it costs a call per
  // departure month per origin.
  const outboundCost = costOfQuery(options.window.departure) * originCodes.length;
  spend(budget, outboundCost);
  const outbound = await provider.search(
    {
      origins: originCodes,
      destinations: "anywhere",
      departureDates: options.window.departure,
      travelers: options.travelers,
      currency: options.currency,
    },
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  metrics.push(outbound.metrics);
  failures.push(...outbound.failures);

  if (outbound.status === "failed" || primary === undefined) {
    return {
      outboundSegments: [],
      outboundOffers: [],
      returnsByAirport: new Map(),
      enriched: [],
      skipped: [],
      failures,
      metrics,
      callsPlanned: budget.usedProviderCalls,
      callBudget,
      status: "failed",
    };
  }

  const ranked = rankDestinations(outbound.data.segments, outbound.data.offers);
  const shortlist = ranked.slice(0, options.maxEnrichedDestinations ?? ranked.length);

  const returnsByAirport = new Map<
    string,
    { segments: readonly TransportSegment[]; offers: readonly TransportOffer[] }
  >();
  const enriched: EnrichmentRecord[] = [];
  const skipped: SkippedDestination[] = [];

  const returnCallCost = costOfQuery(options.window.return);
  const homeCode = primary.airport.iata ?? primary.airport.id;

  const skip = (candidate: Candidate, reason: SkippedQuery["reason"]): void => {
    const record = {
      stage: "return" as const,
      airport: candidate.airport,
      cheapestOutboundMinor: candidate.cheapestOutboundMinor,
      reason,
    };
    skipped.push(record);
    recordSkip(budget, record);
  };

  for (const candidate of shortlist) {
    if (!canAfford(budget, returnCallCost)) {
      skip(candidate, "call_budget");
      continue;
    }

    const code = candidate.airport.iata ?? candidate.airport.id;
    spend(budget, returnCallCost);
    const back = await provider.search(
      {
        origins: [code],
        destinations: [homeCode],
        departureDates: options.window.return,
        travelers: options.travelers,
        currency: options.currency,
      },
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    metrics.push(back.metrics);
    failures.push(...back.failures);

    if (back.status === "failed") {
      enriched.push({ ...candidate, returnOffersFound: 0 });
      continue;
    }
    returnsByAirport.set(candidate.airport.id, {
      segments: back.data.segments,
      offers: back.data.offers,
    });
    enriched.push({ ...candidate, returnOffersFound: back.data.offers.length });
  }

  // Destinations past the enrichment cap were never candidates for a call: a
  // limit of ours stopped them, not the budget.
  for (const candidate of ranked.slice(shortlist.length)) {
    skip(candidate, "cap");
  }

  return {
    outboundSegments: outbound.data.segments,
    outboundOffers: outbound.data.offers,
    returnsByAirport,
    enriched,
    skipped,
    failures,
    metrics,
    callsPlanned: budget.usedProviderCalls,
    callBudget,
    status: failures.length > 0 ? "partial" : "ok",
  };
}
