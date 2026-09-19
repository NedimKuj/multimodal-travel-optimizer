import { normalizeSearchRequest, parseLocalDate, type SearchRequest } from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import { evaluateTrip, resolveTravelWindow, type TravelWindow } from "./travel-window.js";

function request(overrides: Record<string, unknown> = {}): SearchRequest {
  const result = normalizeSearchRequest({
    origin: "SJJ",
    destination: null,
    departureDate: "2026-12-26",
    returnDate: "2027-01-03",
    flexibilityDays: 2,
    minNights: 5,
    maxNights: 7,
    travelers: 2,
    transportModes: ["flight"],
    allowOpenJaw: false,
    allowMultiCity: false,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join("; "));
  return result.request;
}

function resolved(overrides: Record<string, unknown> = {}): TravelWindow {
  const result = resolveTravelWindow(request(overrides));
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.code).join("; "));
  return result.window;
}

/** A same-day-arrival trip with one stay: out and back on the given local dates. */
function dates(tripStart: string, groundEnd: string) {
  return {
    tripStart: parseLocalDate(tripStart),
    tripEnd: parseLocalDate(groundEnd),
    stays: [{ groundStart: parseLocalDate(tripStart), groundEnd: parseLocalDate(groundEnd) }],
  };
}

/** A stay, for trips that have more than one. */
function stay(groundStart: string, groundEnd: string) {
  return { groundStart: parseLocalDate(groundStart), groundEnd: parseLocalDate(groundEnd) };
}

