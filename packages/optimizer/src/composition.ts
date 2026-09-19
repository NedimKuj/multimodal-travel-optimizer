import {
  type SearchRequest,
  type TransportOffer,
  type TransportSegment,
} from "@travel-optimizer/domain";

import type { DiscoveryResult } from "./discovery.js";
import {
  assembleCandidate,
  type CandidateAttempt,
  type CandidateContext,
  type ExplorationCounts,
} from "./flight-exploration.js";
import type { TravelWindow } from "./travel-window.js";

/*
 * Composing itineraries from one-way fares.
 *
 *   round trip : SJJ -> A  +  A -> SJJ                      (pattern 1)
 *   open jaw   : SJJ -> A  +  B -> SJJ                      (pattern 2)
 *   multi-city : SJJ -> A  +  A -> B  +  B -> SJJ           (pattern 3)
 *                SJJ -> A  +  A -> B  +  C -> SJJ           (pattern 4)
 *
 * Patterns 2 and 4 leave one sector to the traveler. It is an unpriced gap,
 * never an estimate and never omitted silently (ADR 0014). Where the gap runs
 * from and to is decided during assembly, where the transfers that determine
 * its endpoints are known (ADR 0015).
 */

export interface CompositionConfig {
  /**
   * How far apart an open jaw's two cities may be. Beyond this the sector is
   * not a journey a traveler would plausibly arrange themselves, so the pair
   * is not offered at all rather than offered with a caveat.
   */
  readonly maxUnpricedGapKm: number;
  /**
   * Fares kept per airport before pairing. Composition is quadratic, so this
   * caps the work while keeping the cheapest options (spec §15 pruning).
   */
  readonly maxOffersPerAirport: number;
  /**
   * Nights required in each city a multi-stop trip stops at. A city passed
   * through in an afternoon is a connection, not a destination (ADR 0015 §4).
   */
  readonly minNightsPerCity: number;
}

export const DEFAULT_COMPOSITION_CONFIG: CompositionConfig = {
  maxUnpricedGapKm: 800,
  maxOffersPerAirport: 8,
  minNightsPerCity: 1,
};

/** A one-way fare over exactly one segment. */
interface OneWayLeg {
  readonly offer: TransportOffer;
  readonly segment: TransportSegment;
}

function oneWayLegs(
  segments: readonly TransportSegment[],
  offers: readonly TransportOffer[],
): OneWayLeg[] {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const legs: OneWayLeg[] = [];
  for (const offer of offers) {
    if (offer.segmentIds.length !== 1) continue;
    const [segmentId] = offer.segmentIds;
    const segment = segmentId === undefined ? undefined : byId.get(segmentId);
    if (segment === undefined) continue;
    legs.push({ offer, segment });
  }
  return legs;
}

/** Cheapest first, then segment id: deterministic before any capping. */
function rankLegs(legs: readonly OneWayLeg[], cap: number): OneWayLeg[] {
  return [...legs]
    .sort(
      (a, b) =>
        a.offer.price.amountMinor - b.offer.price.amountMinor ||
        a.segment.id.localeCompare(b.segment.id),
    )
    .slice(0, cap);
}

function groupByAirport(
  legs: readonly OneWayLeg[],
  side: "destination" | "origin",
): Map<string, OneWayLeg[]> {
  const grouped = new Map<string, OneWayLeg[]>();
  for (const leg of legs) {
    const airport = side === "destination" ? leg.segment.destination : leg.segment.origin;
    const list = grouped.get(airport.id);
    if (list === undefined) grouped.set(airport.id, [leg]);
    else list.push(leg);
  }
  return grouped;
}

export interface CompositionResult {
  readonly attempts: readonly CandidateAttempt[];
  readonly counts: Partial<Record<keyof ExplorationCounts, number>>;
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}

export interface ComposeInput {
  readonly discovery: DiscoveryResult;
  readonly request: SearchRequest;
  readonly window: TravelWindow;
  readonly context: CandidateContext;
  readonly config?: CompositionConfig;
}

/**
 * Pairs outbound and return fares into itineraries.
 *
 * Every pair is assembled and judged by the same rules as a provider round
 * trip: access transfers, connection feasibility, window, nights and budget.
 */
