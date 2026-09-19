import {
  type AirportGeography,
  type ItineraryGap,
  type Location,
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
 * Composing itineraries from one-way fares (Phase 3, patterns 1 and 2).
 *
 *   round trip : SJJ -> A  +  A -> SJJ
 *   open jaw   : SJJ -> A  +  B -> SJJ, with A -> B left to the traveler
 *
 * The A -> B sector is an unpriced gap, never an estimate and never omitted
 * silently (ADR 0014). Multi-city is Phase 3b.
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
}

export const DEFAULT_COMPOSITION_CONFIG: CompositionConfig = {
  maxUnpricedGapKm: 800,
  maxOffersPerAirport: 8,
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
  readonly geography: AirportGeography;
  readonly config?: CompositionConfig;
}

function gapBetween(
  from: Location,
  to: Location,
  geography: AirportGeography,
): ItineraryGap {
  const distanceKm = geography.distanceBetween(from, to);
  return {
    id: `gap:${from.id}->${to.id}`,
    from,
    to,
    ...(Number.isFinite(distanceKm) && distanceKm > 0 ? { distanceKm } : {}),
    status: "unpriced",
    reason: "no_licensed_source",
  };
}

/**
 * Pairs outbound and return fares into itineraries.
 *
 * Every pair is assembled and judged by the same rules as a provider round
 * trip: access transfers, connection feasibility, window, nights and budget.
 */
export function composeItineraries(input: ComposeInput): CompositionResult {
  const config = input.config ?? DEFAULT_COMPOSITION_CONFIG;
  const { discovery, geography } = input;

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
    const [sample] = outbounds;
    if (sample === undefined) continue;
    const arrival = sample.segment.destination;

    // Destinations with no way home are counted from the discovery record,
    // which knows about every destination, not just the ones reached here.
    const departureAirports = [...returnByAirport.keys()].sort();

    for (const outbound of outbounds) {
      for (const departureId of departureAirports) {
        const returns = returnByAirport.get(departureId) ?? [];
        const [returnSample] = returns;
        if (returnSample === undefined) continue;
        const departurePoint = returnSample.segment.origin;

        // Same airport: an ordinary composed round trip, nothing unpriced.
        const isRoundTrip = departureId === arrivalId;
        let gaps: ItineraryGap[] = [];
        if (!isRoundTrip) {
          if (!input.request.allowOpenJaw) continue;
          const gap = gapBetween(arrival, departurePoint, geography);
          if (gap.distanceKm === undefined || gap.distanceKm > config.maxUnpricedGapKm) {
            counts.rejectedGapTooFar = (counts.rejectedGapTooFar ?? 0) + 1;
            continue;
          }
          gaps = [gap];
        }

        for (const homeward of returns) {
          // A way home that leaves before the outbound lands is rejected inside
          // assembly, which checks every junction rather than only this one.
          record(
            assembleCandidate({
              id: `trip:${outbound.offer.id}+${homeward.offer.id}`,
              legs: [outbound.segment, homeward.segment],
              offers: [outbound.offer, homeward.offer],
              gaps,
              request: input.request,
              window: input.window,
              context: input.context,
            }),
          );
        }
      }
    }
  }

  return { attempts, counts, issues };
}
