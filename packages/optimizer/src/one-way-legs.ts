import type { TransportOffer, TransportSegment } from "@travel-optimizer/domain";

/*
 * One-way fares, and the order they are considered in.
 *
 * Shared deliberately. Discovery uses this to decide which second cities are
 * worth a way-home query, and composition uses it to decide which legs to pair.
 * If the two disagreed, a search could spend a provider call on a second city
 * the optimizer then discards (ADR 0015 §7).
 */

/** A one-way fare over exactly one segment. */
export interface OneWayLeg {
  readonly offer: TransportOffer;
  readonly segment: TransportSegment;
}

/**
 * Fares kept per airport before pairing.
 *
 * Composition is quadratic, so this caps the work while keeping the cheapest
 * options (spec §15 pruning).
 */
export const MAX_OFFERS_PER_AIRPORT = 8;

export function oneWayLegs(
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
export function rankLegs(legs: readonly OneWayLeg[], cap: number): OneWayLeg[] {
  return [...legs]
    .sort(
      (a, b) =>
        a.offer.price.amountMinor - b.offer.price.amountMinor ||
        a.segment.id.localeCompare(b.segment.id),
    )
    .slice(0, cap);
}

/** The legs of `legs` that depart from one airport, cheapest first, capped. */
export function legsFrom(
  legs: readonly OneWayLeg[],
  airportId: string,
  cap: number,
): OneWayLeg[] {
  return rankLegs(
    legs.filter((leg) => leg.segment.origin.id === airportId),
    cap,
  );
}
