import { parseUtcInstant, type AirportRepository } from "@travel-optimizer/domain";
import { buildAirportRepository } from "@travel-optimizer/geo";
import { describe, expect, it } from "vitest";

import { mapPriceRecord, mapPriceRecords, priceToMoney, type MapRecordOptions } from "./mapper.js";
import { ONE_WAY_RECORD, ROUND_TRIP_RECORD } from "./test-fixtures.js";

// Synthetic reference records shaped like the published dataset.
function airportRecord(code: string, timeZone: string, countryCode: string) {
  return {
    name_translations: { en: `${code} Test Airport` },
    city_code: code,
    country_code: countryCode,
    time_zone: timeZone,
    code,
    iata_type: "airport",
    name: null,
    coordinates: { lat: 43.8, lon: 18.3 },
    flightable: true,
  };
}

function repository(): AirportRepository {
  return buildAirportRepository(
    [
      airportRecord("SJJ", "Europe/Sarajevo", "BA"),
      airportRecord("FCO", "Europe/Rome", "IT"),
      airportRecord("SAW", "Europe/Istanbul", "TR"),
    ],
    { source: "https://example.test/airports.json", fetchedAt: parseUtcInstant("2026-09-18T08:00:00Z") },
  ).repository;
}

function options(overrides: Partial<MapRecordOptions> = {}): MapRecordOptions {
  return {
    airports: repository(),
    currency: "EUR",
    fetchedAt: parseUtcInstant("2026-09-18T09:00:00Z"),
    bookingBaseUrl: "https://www.aviasales.com",
    ...overrides,
  };
}

function expectMapped(mapping: ReturnType<typeof mapPriceRecord>) {
  if (!mapping.ok) throw new Error(`expected a mapping, got ${mapping.issue.code}: ${mapping.issue.message}`);
  return mapping.mapped;
}

describe("priceToMoney", () => {
  it("converts exact amounts", () => {
    expect(priceToMoney(26, "EUR")).toEqual({ amountMinor: 2600, currency: "EUR" });
    expect(priceToMoney(79.5, "EUR")).toEqual({ amountMinor: 7950, currency: "EUR" });
    expect(priceToMoney(1500, "JPY")).toEqual({ amountMinor: 1500, currency: "JPY" });
  });

  it("refuses amounts it cannot represent exactly rather than rounding a fare", () => {
    expect(priceToMoney(26.005, "EUR")).toBeUndefined();
    expect(priceToMoney(1500.5, "JPY")).toBeUndefined();
    expect(priceToMoney(Number.NaN, "EUR")).toBeUndefined();
    expect(priceToMoney(-5, "EUR")).toBeUndefined();
  });
});

