import { z } from "zod";

import { staySchema, type Stay } from "./accommodation.js";
import { DomainError, type DomainIssue } from "./errors.js";
import { locationSchema, type Location } from "./location.js";
import type { CurrencyCode } from "./money/currency.js";
import { addMoney, allocateEvenly, sumMoney, type Money } from "./money/money.js";
import { weakestSourceType, type SourceType } from "./provenance.js";
import { addDays, compareLocalDates, type LocalDate } from "./time/local-date.js";
import { compareZonedTimestamps, localDate, minutesBetween } from "./time/zoned-timestamp.js";
import {
  offerPriceForTravelers,
  transportOfferSchema,
  transportSegmentSchema,
  validateOfferSegments,
  type TransportSegment,
} from "./transport.js";

// See docs/decisions/0004-trip-candidate-and-budget-shape.md.

/**
 * A complete trip: an ordered sequence of segments, the offers that price
 * them, and the stays between them. Everything else is derived by
 * `summarizeTrip`, so derived values can never drift from the itinerary.
 *
 * No round-trip assumption is made: the last segment need not return to the
 * origin airport, and consecutive segments need not share a location
 * (open-jaw).
 */
export const tripCandidateSchema = z.object({
  id: z.string().min(1),
  origin: locationSchema,
  travelers: z.number().int().positive(),
  segments: z.array(transportSegmentSchema),
  offers: z.array(transportOfferSchema),
  stays: z.array(staySchema),
});

export type TripCandidate = z.infer<typeof tripCandidateSchema>;

function issue(code: string, message: string): DomainIssue {
  return { code, message };
}

function findDuplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

/**
 * Checks structural invariants of a trip candidate and returns every issue.
 *
 * Covered here:
 * - at least one segment; unique ids
 * - segments in chronological order without overlap, starting at the origin
 * - every segment priced by exactly one offer; offers reference only trip
 *   segments in order; offer price bases match the party size
 * - stays sized for the party, between an arrival and the next departure
 *   (by local date), and not overlapping each other
 * - one currency across all prices (convert explicitly beforehand)
 *
 * Not covered yet, because they need geography or configuration that does not
 * exist yet: minimum connection times, airport/station ↔ city relationships
 * (whether a stay's city matches where the traveler is), and ground transfers.
 *
 * Nights on the ground without a stay are not an error: they are reported by
 * `summarizeTrip` as `uncoveredNights`, and the cost scope says so
 * (docs/decisions/0005-trip-metrics-and-accommodation-coverage.md).
 *
 * Known limitation: time on the ground is bounded by the next departure, so a
 * trip whose last segment does not return to the origin cannot yet carry a
 * stay after its final arrival.
 */
export function validateTripCandidate(trip: TripCandidate): DomainIssue[] {
  const issues: DomainIssue[] = [];
  const { segments, offers, stays } = trip;

  const first = segments[0];
  if (first === undefined) {
    return [issue("TRIP_WITHOUT_SEGMENTS", "A trip must contain at least one segment")];
  }

  for (const id of findDuplicates(segments.map((segment) => segment.id))) {
    issues.push(issue("DUPLICATE_SEGMENT_ID", `Segment id ${id} appears more than once`));
  }
  for (const id of findDuplicates(offers.map((offer) => offer.id))) {
    issues.push(issue("DUPLICATE_OFFER_ID", `Offer id ${id} appears more than once`));
  }
  for (const id of findDuplicates(stays.map((stay) => stay.id))) {
    issues.push(issue("DUPLICATE_STAY_ID", `Stay id ${id} appears more than once`));
  }

  if (first.origin.id !== trip.origin.id) {
    issues.push(
      issue(
        "TRIP_DOES_NOT_START_AT_ORIGIN",
        `First segment departs from ${first.origin.id}, not the trip origin ${trip.origin.id}`,
      ),
    );
  }

  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (previous === undefined || current === undefined) continue;
    if (compareZonedTimestamps(current.departureAt, previous.arrivalAt) < 0) {
      issues.push(
        issue(
          "SEGMENTS_NOT_CHRONOLOGICAL",
          `Segment ${current.id} departs before segment ${previous.id} arrives`,
        ),
      );
    }
  }

  // Offer coverage: each segment priced exactly once.
  const coverage = new Map<string, string[]>(segments.map((segment) => [segment.id, []]));
  for (const offer of offers) {
    issues.push(...validateOfferSegments(offer, segments));
    for (const segmentId of offer.segmentIds) {
      coverage.get(segmentId)?.push(offer.id);
    }
    try {
      offerPriceForTravelers(offer, trip.travelers);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      issues.push(issue(error.code, error.message));
    }
  }
  for (const [segmentId, offerIds] of coverage) {
    if (offerIds.length === 0) {
      issues.push(
        issue("UNPRICED_SEGMENT", `Segment ${segmentId} is not covered by any selected offer`),
      );
    } else if (offerIds.length > 1) {
      issues.push(
        issue(
          "SEGMENT_PRICED_MORE_THAN_ONCE",
          `Segment ${segmentId} is covered by offers ${offerIds.join(", ")}`,
        ),
      );
    }
  }

  issues.push(...validateStays(trip));

  const currencies = new Set<CurrencyCode>([
    ...offers.map((offer) => offer.price.currency),
    ...stays.map((stay) => stay.price.currency),
  ]);
  if (currencies.size > 1) {
    issues.push(
      issue(
        "MIXED_CURRENCIES",
        `Prices use ${[...currencies].sort().join(", ")}; convert explicitly to one currency first`,
      ),
    );
  }

  return issues;
}

