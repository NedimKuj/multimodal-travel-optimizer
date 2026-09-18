import {
  parseUtcInstant,
  summarizeTrip,
  tripCandidateSchema,
  type TransportOffer,
  type TransportSegment,
} from "@travel-optimizer/domain";
import { buildAirportRepository } from "@travel-optimizer/geo";
import { describe, expect, it } from "vitest";

import { aviasalesPricesForDatesResponseSchema, parseResponse } from "./dto.js";
import { mapPriceRecords } from "./mapper.js";
import { pricesForDatesBody, ROUND_TRIP_RECORD } from "./test-fixtures.js";

/*
 * Raw response → DTO → normalized segments/offer → trip cost.
 *
 * Deterministic: it uses synthetic fixtures, not the live API. The point is to
 * prove a round-trip fare survives the whole path and is charged once.
 */

const airports = buildAirportRepository(
  [
    ["SJJ", "Europe/Sarajevo", "BA"],
    ["SAW", "Europe/Istanbul", "TR"],
  ].map(([code, timeZone, countryCode]) => ({
    name_translations: { en: `${String(code)} Test Airport` },
    city_code: code,
    country_code: countryCode,
    time_zone: timeZone,
    code,
    iata_type: "airport",
    name: null,
    coordinates: { lat: 43.8, lon: 18.3 },
    flightable: true,
  })),
  { source: "https://example.test/a.json", fetchedAt: parseUtcInstant("2026-09-18T08:00:00Z") },
).repository;

function normalize(): { segments: readonly TransportSegment[]; offers: readonly TransportOffer[] } {
  const parsed = parseResponse(
    pricesForDatesBody([ROUND_TRIP_RECORD]),
    aviasalesPricesForDatesResponseSchema,
  );
  if (!parsed.ok) throw new Error(parsed.failure.message);
  return mapPriceRecords(parsed.response.data, {
    airports,
    currency: "EUR",
    fetchedAt: parseUtcInstant("2026-09-18T09:00:00Z"),
    bookingBaseUrl: "https://www.aviasales.com",
  });
}

describe("raw response to trip cost", () => {
  it("charges a round-trip fare once across two flights", () => {
    const { segments, offers } = normalize();
    const origin = segments[0]?.origin;
    if (origin === undefined) throw new Error("expected a segment");

    const trip = tripCandidateSchema.parse({
      id: "trip-from-aviasales",
      origin,
      travelers: 1,
      segments,
      offers,
      stays: [],
    });

    const result = summarizeTrip(trip);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issues.map((issue) => issue.code).join(", "));

    // One €79 fare covering both flights, not €79 per flight.
    expect(result.summary.cost.transport).toEqual({ amountMinor: 7900, currency: "EUR" });
    expect(result.summary.cost.total).toEqual({ amountMinor: 7900, currency: "EUR" });
    expect(result.summary.legs).toBe(2);
    expect(result.summary.departureDate).toBe("2026-12-30");
    expect(result.summary.returnDate).toBe("2027-01-08");
  });

  it("is cached end to end, and not a complete-trip cost without accommodation", () => {
    const { segments, offers } = normalize();
    const origin = segments[0]?.origin;
    if (origin === undefined) throw new Error("expected a segment");
    const trip = tripCandidateSchema.parse({
      id: "trip-from-aviasales",
      origin,
      travelers: 1,
      segments,
      offers,
      stays: [],
    });
    const result = summarizeTrip(trip);
    if (!result.ok) throw new Error("expected a summary");

    expect(result.summary.sourceType).toBe("cached");
    expect(result.summary.sources).toEqual(["aviasales"]);
    expect(result.summary.cost.scope).toBe("transport_and_partial_accommodation");
    expect(result.summary.uncoveredNights).toHaveLength(9);
  });

  it("scales a per-traveler fare by the party size", () => {
    const { segments, offers } = normalize();
    const origin = segments[0]?.origin;
    if (origin === undefined) throw new Error("expected a segment");
    const trip = tripCandidateSchema.parse({
      id: "trip-for-two",
      origin,
      travelers: 2,
      segments,
      offers,
      stays: [],
    });
    const result = summarizeTrip(trip);
    if (!result.ok) throw new Error("expected a summary");
    expect(result.summary.cost.transport).toEqual({ amountMinor: 15800, currency: "EUR" });
    expect(result.summary.cost.perPersonShares).toEqual([
      { amountMinor: 7900, currency: "EUR" },
      { amountMinor: 7900, currency: "EUR" },
    ]);
  });
});