describe("mapPriceRecord — one-way", () => {
  it("builds one segment and one offer", () => {
    const { segments, offer } = expectMapped(mapPriceRecord(ONE_WAY_RECORD, options()));
    expect(segments).toHaveLength(1);
    expect(offer.segmentIds).toEqual([segments[0]?.id]);
    expect(offer.price).toEqual({ amountMinor: 2600, currency: "EUR" });
  });

  it("derives the arrival time from duration_to", () => {
    const { segments } = expectMapped(mapPriceRecord(ONE_WAY_RECORD, options()));
    // 17:10+01:00 plus 85 minutes, arriving in Rome's zone.
    expect(segments[0]?.departureAt).toEqual({
      instant: "2026-12-26T16:10:00.000Z",
      timeZone: "Europe/Sarajevo",
    });
    expect(segments[0]?.arrivalAt).toEqual({
      instant: "2026-12-26T17:35:00.000Z",
      timeZone: "Europe/Rome",
    });
    expect(segments[0]?.durationMinutes).toBe(85);
  });

  it("labels the price cached with our fetch time", () => {
    const { offer } = expectMapped(mapPriceRecord(ONE_WAY_RECORD, options()));
    expect(offer.provenance).toMatchObject({
      provider: "aviasales",
      sourceType: "cached",
      fetchedAt: "2026-09-18T09:00:00.000Z",
    });
  });

  it("derives an expiry 24 hours after the fetch when the provider gives none", () => {
    const { offer } = expectMapped(mapPriceRecord(ONE_WAY_RECORD, options()));
    expect(ONE_WAY_RECORD.expires_at).toBeUndefined();
    expect(offer.provenance.expiresAt).toBe("2026-09-19T09:00:00.000Z");
  });

  it("uses the provider's expiry when one is supplied", () => {
    const { offer } = expectMapped(
      mapPriceRecord({ ...ONE_WAY_RECORD, expires_at: "2026-09-18T10:00:00Z" }, options()),
    );
    expect(offer.provenance.expiresAt).toBe("2026-09-18T10:00:00.000Z");
  });

  it("never replaces a provider expiry with the longer derived one", () => {
    // The provider's hour beats our 24, and a provider expiry beyond 24 hours
    // is still honoured: it states validity, we only cap our own retention.
    const shorter = expectMapped(
      mapPriceRecord({ ...ONE_WAY_RECORD, expires_at: "2026-09-18T10:00:00Z" }, options()),
    );
    const longer = expectMapped(
      mapPriceRecord({ ...ONE_WAY_RECORD, expires_at: "2026-09-21T09:00:00Z" }, options()),
    );
    expect(shorter.offer.provenance.expiresAt).toBe("2026-09-18T10:00:00.000Z");
    expect(longer.offer.provenance.expiresAt).toBe("2026-09-21T09:00:00.000Z");
  });

  it("stays cached despite carrying an expiry, and is never called live", () => {
    const { offer } = expectMapped(mapPriceRecord(ONE_WAY_RECORD, options()));
    expect(offer.provenance.sourceType).toBe("cached");
    expect(offer.provenance.expiresAt).toBeDefined();
  });

  it("prices per traveler, since the API has no passenger parameter", () => {
    const { offer } = expectMapped(mapPriceRecord(ONE_WAY_RECORD, options()));
    expect(offer.priceBasis).toEqual({ kind: "perTraveler" });
  });

  it("produces stable ids for the same record", () => {
    const first = expectMapped(mapPriceRecord(ONE_WAY_RECORD, options()));
    const second = expectMapped(mapPriceRecord(ONE_WAY_RECORD, options()));
    expect(first.segments[0]?.id).toBe(second.segments[0]?.id);
    expect(first.offer.id).toBe(second.offer.id);
    expect(first.segments[0]?.id).toContain("aviasales:SJJ-FCO:2026-12-26T16:10:00.000Z:W46160");
  });
});

describe("mapPriceRecord — round trip", () => {
  it("maps one fare to two segments under a single offer", () => {
    const { segments, offer } = expectMapped(mapPriceRecord(ROUND_TRIP_RECORD, options()));
    expect(segments).toHaveLength(2);
    expect(offer.segmentIds).toHaveLength(2);
    expect(offer.price).toEqual({ amountMinor: 7900, currency: "EUR" });
  });

  it("returns from the destination in its own zone", () => {
    const { segments } = expectMapped(mapPriceRecord(ROUND_TRIP_RECORD, options()));
    const [outbound, inbound] = segments;
    expect(outbound?.origin.iata).toBe("SJJ");
    expect(outbound?.destination.iata).toBe("SAW");
    expect(inbound?.origin.iata).toBe("SAW");
    expect(inbound?.destination.iata).toBe("SJJ");
    // 12:45+03:00 on 8 Jan, plus duration_back 125 minutes.
    expect(inbound?.departureAt).toEqual({
      instant: "2027-01-08T09:45:00.000Z",
      timeZone: "Europe/Istanbul",
    });
    expect(inbound?.arrivalAt).toEqual({
      instant: "2027-01-08T11:50:00.000Z",
      timeZone: "Europe/Sarajevo",
    });
  });

  it("keeps outbound and return stop counts apart", () => {
    const { segments } = expectMapped(mapPriceRecord(ROUND_TRIP_RECORD, options()));
    expect(segments[0]?.transfers).toBe(0);
    expect(segments[1]?.transfers).toBe(1);
  });

  it("drops a round trip with no return duration instead of inventing one", () => {
    const mapping = mapPriceRecord({ ...ROUND_TRIP_RECORD, duration_back: 0 }, options());
    expect(mapping).toMatchObject({ ok: false, issue: { code: "MISSING_DURATION" } });
  });
});

