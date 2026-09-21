import { z } from "zod";

import {
  accommodationStaySchema,
  staySchema,
  type AccommodationStay,
  type Stay,
} from "./accommodation.js";
import { DomainError, type DomainIssue } from "./errors.js";
import { locationSchema, type Location } from "./location.js";
import type { CurrencyCode } from "./money/currency.js";
import { addMoney, allocateEvenly, sumMoney, type Money } from "./money/money.js";
import { weakestSourceType, type SourceType } from "./provenance.js";
import {
  addDays,
  compareLocalDates,
  localDateSchema,
  type LocalDate,
} from "./time/local-date.js";
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
/**
 * A part of the journey we have no price for (ADR 0014).
 *
 * Deliberately **not** a segment and **not** an offer: it has no times and no
 * cost, because we know neither. What we do know is kept — both endpoints, the
 * distance, and why it is unpriced — so it can be shown rather than hidden.
 *
 * Unknown price is not zero price and is not an estimate.
 */
export const itineraryGapSchema = z.object({
  id: z.string().min(1),
  from: locationSchema,
  to: locationSchema,
  distanceKm: z.number().positive().optional(),
  status: z.literal("unpriced"),
  /** Why no price exists. Today: no licensed source for surface transport. */
  reason: z.literal("no_licensed_source"),
});

export type ItineraryGap = z.infer<typeof itineraryGapSchema>;

export const tripCandidateSchema = z.object({
  id: z.string().min(1),
  origin: locationSchema,
  travelers: z.number().int().positive(),
  segments: z.array(transportSegmentSchema),
  offers: z.array(transportOfferSchema),
  stays: z.array(staySchema),
  /** Sectors the traveler arranges themselves; excluded from every amount. */
  gaps: z.array(itineraryGapSchema).default([]),
  /**
   * When the trip ends, for an itinerary with no closing departure.
   *
   * A round trip's final segment bounds its time on the ground. A one-way has
   * no such segment, so the traveler states where it ends and the itinerary
   * carries that — otherwise nights after the final arrival fall outside the
   * model entirely (ADR 0005, resolved by ADR 0018).
   *
   * Absent on every round trip, open jaw and multi-city trip, which are bounded
   * by their own last departure.
   */
  endsAt: localDateSchema.optional(),
  /**
   * What is known about a bed for each period on the ground (ADR 0016).
   *
   * `stays` remains the priced source of truth for the amount; this says what
   * happened for every stay, priced or not, so a night we never searched for
   * cannot read like a night with nothing available.
   */
  accommodation: z.array(accommodationStaySchema).default([]),
});

