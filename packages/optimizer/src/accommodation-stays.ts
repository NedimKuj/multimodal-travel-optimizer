import {
  daysBetween,
  localDate,
  lookupCityForAirport,
  type AccommodationStay,
  type CityRepository,
  type LocalDate,
  type Location,
} from "@travel-optimizer/domain";

import type { StayBoundary } from "./flight-exploration.js";

/*
 * Where a trip needs a bed (ADR 0016 §1).
 *
 * These intervals are not invented here: they are the junctions between
 * consecutive legs that assembly already computed, with `reached`/`left`
 * already accounting for access transfers. A flight that lands late therefore
 * starts its stay late, and a ride out to a distant airport ends it early,
 * without any of that being recalculated.
 *
 * An interval says what a search would need to know. What a search then found
 * is `accommodation-search.ts`; nothing here queries anything.
 */

export interface StayInterval {
  /** Local date the traveler reaches the place they are staying. */
  readonly checkIn: LocalDate;
  /** Local date they leave it. */
  readonly checkOut: LocalDate;
  readonly nights: number;
  /**
   * The city the nights belong to — or every city they are split across, when
   * an unpriced sector means we cannot say how (ADR 0016 §3).
   *
   * Never empty: an unresolvable airport stands for itself rather than
   * vanishing, so there is always somewhere to name.
   */
  readonly cities: readonly [Location, ...Location[]];
  /**
   * True when no single accommodation search can be constructed, because the
   * traveler crosses between cities on a sector that carries no times.
   */
  readonly unresolved: boolean;
}

/** The city serving a location, or the location itself when none resolves. */
function placeOf(location: Location, cities: CityRepository): Location {
  if (location.type === "city") return location;
  const lookup = lookupCityForAirport(cities, location);
  return lookup.ok ? lookup.city : location;
}

/** Distinct places, in visiting order, keeping the list non-empty. */
function distinct(first: Location, second: Location): readonly [Location, ...Location[]] {
  return first.id === second.id ? [first] : [first, second];
}

/**
 * Turns each junction into the stay it implies.
 *
 * A junction with no nights is a connection, not a destination, and produces
 * nothing: minimum connection times govern it instead (ADR 0012).
 */
export function deriveStayIntervals(
  boundaries: readonly StayBoundary[],
  cities: CityRepository,
): StayInterval[] {
  const intervals: StayInterval[] = [];

  for (const boundary of boundaries) {
    const checkIn = localDate(boundary.reached.arrivalAt);
    const checkOut = localDate(boundary.left.departureAt);
    // The same count `evaluateTrip` reaches for the same junction, so the two
    // can never disagree about how long the traveler is somewhere.
    const nights = daysBetween(checkIn, checkOut);
    if (nights < 1) continue;

    // Where the traveler actually is at each end of the stay. For an ordinary
    // stop these are the same place; across an unpriced sector they are not.
    const spanned = distinct(
      placeOf(boundary.reached.destination, cities),
      placeOf(boundary.left.origin, cities),
    );

    intervals.push({
      checkIn,
      checkOut,
      nights,
      cities: spanned,
      // A gap is what makes the allocation undeterminable — but only when it
      // actually separates two places. Two airports of one city resolve to one
      // city, and the nights then belong to that city unambiguously.
      unresolved: boundary.gap !== undefined && spanned.length > 1,
    });
  }

  return intervals;
}

/**
 * The coverage a stay has before anything has been searched.
 *
 * An unresolved interval is final: no provider call can tell us how to divide
 * nights across cities when the sector between them carries no times
 * (ADR 0016 §3). Everything else is simply not searched yet, and the search
 * stage says why — no provider, or outside the shortlist.
 */
export function initialAccommodation(
  intervals: readonly StayInterval[],
  reason: "no_provider" | "outside_shortlist" | "other",
): AccommodationStay[] {
  return intervals.map((interval) => {
    const shared = {
      checkIn: interval.checkIn,
      checkOut: interval.checkOut,
      nights: interval.nights,
    };
    if (interval.unresolved) {
      return {
        state: "unresolved" as const,
        reason: "unresolved_open_jaw_split" as const,
        cities: [...interval.cities],
        ...shared,
      };
    }
    // A resolved interval names exactly one place, and the type guarantees it.
    return { state: "not_searched" as const, reason, city: interval.cities[0], ...shared };
  });
}