describe("mapPriceRecord — data quality", () => {
  it("drops records whose airports are not in the reference data", () => {
    const mapping = mapPriceRecord({ ...ONE_WAY_RECORD, destination_airport: "ZZZ" }, options());
    expect(mapping).toMatchObject({ ok: false, issue: { code: "UNKNOWN_IATA_CODE" } });
  });

  it("drops records whose offset disagrees with the airport's zone", () => {
    // Observed for real: CIT was returned at +06:00 while Asia/Almaty is UTC+5.
    const mapping = mapPriceRecord(
      { ...ONE_WAY_RECORD, departure_at: "2026-12-26T17:10:00+06:00" },
      options(),
    );
    expect(mapping).toMatchObject({ ok: false, issue: { code: "TIME_ZONE_OFFSET_MISMATCH" } });
  });

  it("drops records with a naive timestamp", () => {
    const mapping = mapPriceRecord({ ...ONE_WAY_RECORD, departure_at: "2026-12-26T17:10:00" }, options());
    expect(mapping.ok).toBe(false);
  });

  it("drops records with an unrepresentable price", () => {
    const mapping = mapPriceRecord({ ...ONE_WAY_RECORD, price: 26.005 }, options());
    expect(mapping).toMatchObject({ ok: false, issue: { code: "UNREPRESENTABLE_PRICE" } });
  });

  it("drops records with no usable duration", () => {
    const mapping = mapPriceRecord(
      { ...ONE_WAY_RECORD, duration_to: undefined, duration: undefined },
      options(),
    );
    expect(mapping).toMatchObject({ ok: false, issue: { code: "MISSING_DURATION" } });
  });

  it("falls back to duration when duration_to is absent on a one-way record", () => {
    const { segments } = expectMapped(
      mapPriceRecord({ ...ONE_WAY_RECORD, duration_to: undefined }, options()),
    );
    expect(segments[0]?.durationMinutes).toBe(85);
  });
});

describe("booking links", () => {
  it("emits no link when no affiliate marker is configured", () => {
    const { offer } = expectMapped(mapPriceRecord(ONE_WAY_RECORD, options()));
    expect(offer.bookingUrl).toBeUndefined();
  });

  it("builds an absolute, marker-bearing link when configured", () => {
    const { offer } = expectMapped(
      mapPriceRecord(ONE_WAY_RECORD, options({ marker: "12345" })),
    );
    expect(offer.bookingUrl).toContain("https://www.aviasales.com/search/SJJ2612ROM1");
    expect(offer.bookingUrl).toContain("marker=12345");
  });

  it("keeps the fare path as the provider reference", () => {
    const { offer } = expectMapped(mapPriceRecord(ONE_WAY_RECORD, options()));
    expect(offer.provenance.providerReference).toBe("/search/SJJ2612ROM1");
  });
});

describe("mapPriceRecords", () => {
  it("collects segments, offers and one issue per dropped record", () => {
    const result = mapPriceRecords(
      [ONE_WAY_RECORD, ROUND_TRIP_RECORD, { ...ONE_WAY_RECORD, destination_airport: "ZZZ" }],
      options(),
    );
    expect(result.segments).toHaveLength(3);
    expect(result.offers).toHaveLength(2);
    expect(result.issues.map((issue) => issue.code)).toEqual(["UNKNOWN_IATA_CODE"]);
  });

  it("de-duplicates segments shared by several fares, keeping both fares", () => {
    const cheaper = { ...ONE_WAY_RECORD, price: 24, link: "/search/other?t=x" };
    const result = mapPriceRecords([ONE_WAY_RECORD, cheaper], options());
    expect(result.segments).toHaveLength(1);
    expect(result.offers).toHaveLength(2);
    expect(result.offers.map((offer) => offer.price.amountMinor).sort()).toEqual([2400, 2600]);
  });

  it("keeps competing agencies' fares for the same flight apart", () => {
    const otherAgency = { ...ONE_WAY_RECORD, gate: "Another Agency" };
    const result = mapPriceRecords([ONE_WAY_RECORD, otherAgency], options());
    expect(result.offers).toHaveLength(2);
  });

  it("collapses byte-identical duplicate records", () => {
    const result = mapPriceRecords([ONE_WAY_RECORD, { ...ONE_WAY_RECORD }], options());
    expect(result.offers).toHaveLength(1);
  });

  it("returns empty results rather than placeholders when there is nothing", () => {
    expect(mapPriceRecords([], options())).toEqual({ segments: [], offers: [], issues: [] });
  });
});