export type TripCandidate = z.infer<typeof tripCandidateSchema>;
export type TripCandidateInput = z.input<typeof tripCandidateSchema>;

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
 * A trip with no closing departure bounds its final ground time with `endsAt`
 * instead, so a one-way itinerary can carry a stay after its final arrival
 * (ADR 0018). Without it, that time is outside the model.
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

  const usedGapIds = new Set<string>();
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

    // A jump between two places must be explained: either the traveler was
    // carried there (a transfer segment) or they arrange it themselves (a gap).
    if (previous.destination.id !== current.origin.id) {
      const gap = trip.gaps.find(
        (entry) =>
          entry.from.id === previous.destination.id && entry.to.id === current.origin.id,
      );
      if (gap === undefined) {
        issues.push(
          issue(
            "UNEXPLAINED_DISCONTINUITY",
            `Segment ${current.id} departs from ${current.origin.id}, but ${previous.id} arrived at ${previous.destination.id}; declare a gap or a transfer`,
          ),
        );
      } else {
        usedGapIds.add(gap.id);
      }
    }
  }

  for (const gap of trip.gaps) {
    if (!usedGapIds.has(gap.id)) {
      issues.push(
        issue(
          "ORPHAN_GAP",
          `Gap ${gap.id} (${gap.from.id} → ${gap.to.id}) does not sit between two consecutive segments`,
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
  issues.push(...validateAccommodation(trip));

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

/**
 * Periods on the ground, in local dates.
 *
 * Between consecutive segments, and — for a trip that declares one — from the
 * final arrival to its stated end. That last period is what lets a one-way
 * itinerary carry a stay at all: without a closing departure there is nothing
 * else to bound it (ADR 0018).
 */
function groundGaps(
  segments: readonly TransportSegment[],
  endsAt?: LocalDate,
): GroundGap[] {
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

  const last = segments.at(-1);
  if (endsAt !== undefined && last !== undefined) {
    gaps.push({ arrivalDate: localDate(last.arrivalAt), departureDate: endsAt });
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

/**
 * Whether a night belongs to a stay whose city cannot be determined.
 *
 * Such a night is not *uncovered* — that would mean we could have booked it and
 * did not. It is unallocatable, which is a different reason with its own
 * exclusion, so it must not also be counted here (ADR 0016 §3).
 */
function nightIsUnresolved(
  night: LocalDate,
  accommodation: readonly AccommodationStay[],
): boolean {
  return accommodation.some(
    (entry) =>
      entry.state === "unresolved" &&
      compareLocalDates(entry.checkIn, night) <= 0 &&
      compareLocalDates(night, entry.checkOut) < 0,
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
  const gaps = groundGaps(trip.segments, trip.endsAt);

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
 * Coverage must agree with the priced stays it claims.
 *
 * A priced entry names a `Stay`, and that same stay must be among the trip's
 * priced stays — otherwise an amount could be claimed that no stay backs, or a
 * stay could be paid for that coverage never mentions.
 */
function validateAccommodation(trip: TripCandidate): DomainIssue[] {
  const issues: DomainIssue[] = [];
  const pricedIds = new Set(trip.stays.map((stay) => stay.id));
  const claimed = new Set<string>();

  for (const entry of trip.accommodation) {
    if (entry.state !== "priced") continue;
    claimed.add(entry.stay.id);
    if (!pricedIds.has(entry.stay.id)) {
      issues.push(
        issue(
          "ACCOMMODATION_WITHOUT_STAY",
          `Accommodation claims stay ${entry.stay.id} as priced, but the trip does not carry it`,
        ),
      );
    }
  }
  for (const stay of trip.stays) {
    if (!claimed.has(stay.id) && trip.accommodation.length > 0) {
      issues.push(
        issue(
          "STAY_WITHOUT_ACCOMMODATION",
          `Stay ${stay.id} is priced but no accommodation entry reports it`,
        ),
      );
    }
  }
  return issues;
}

/**
 * `complete`: nothing is excluded from the amount.
 * `excludes_unpriced_segment`: a sector of the journey has no price and is not
 * in the amount, so it is a **known cost**, not a total (ADR 0014).
 * `transport_and_partial_accommodation`: nights on the ground have no stay.
 *
 * An unpriced sector takes precedence in the label, because a missing sector
 * is a bigger hole than a missing night; `exclusions` lists every reason.
 */
export type TripCostScope =
  | "complete"
  | "excludes_unpriced_segment"
  | "transport_and_partial_accommodation";

/**
 * Every reason an amount is not the whole journey. They are independent: a trip
 * can be incomplete in more than one way at once, and each is reported.
 */
export type CostExclusion =
  /** A sector of the journey has no price (ADR 0014). */
  | "unpriced_segment"
  /** Nights were searched for and left uncovered. */
  | "accommodation"
  /** The stay itself cannot be determined, so no search exists (ADR 0016). */
  | "unresolved_accommodation";

/**
 * The scope label for a set of exclusions.
 *
 * An unpriced sector takes precedence in the label, because a missing sector is
 * a bigger hole than a missing night — but `exclusions` still lists every
 * reason, so "excludes a sector" and "excludes accommodation" remain separable
 * rather than one hiding the other.
 */
export function costScopeFor(exclusions: readonly CostExclusion[]): TripCostScope {
  if (exclusions.includes("unpriced_segment")) return "excludes_unpriced_segment";
  if (
    exclusions.includes("accommodation") ||
    exclusions.includes("unresolved_accommodation")
  ) {
    return "transport_and_partial_accommodation";
  }
  return "complete";
}

export interface TripCost {
  /** Sum of selected transport offers for the whole party. */
  readonly transport: Money;
  /** Transport excluding ground transfers: the fares we retrieved. */
  readonly fares: Money;
  /** Ground transfers only, so an estimate is inspectable (spec §28). */
  readonly groundTransfer: Money;
  /** Sum of stays for the whole party. */
  readonly accommodation: Money;
  /** The portion of `total` that came from a model rather than a provider. */
  readonly estimated: Money;
  readonly total: Money;
  /**
   * What `total` covers. Amounts of different scopes must not be compared
   * (docs/optimizer-spec.md §19).
   */
  readonly scope: TripCostScope;
  /** Every reason the amount is not the whole journey, in a stable order. */
  readonly exclusions: readonly CostExclusion[];
  /**
   * The total split across travelers; shares differ by at most one minor unit
   * and always sum to `total`.
   */
  readonly perPersonShares: readonly Money[];
}

/** A cost we modelled rather than retrieved (ADR 0011). */
export type EstimatedComponent = "access_transfer" | "other";

/**
 * Where a trip's numbers came from, by component.
 *
 * A single weakest label would say an itinerary with a retrieved fare and a
 * modelled EUR 9 transfer is no better sourced than a guess. Fares keep their
 * own provenance; estimates are named separately (ADR 0011).
 */
export interface TripProvenance {
  /** Weakest source type across retrieved fares; undefined when there are none. */
  readonly fareSourceType: SourceType | undefined;
  /** Providers of retrieved fares, sorted. */
  readonly fareSources: readonly string[];
  /** Which parts of the trip are modelled. */
  readonly estimatedComponents: readonly EstimatedComponent[];
  /** Sources of those estimates, sorted. */
  readonly estimateSources: readonly string[];
  /** True when any component is estimated. */
  readonly partiallyEstimated: boolean;
}

export interface TripSummary {
  /**
   * Local date the outbound **fare segment** departs. Access transfers may
   * start earlier without changing it: the window the traveler gave is about
   * the journey they booked (docs/optimizer-spec.md §8).
   */
  readonly departureDate: LocalDate;
  /**
   * Local date the final return **fare segment** departs.
   *
   * Absent on a one-way trip, which has no return to date. It is never filled
   * with the outbound departure: that would report a trip as returning on the
   * day it left (ADR 0018).
   */
  readonly returnDate?: LocalDate;
  /**
   * Local date the trip ends: the final departure for a round trip, the
   * declared end for a one-way. Always present, whatever the shape.
   */
  readonly tripEndDate: LocalDate;
  /** Stay cities in visiting order (consecutive repeats collapsed). */
  readonly destinations: readonly Location[];
  /**
   * Nights booked, summed across stays. With two stays in different cities on
   * the same night this exceeds the number of nights on the ground, so it is
   * not the complement of `uncoveredNights`.
   */
  readonly nights: number;
  /**
   * Local dates of nights spent on the ground with no stay booked. A night on
   * an overnight train or flight is not a night on the ground.
   */
  readonly uncoveredNights: readonly LocalDate[];
  readonly cost: TripCost;
  /** Time spent moving: the sum of segment durations, transfers included. */
  readonly travelTimeMinutes: number;
  /**
   * First departure to last arrival across every leg, including transfers:
   * the physical journey, which may start before `departureDate`.
   */
  readonly totalJourneyDurationMinutes: number;
  /** Number of transport segments. */
  readonly legs: number;
  /** Intermediate stops inside segments. */
  readonly stops: number;
  /** Changes between consecutive segments with no stay in between. */
  readonly connections: number;
  readonly provenance: TripProvenance;
  /** Sectors excluded from every amount, kept so output can show them. */
  readonly unpricedGaps: readonly ItineraryGap[];
  /** What is known about a bed for each period on the ground (ADR 0016). */
  readonly accommodation: readonly AccommodationStay[];
}

export type SummarizeTripResult =
  | { readonly ok: true; readonly summary: TripSummary }
  | { readonly ok: false; readonly issues: readonly DomainIssue[] };

/**
 * Validates a trip and derives its dates, cost, time and provenance.
 * Invalid trips have no summary, so an incomplete or inconsistent itinerary
 * can never be shown with a total cost.
 */
/** An offer is a transfer estimate when every segment it covers is one. */
function isGroundTransferOffer(
  offer: { readonly segmentIds: readonly string[] },
  segmentsById: ReadonlyMap<string, TransportSegment>,
): boolean {
  return offer.segmentIds.every(
    (id) => segmentsById.get(id)?.mode === "ground_transfer",
  );
}

/** The last segment the traveler actually booked, ignoring transfers we added. */
function fareSegments(segments: readonly TransportSegment[]): TransportSegment[] {
  return segments.filter((segment) => segment.mode !== "ground_transfer");
}

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

  const fareLegs = fareSegments(trip.segments);
  const segmentsById = new Map(trip.segments.map((segment) => [segment.id, segment]));
  const priced = trip.offers.map((offer) => ({
    offer,
    amount: offerPriceForTravelers(offer, trip.travelers),
    isTransfer: isGroundTransferOffer(offer, segmentsById),
    isEstimate: offer.provenance.sourceType === "estimated",
  }));

  const fares = sumMoney(
    priced.filter((entry) => !entry.isTransfer).map((entry) => entry.amount),
    currency,
  );
  const groundTransfer = sumMoney(
    priced.filter((entry) => entry.isTransfer).map((entry) => entry.amount),
    currency,
  );
  const transport = addMoney(fares, groundTransfer);
  const accommodation = sumMoney(
    trip.stays.map((stay) => stay.price),
    currency,
  );
  const total = addMoney(transport, accommodation);
  const estimated = sumMoney(
    [
      ...priced.filter((entry) => entry.isEstimate).map((entry) => entry.amount),
      ...trip.stays
        .filter((stay) => stay.provenance.sourceType === "estimated")
        .map((stay) => stay.price),
    ],
    currency,
  );

  const staysInOrder = [...trip.stays].sort((a, b) => compareLocalDates(a.checkIn, b.checkIn));
  const destinations: Location[] = [];
  for (const stay of staysInOrder) {
    if (destinations.at(-1)?.id !== stay.city.id) destinations.push(stay.city);
  }

  const gaps = groundGaps(trip.segments, trip.endsAt);
  const connections = gaps.filter(
    (gap) => !trip.stays.some((stay) => stayFitsGap(stay, gap)),
  ).length;
  // Every night gets exactly one reason it has no price: booked, unallocatable,
  // or uncovered. A night never carries two.
  const uncoveredNights = gaps
    .flatMap(nightsInGap)
    .filter(
      (night) =>
        !nightIsCovered(night, trip.stays) && !nightIsUnresolved(night, trip.accommodation),
    );

  // Fares keep their own provenance; estimates are reported separately, so a
  // retrieved fare is never downgraded by a modelled transfer (ADR 0011).
  const observed = [
    ...priced.filter((entry) => !entry.isEstimate),
    ...trip.stays
      .filter((stay) => stay.provenance.sourceType !== "estimated")
      .map((stay) => ({ offer: { provenance: stay.provenance }, isTransfer: false })),
  ];
  const estimates = [
    ...priced.filter((entry) => entry.isEstimate),
    ...trip.stays
      .filter((stay) => stay.provenance.sourceType === "estimated")
      .map((stay) => ({ offer: { provenance: stay.provenance }, isTransfer: false })),
  ];
  if (observed.length === 0 && estimates.length === 0) {
    return {
      ok: false,
      issues: [issue("TRIP_WITHOUT_PRICES", "A trip must contain at least one price")],
    };
  }

  const estimatedComponents = [
    ...new Set(
      estimates.map((entry): EstimatedComponent =>
        entry.isTransfer ? "access_transfer" : "other",
      ),
    ),
  ].sort();

  const provenance: TripProvenance = {
    fareSourceType: weakestSourceType(observed.map((entry) => entry.offer.provenance.sourceType)),
    fareSources: [...new Set(observed.map((entry) => entry.offer.provenance.provider))].sort(),
    estimatedComponents,
    estimateSources: [...new Set(estimates.map((entry) => entry.offer.provenance.provider))].sort(),
    partiallyEstimated: estimates.length > 0,
  };

  // An unresolved stay is a different hole from an uncovered night: we cannot
  // even say what to search for, rather than having searched and found nothing.
  const unresolvedStays = trip.accommodation.filter((entry) => entry.state === "unresolved");
  const exclusions: CostExclusion[] = [];
  if (trip.gaps.length > 0) exclusions.push("unpriced_segment");
  if (uncoveredNights.length > 0) exclusions.push("accommodation");
  if (unresolvedStays.length > 0) exclusions.push("unresolved_accommodation");
  const costScope = costScopeFor(exclusions);

  return {
    ok: true,
    summary: {
      // The window the traveler gave is about the journey they booked, so
      // transfers we added do not move these dates (spec §8).
      departureDate: localDate((fareLegs[0] ?? first).departureAt),
      // A trip returns only if something brings it back. One leg and a
      // declared end is a one-way: it ends, but it does not return.
      ...(trip.endsAt === undefined && {
        returnDate: localDate((fareLegs.at(-1) ?? last).departureAt),
      }),
      tripEndDate: trip.endsAt ?? localDate((fareLegs.at(-1) ?? last).departureAt),
      destinations,
      nights: trip.stays.reduce((nights, stay) => nights + stay.nights, 0),
      uncoveredNights,
      cost: {
        transport,
        fares,
        groundTransfer,
        accommodation,
        estimated,
        total,
        scope: costScope,
        exclusions,
        perPersonShares: allocateEvenly(total, trip.travelers),
      },
      travelTimeMinutes: trip.segments.reduce(
        (minutes, segment) => minutes + segment.durationMinutes,
        0,
      ),
      totalJourneyDurationMinutes: minutesBetween(first.departureAt, last.arrivalAt),
      legs: trip.segments.length,
      stops: trip.segments.reduce((count, segment) => count + segment.transfers, 0),
      connections,
      provenance,
      unpricedGaps: trip.gaps,
      accommodation: trip.accommodation,
    },
  };
}