interface GroundGap {
  readonly arrivalDate: LocalDate;
  readonly departureDate: LocalDate;
}

/** Periods on the ground between consecutive segments, in local dates. */
function groundGaps(segments: readonly TransportSegment[]): GroundGap[] {
  const gaps: GroundGap[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const next = segments[index];
    if (previous === undefined || next === undefined) continue;
    gaps.push({
      arrivalDate: localDate(previous.arrivalAt),
      departureDate: localDate(next.departureAt),
    });
  }
  return gaps;
}

/**
 * Local dates of the nights spent on the ground in `gap`. A night is named by
 * the date it starts on, so an arrival on the 26th and a departure on the 29th
 * means the nights of the 26th, 27th and 28th.
 */
function nightsInGap(gap: GroundGap): LocalDate[] {
  const nights: LocalDate[] = [];
  let night = gap.arrivalDate;
  while (compareLocalDates(night, gap.departureDate) < 0) {
    nights.push(night);
    night = addDays(night, 1);
  }
  return nights;
}

function nightIsCovered(night: LocalDate, stays: readonly Stay[]): boolean {
  return stays.some(
    (stay) =>
      compareLocalDates(stay.checkIn, night) <= 0 && compareLocalDates(night, stay.checkOut) < 0,
  );
}

function stayFitsGap(stay: Stay, gap: GroundGap): boolean {
  return (
    compareLocalDates(gap.arrivalDate, stay.checkIn) <= 0 &&
    compareLocalDates(stay.checkOut, gap.departureDate) <= 0
  );
}

function validateStays(trip: TripCandidate): DomainIssue[] {
  const issues: DomainIssue[] = [];
  const gaps = groundGaps(trip.segments);

  for (const stay of trip.stays) {
    if (stay.guests !== trip.travelers) {
      issues.push(
        issue(
          "STAY_GUEST_COUNT_MISMATCH",
          `Stay ${stay.id} is for ${stay.guests} guests, but the trip has ${trip.travelers} travelers`,
        ),
      );
    }
    // Check-in on or after the arrival date and check-out on or before the
    // next departure date: no nights booked before arriving or after leaving.
    if (!gaps.some((gap) => stayFitsGap(stay, gap))) {
      issues.push(
        issue(
          "STAY_OUTSIDE_GROUND_TIME",
          `Stay ${stay.id} (${stay.checkIn}..${stay.checkOut}) does not fall between an arrival and the next departure`,
        ),
      );
    }
  }

  const ordered = [...trip.stays].sort((a, b) => compareLocalDates(a.checkIn, b.checkIn));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous === undefined || current === undefined) continue;
    if (compareLocalDates(current.checkIn, previous.checkOut) < 0) {
      issues.push(
        issue("OVERLAPPING_STAYS", `Stays ${previous.id} and ${current.id} overlap`),
      );
    }
  }

  return issues;
}

/**
 * `complete`: transport and every night on the ground are priced.
 * `transport_and_partial_accommodation`: some nights have no stay, so this
 * total is not a complete-trip cost.
 */
export type TripCostScope = "complete" | "transport_and_partial_accommodation";

export interface TripCost {
  /** Sum of selected transport offers for the whole party. */
  readonly transport: Money;
  /** Sum of stays for the whole party. */
  readonly accommodation: Money;
  readonly total: Money;
  /**
   * What `total` covers. Totals of different scopes must not be compared
   * (docs/optimizer-spec.md §19).
   */
  readonly scope: TripCostScope;
  /**
   * The total split across travelers; shares differ by at most one minor unit
   * and always sum to `total`.
   */
  readonly perPersonShares: readonly Money[];
}