describe("resolveTravelWindow — with a nights range", () => {
  it("treats the dates as an outer travel window", () => {
    const window = resolved();
    expect(window.mode).toBe("window");
    expect(window.outerBounds).toEqual({ from: "2026-12-24", to: "2027-01-05" });
  });

  it("allows departures late enough for the shortest trip to still fit", () => {
    const window = resolved();
    // 5 nights minimum, so the last usable departure is 5 nights before the end.
    expect(window.departure).toEqual({ from: "2026-12-24", to: "2026-12-31" });
    expect(window.return).toEqual({ from: "2026-12-29", to: "2027-01-05" });
  });

  it("rejects a window that cannot hold the minimum nights", () => {
    const result = resolveTravelWindow(
      request({ departureDate: "2026-12-26", returnDate: "2026-12-28", flexibilityDays: 0, minNights: 5 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an issue");
    expect(result.issues[0]?.code).toBe("WINDOW_TOO_SHORT_FOR_NIGHTS");
  });

  it("crosses the year boundary", () => {
    const window = resolved({ departureDate: "2026-12-30", returnDate: "2027-01-02", minNights: 2, maxNights: 3 });
    expect(window.outerBounds).toEqual({ from: "2026-12-28", to: "2027-01-04" });
  });
});

describe("resolveTravelWindow — without a nights range", () => {
  it("anchors each date with its own tolerance", () => {
    const window = resolved({ minNights: undefined, maxNights: undefined });
    expect(window.mode).toBe("anchored");
    expect(window.departure).toEqual({ from: "2026-12-24", to: "2026-12-28" });
    expect(window.return).toEqual({ from: "2027-01-01", to: "2027-01-05" });
  });

  it("treats zero flexibility as exact dates", () => {
    const window = resolved({ minNights: undefined, maxNights: undefined, flexibilityDays: 0 });
    expect(window.departure).toEqual({ from: "2026-12-26", to: "2026-12-26" });
    expect(window.return).toEqual({ from: "2027-01-03", to: "2027-01-03" });
  });
});

describe("resolveTravelWindow — invalid requests", () => {
  it("requires both dates for a round-trip search", () => {
    const result = resolveTravelWindow(
      request({ departureDate: undefined, returnDate: undefined, flexibilityDays: 0 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an issue");
    expect(result.issues[0]?.code).toBe("DATES_REQUIRED");
  });
});

describe("evaluateTrip — window mode", () => {
  const window = resolved();

  it("accepts a trip inside the window with nights in range", () => {
    // Departs 28 Dec, returns 2 Jan: 5 nights, inside 24 Dec..5 Jan.
    expect(evaluateTrip(window, dates("2026-12-28", "2027-01-02"))).toEqual({
      ok: true,
      nights: 5,
      nightsByStay: [5],
    });
  });

  it("accepts the case anchored dates would have excluded", () => {
    // Departs 24 Dec for 7 nights, returning 31 Dec — inside the window, but
    // outside an anchored return range of 1..5 Jan.
    expect(evaluateTrip(window, dates("2026-12-24", "2026-12-31"))).toEqual({
      ok: true,
      nights: 7,
      nightsByStay: [7],
    });
  });

  it("rejects a trip that starts before or ends after the window", () => {
    expect(evaluateTrip(window, dates("2026-12-23", "2026-12-29"))).toEqual({
      ok: false,
      reason: "outside_window",
    });
    expect(evaluateTrip(window, dates("2026-12-30", "2027-01-06"))).toEqual({
      ok: false,
      reason: "outside_window",
    });
  });

  it("rejects nights outside the requested range", () => {
    expect(evaluateTrip(window, dates("2026-12-28", "2026-12-31"))).toEqual({
      ok: false,
      reason: "nights_out_of_range",
    });
    expect(evaluateTrip(window, dates("2026-12-25", "2027-01-04"))).toEqual({
      ok: false,
      reason: "nights_out_of_range",
    });
  });

  it("counts nights from time on the ground, not from the departure date", () => {
    // Overnight outbound: leaves 27 Dec, lands 28 Dec; returns 2 Jan → 5 nights.
    const overnight = {
      tripStart: parseLocalDate("2026-12-27"),
      tripEnd: parseLocalDate("2027-01-02"),
      stays: [stay("2026-12-28", "2027-01-02")],
    };
    expect(evaluateTrip(window, overnight)).toEqual({ ok: true, nights: 5, nightsByStay: [5] });
  });
});

describe("evaluateTrip — anchored mode", () => {
  const window = resolved({ minNights: undefined, maxNights: undefined });

  it("accepts departures and returns inside their own ranges", () => {
    expect(evaluateTrip(window, dates("2026-12-27", "2027-01-04"))).toEqual({
      ok: true,
      nights: 8,
      nightsByStay: [8],
    });
  });

  it("rejects a return outside the return range even when nights look fine", () => {
    expect(evaluateTrip(window, dates("2026-12-24", "2026-12-31"))).toEqual({
      ok: false,
      reason: "outside_window",
    });
  });

  it("measures the window against the last place stayed, not the first", () => {
    // Out 27 Dec, on to a second city 30 Dec, home 4 Jan: the 4 Jan departure
    // is what the return range has to contain.
    const multiCity = {
      tripStart: parseLocalDate("2026-12-27"),
      tripEnd: parseLocalDate("2027-01-04"),
      stays: [stay("2026-12-27", "2026-12-30"), stay("2026-12-30", "2027-01-04")],
    };
    expect(evaluateTrip(window, multiCity)).toMatchObject({ ok: true });
  });
});

describe("evaluateTrip — trips with more than one stay", () => {
  const window = resolved();

  it("splits nights between the cities and sums them for the range", () => {
    // 3 nights in the first city, 2 in the second: 5 in all, inside 5..7.
    const multiCity = {
      tripStart: parseLocalDate("2026-12-27"),
      tripEnd: parseLocalDate("2027-01-01"),
      stays: [stay("2026-12-27", "2026-12-30"), stay("2026-12-30", "2027-01-01")],
    };
    expect(evaluateTrip(window, multiCity)).toEqual({
      ok: true,
      nights: 5,
      nightsByStay: [3, 2],
    });
  });

  it("does not count a night spent crossing between cities", () => {
    // The connecting leg leaves on the 30th and lands on the 31st. That night
    // belongs to neither city, so the trip has 4 nights on the ground, not 5.
    const overnightLeg = {
      tripStart: parseLocalDate("2026-12-27"),
      tripEnd: parseLocalDate("2027-01-01"),
      stays: [stay("2026-12-27", "2026-12-30"), stay("2026-12-31", "2027-01-01")],
    };
    expect(evaluateTrip(window, overnightLeg)).toEqual({
      ok: false,
      reason: "nights_out_of_range",
    });
  });

  it("applies the requested range to the total, not to each city", () => {
    // 2 + 4 = 6 nights: in range, though neither city alone reaches 5.
    const uneven = {
      tripStart: parseLocalDate("2026-12-27"),
      tripEnd: parseLocalDate("2027-01-02"),
      stays: [stay("2026-12-27", "2026-12-29"), stay("2026-12-29", "2027-01-02")],
    };
    expect(evaluateTrip(window, uneven)).toEqual({ ok: true, nights: 6, nightsByStay: [2, 4] });
  });
});