export function composeItineraries(input: ComposeInput): CompositionResult {
  const config = input.config ?? DEFAULT_COMPOSITION_CONFIG;
  const { discovery } = input;

  const outboundByAirport = groupByAirport(
    oneWayLegs(discovery.outboundSegments, discovery.outboundOffers),
    "destination",
  );

  const returnByAirport = new Map<string, OneWayLeg[]>();
  for (const [airportId, legs] of discovery.returnsByAirport) {
    const homeward = oneWayLegs(legs.segments, legs.offers).filter(
      (leg) => leg.segment.origin.id === airportId,
    );
    if (homeward.length > 0) returnByAirport.set(airportId, rankLegs(homeward, config.maxOffersPerAirport));
  }

  // Onward legs exist only for the few destinations the budget reached, which
  // is what keeps three-leg pairing bounded without a cap of its own.
  const onwardByAirport = new Map<string, OneWayLeg[]>();
  if (input.request.allowMultiCity) {
    for (const [airportId, legs] of discovery.onwardByAirport) {
      const forward = oneWayLegs(legs.segments, legs.offers).filter(
        (leg) => leg.segment.origin.id === airportId,
      );
      if (forward.length > 0) {
        onwardByAirport.set(airportId, rankLegs(forward, config.maxOffersPerAirport));
      }
    }
  }

  const attempts: CandidateAttempt[] = [];
  const issues: { code: string; message: string }[] = [];
  // Typed against the counter names, so a typo cannot quietly vanish.
  const counts: Partial<Record<keyof ExplorationCounts, number>> = {
    rejectedInfeasible: 0,
    rejectedInvalid: 0,
    rejectedOutsideWindow: 0,
    rejectedNights: 0,
    rejectedBudget: 0,
    rejectedGapTooFar: 0,
    rejectedReturnBeforeArrival: 0,
    rejectedStayTooShort: 0,
    secondCitiesReached: 0,
    secondCitiesWithoutReturn: 0,
  };

  const record = (outcome: ReturnType<typeof assembleCandidate>): void => {
    if (outcome.ok) {
      attempts.push(outcome.attempt);
      return;
    }
    counts[outcome.counter] = (counts[outcome.counter] ?? 0) + 1;
    if (outcome.issue !== undefined) issues.push(outcome.issue);
  };

  const arrivalAirports = [...outboundByAirport.keys()].sort();
  for (const arrivalId of arrivalAirports) {
    const outbounds = rankLegs(outboundByAirport.get(arrivalId) ?? [], config.maxOffersPerAirport);
    if (outbounds.length === 0) continue;

    // Destinations with no way home are counted from the discovery record,
    // which knows about every destination, not just the ones reached here.
    const departureAirports = [...returnByAirport.keys()].sort();

    for (const outbound of outbounds) {
      for (const departureId of departureAirports) {
        const returns = returnByAirport.get(departureId) ?? [];
        if (returns.length === 0) continue;

        // Flying home from somewhere else is only on offer when it was asked
        // for. How far that sector stretches is judged during assembly, where
        // the transfers that decide its endpoints are known.
        if (departureId !== arrivalId && !input.request.allowOpenJaw) continue;

        for (const homeward of returns) {
          // A way home that leaves before the outbound lands is rejected inside
          // assembly, which checks every junction rather than only this one.
          record(
            assembleCandidate({
              id: `trip:${outbound.offer.id}+${homeward.offer.id}`,
              legs: [outbound.segment, homeward.segment],
              offers: [outbound.offer, homeward.offer],
              request: input.request,
              window: input.window,
              context: input.context,
              maxUnpricedGapKm: config.maxUnpricedGapKm,
              stayRules: { minNightsPerStay: config.minNightsPerCity },
            }),
          );
        }
      }

      // Patterns 3 and 4: on from A to a second city before heading home.
      for (const onward of onwardByAirport.get(arrivalId) ?? []) {
        const secondId = onward.segment.destination.id;
        // Flying on to where the trip already is makes no second city.
        if (secondId === arrivalId) continue;

        for (const departureId of departureAirports) {
          const returns = returnByAirport.get(departureId) ?? [];
          if (returns.length === 0) continue;
          // Leaving from anywhere but the second city is an open jaw with a
          // priced leg before it, so it needs the same permission.
          if (departureId !== secondId && !input.request.allowOpenJaw) continue;

          for (const homeward of returns) {
            record(
              assembleCandidate({
                id: `trip:${outbound.offer.id}+${onward.offer.id}+${homeward.offer.id}`,
                legs: [outbound.segment, onward.segment, homeward.segment],
                offers: [outbound.offer, onward.offer, homeward.offer],
                request: input.request,
                window: input.window,
                context: input.context,
                maxUnpricedGapKm: config.maxUnpricedGapKm,
                stayRules: { minNightsPerStay: config.minNightsPerCity },
              }),
            );
          }
        }
      }
    }
  }

  // Return legs are queried for the destinations stage 1 found, so a second
  // city reached by an onward leg may have no retrieved way home at all. That
  // is a real limit of the data, and it explains a thin multi-city result.
  const secondCities = new Set<string>();
  const strandedSecondCities = new Set<string>();
  for (const legs of onwardByAirport.values()) {
    for (const leg of legs) {
      const secondId = leg.segment.destination.id;
      secondCities.add(secondId);
      if (!returnByAirport.has(secondId)) strandedSecondCities.add(secondId);
    }
  }
  counts.secondCitiesReached = secondCities.size;
  counts.secondCitiesWithoutReturn = strandedSecondCities.size;

  return { attempts, counts, issues };
}