export interface TripSummary {
  readonly departureDate: LocalDate;
  readonly returnDate: LocalDate;
  /** Stay cities in visiting order (consecutive repeats collapsed). */
  readonly destinations: readonly Location[];
  /** Nights covered by a stay. */
  readonly nights: number;
  /**
   * Local dates of nights spent on the ground with no stay booked. A night on
   * an overnight train or flight is not a night on the ground.
   */
  readonly uncoveredNights: readonly LocalDate[];
  readonly cost: TripCost;
  /** Time spent moving: the sum of segment durations. */
  readonly travelTimeMinutes: number;
  /** First departure to last arrival. */
  readonly totalDurationMinutes: number;
  /** Number of transport segments. */
  readonly legs: number;
  /** Intermediate stops inside segments. */
  readonly stops: number;
  /** Changes between consecutive segments with no stay in between. */
  readonly connections: number;
  /** The weakest source type of any price in the trip. */
  readonly sourceType: SourceType;
  /** Providers of all prices, sorted. */
  readonly sources: readonly string[];
}

export type SummarizeTripResult =
  | { readonly ok: true; readonly summary: TripSummary }
  | { readonly ok: false; readonly issues: readonly DomainIssue[] };

/**
 * Validates a trip and derives its dates, cost, time and provenance.
 * Invalid trips have no summary, so an incomplete or inconsistent itinerary
 * can never be shown with a total cost.
 */
export function summarizeTrip(trip: TripCandidate): SummarizeTripResult {
  const issues = validateTripCandidate(trip);
  const first = trip.segments[0];
  const last = trip.segments.at(-1);
  if (issues.length > 0 || first === undefined || last === undefined) {
    return { ok: false, issues };
  }

  // A valid trip has at least one segment and every segment is covered by an
  // offer, so there is always at least one offer; guard anyway.
  const currency = trip.offers[0]?.price.currency;
  if (currency === undefined) {
    return {
      ok: false,
      issues: [issue("TRIP_WITHOUT_PRICES", "A trip must contain at least one price")],
    };
  }

  const transport = sumMoney(
    trip.offers.map((offer) => offerPriceForTravelers(offer, trip.travelers)),
    currency,
  );
  const accommodation = sumMoney(
    trip.stays.map((stay) => stay.price),
    currency,
  );
  const total = addMoney(transport, accommodation);

  const staysInOrder = [...trip.stays].sort((a, b) => compareLocalDates(a.checkIn, b.checkIn));
  const destinations: Location[] = [];
  for (const stay of staysInOrder) {
    if (destinations.at(-1)?.id !== stay.city.id) destinations.push(stay.city);
  }

  const gaps = groundGaps(trip.segments);
  const connections = gaps.filter(
    (gap) => !trip.stays.some((stay) => stayFitsGap(stay, gap)),
  ).length;
  const uncoveredNights = gaps
    .flatMap(nightsInGap)
    .filter((night) => !nightIsCovered(night, trip.stays));

  const sourceType = weakestSourceType([
    ...trip.offers.map((offer) => offer.provenance.sourceType),
    ...trip.stays.map((stay) => stay.provenance.sourceType),
  ]);
  if (sourceType === undefined) {
    return {
      ok: false,
      issues: [issue("TRIP_WITHOUT_PRICES", "A trip must contain at least one price")],
    };
  }

  return {
    ok: true,
    summary: {
      departureDate: localDate(first.departureAt),
      returnDate: localDate(last.arrivalAt),
      destinations,
      nights: trip.stays.reduce((nights, stay) => nights + stay.nights, 0),
      uncoveredNights,
      cost: {
        transport,
        accommodation,
        total,
        scope:
          uncoveredNights.length === 0 ? "complete" : "transport_and_partial_accommodation",
        perPersonShares: allocateEvenly(total, trip.travelers),
      },
      travelTimeMinutes: trip.segments.reduce(
        (minutes, segment) => minutes + segment.durationMinutes,
        0,
      ),
      totalDurationMinutes: minutesBetween(first.departureAt, last.arrivalAt),
      legs: trip.segments.length,
      stops: trip.segments.reduce((count, segment) => count + segment.transfers, 0),
      connections,
      sourceType,
      sources: [
        ...new Set([
          ...trip.offers.map((offer) => offer.provenance.provider),
          ...trip.stays.map((stay) => stay.provenance.provider),
        ]),
      ].sort(),
    },
  };
}
