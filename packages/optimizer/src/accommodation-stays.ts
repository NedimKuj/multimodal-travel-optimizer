import {
  localDate,
  lookupCityForAirport,
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
   */
  readonly cities: readonly Location[];
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

/** Distinct places, in visiting order. */
function distinct(places: readonly Location[]): Location[] {
  const seen = new Set<string>();
  return places.filter((place) => (seen.has(place.id) ? false : (seen.add(place.id), true)));
}

/**
 * Turns each junction into the stay it implies.
 *
 * A junction with no nights is a connection, not a destination, and produces
 * nothing: minimum connection times govern it instead (ADR 0012).
 */
export function deriveStayIntervals(
  boundaries: readonly StayBoundary[],
  nightsByStay: readonly number[],
  cities: CityRepository,
): StayInterval[] {
  const intervals: StayInterval[] = [];

  for (const [index, boundary] of boundaries.entries()) {
    const nights = nightsByStay[index] ?? 0;
    if (nights < 1) continue;

    // Where the traveler actually is at each end of the stay. For an ordinary
    // stop these are the same place; across an unpriced sector they are not.
    const arrivedAt = placeOf(boundary.reached.destination, cities);
    const leftFrom = placeOf(boundary.left.origin, cities);
    const spanned = distinct([arrivedAt, leftFrom]);

    intervals.push({
      checkIn: localDate(boundary.reached.arrivalAt),
      checkOut: localDate(boundary.left.departureAt),
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
