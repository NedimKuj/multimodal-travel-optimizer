import {
  addDays,
  compareLocalDates,
  daysBetween,
  type DomainIssue,
  type LocalDate,
  type SearchRequest,
} from "@travel-optimizer/domain";

/*
 * What the user's dates and flexibility mean.
 *
 * See docs/decisions/0009-date-flexibility-semantics.md:
 * - with a nights range, the dates bound a travel window and the trip must fit
 *   inside it with its nights in range;
 * - without one, each date is anchored with a +/- tolerance.
 *
 * This is the only place that rule lives. Constraints are never relaxed here:
 * a window too short for the requested nights is an issue, not an empty result.
 */

export interface LocalDateRange {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

export type TravelWindowMode = "window" | "anchored";

export interface TravelWindow {
  readonly mode: TravelWindowMode;
  /** Dates the outbound may depart on. */
  readonly departure: LocalDateRange;
  /** Dates the return may depart on. */
  readonly return: LocalDateRange;
  /** The outer bounds a whole trip must sit inside. */
  readonly outerBounds: LocalDateRange;
  readonly minNights: number | undefined;
  readonly maxNights: number | undefined;
}

export type ResolveTravelWindowResult =
  | { readonly ok: true; readonly window: TravelWindow }
  | { readonly ok: false; readonly issues: readonly DomainIssue[] };

/** Resolves a normalized request into the dates a search may consider. */
export function resolveTravelWindow(request: SearchRequest): ResolveTravelWindowResult {
  const { departureDate, returnDate, flexibilityDays, minNights, maxNights } = request;
  if (departureDate === undefined || returnDate === undefined) {
    return {
      ok: false,
      issues: [
        {
          code: "DATES_REQUIRED",
          message: "A departure date and a return date are required to search for round trips",
        },
      ],
    };
  }

  const hasNightsRange = minNights !== undefined || maxNights !== undefined;
  const outerBounds: LocalDateRange = {
    from: addDays(departureDate, -flexibilityDays),
    to: addDays(returnDate, flexibilityDays),
  };

  if (!hasNightsRange) {
    // Anchored: each date carries its own tolerance.
    return {
      ok: true,
      window: {
        mode: "anchored",
        departure: {
          from: addDays(departureDate, -flexibilityDays),
          to: addDays(departureDate, flexibilityDays),
        },
        return: {
          from: addDays(returnDate, -flexibilityDays),
          to: addDays(returnDate, flexibilityDays),
        },
        outerBounds,
        minNights: undefined,
        maxNights: undefined,
      },
    };
  }

  // Window: the dates bound the period the traveler could be away.
  const shortest = minNights ?? 0;
  const windowNights = daysBetween(outerBounds.from, outerBounds.to);
  if (windowNights < shortest) {
    return {
      ok: false,
      issues: [
        {
          code: "WINDOW_TOO_SHORT_FOR_NIGHTS",
          message: `${outerBounds.from}..${outerBounds.to} spans ${String(windowNights)} night(s), fewer than the requested minimum of ${String(shortest)}`,
        },
      ],
    };
  }

  return {
    ok: true,
    window: {
      mode: "window",
      // The outbound must leave early enough for the shortest trip to fit.
      departure: { from: outerBounds.from, to: addDays(outerBounds.to, -shortest) },
      // The return cannot be earlier than the shortest trip allows.
      return: { from: addDays(outerBounds.from, shortest), to: outerBounds.to },
      outerBounds,
      minNights,
      maxNights,
    },
  };
}

/** One period on the ground between two legs: where the traveler sleeps. */
export interface StayDates {
  /** Local date the traveler reaches where they are staying. */
  readonly groundStart: LocalDate;
  /** Local date they leave it. */
  readonly groundEnd: LocalDate;
}

/** The dates of a candidate trip, in the local time of each place. */
export interface TripDates {
  /** Local date the first fare segment departs. */
  readonly tripStart: LocalDate;
  /** Local date the last fare segment departs. */
  readonly tripEnd: LocalDate;
  /** One per place the traveler stops between legs, in order. */
  readonly stays: readonly StayDates[];
}

export type TripRejection = "outside_window" | "nights_out_of_range";

export type TripEvaluation =
  | {
      readonly ok: true;
      /** Nights on the ground, summed across stays. */
      readonly nights: number;
      /** Nights per stay, in the order the traveler visits them. */
      readonly nightsByStay: readonly number[];
    }
  | { readonly ok: false; readonly reason: TripRejection };

function within(date: LocalDate, range: LocalDateRange): boolean {
  return compareLocalDates(date, range.from) >= 0 && compareLocalDates(date, range.to) <= 0;
}

/**
 * Decides whether a candidate trip satisfies the window, and reports why not
 * so each rejection can be counted.
 */
export function evaluateTrip(window: TravelWindow, dates: TripDates): TripEvaluation {
  const nightsByStay = dates.stays.map((stay) => daysBetween(stay.groundStart, stay.groundEnd));
  // Nights belong to stays, not to the span from first leg to last: a night
  // spent crossing between two cities is a night in neither (spec §9).
  const nights = nightsByStay.reduce((total, stay) => total + stay, 0);

  // The traveler is home once they leave the last place they stayed.
  const lastGroundEnd = dates.stays.at(-1)?.groundEnd ?? dates.tripEnd;
  const insideWindow =
    window.mode === "window"
      ? within(dates.tripStart, window.outerBounds) && within(dates.tripEnd, window.outerBounds)
      : within(dates.tripStart, window.departure) && within(lastGroundEnd, window.return);
  if (!insideWindow) {
    return { ok: false, reason: "outside_window" };
  }

  if (window.minNights !== undefined && nights < window.minNights) {
    return { ok: false, reason: "nights_out_of_range" };
  }
  if (window.maxNights !== undefined && nights > window.maxNights) {
    return { ok: false, reason: "nights_out_of_range" };
  }
  return { ok: true, nights, nightsByStay };
}
