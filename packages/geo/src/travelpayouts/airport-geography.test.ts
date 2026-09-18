import { parseUtcInstant } from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import { buildAirportGeography } from "./airport-geography.js";
import { buildAirportRepository } from "./airports.js";

// Synthetic records shaped like the published dataset, with real-ish
// coordinates so distances are meaningful.
function airport(
  code: string,
  latitude: number,
  longitude: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    name_translations: { en: `${code} Test Airport` },
    city_code: code,
    country_code: "BA",
    time_zone: "Europe/Sarajevo",
    code,
    iata_type: "airport",
    name: null,
    coordinates: { lat: latitude, lon: longitude },
    flightable: true,
    ...overrides,
  };
}

const SJJ = airport("SJJ", 43.8246, 18.3315);
const TZL = airport("TZL", 44.4587, 18.7248); // ~78 km from SJJ
const OMO = airport("OMO", 43.2829, 17.842); // ~78 km from SJJ
const ZAG = airport("ZAG", 45.7429, 16.0688); // ~290 km from SJJ
const GROUNDED = airport("GRD", 43.83, 18.34, { flightable: false });
const STATION = airport("XWX", 43.85, 18.4, { iata_type: "railway" });

const provenance = {
  source: "https://example.test/airports.json",
  fetchedAt: parseUtcInstant("2026-09-18T08:00:00Z"),
};

function geographyOf(records: readonly unknown[]) {
  return buildAirportGeography(records, provenance);
}

function sjjLocation(records: readonly unknown[]) {
  const location = buildAirportRepository(records, provenance).repository.findByIata("SJJ");
  if (location === undefined) throw new Error("expected SJJ");
  return location;
}

describe("buildAirportGeography", () => {
  const records = [SJJ, TZL, OMO, ZAG, GROUNDED, STATION];

  it("finds airports within the radius, nearest first", () => {
    const { geography } = geographyOf(records);
    const nearby = geography.findNearby(sjjLocation(records), 300);
    expect(nearby.map((entry) => entry.airport.iata)).toEqual(["OMO", "TZL", "ZAG"]);
    expect(nearby[0]?.distanceKm).toBeLessThan(nearby[1]?.distanceKm ?? 0);
  });

  it("respects the radius", () => {
    const { geography } = geographyOf(records);
    expect(geography.findNearby(sjjLocation(records), 100).map((e) => e.airport.iata)).toEqual([
      "OMO",
      "TZL",
    ]);
    expect(geography.findNearby(sjjLocation(records), 10)).toEqual([]);
  });

  it("excludes the airport searched around", () => {
    const { geography } = geographyOf(records);
    const nearby = geography.findNearby(sjjLocation(records), 5000);
    expect(nearby.some((entry) => entry.airport.iata === "SJJ")).toBe(false);
  });

  it("excludes airports with no scheduled service", () => {
    const { geography, flightable } = geographyOf(records);
    // GRD sits next door to SJJ but is not flightable.
    expect(geography.findNearby(sjjLocation(records), 50).map((e) => e.airport.iata)).not.toContain(
      "GRD",
    );
    expect(flightable).toBe(4);
  });

  it("excludes airports whose flightable flag is unknown", () => {
    const unknown = { ...airport("UNK", 43.83, 18.34), flightable: undefined };
    const { geography } = geographyOf([SJJ, unknown]);
    expect(geography.findNearby(sjjLocation([SJJ, unknown]), 50)).toEqual([]);
  });

  it("offers only airports, not stations", () => {
    const { geography } = geographyOf(records);
    expect(geography.findNearby(sjjLocation(records), 5000).map((e) => e.airport.iata)).not.toContain(
      "XWX",
    );
  });

  it("breaks distance ties by IATA code, so results are reproducible", () => {
    // Two airports the same distance away, in opposite directions.
    const east = airport("EEE", 43.8246, 19.3315);
    const west = airport("AAA", 43.8246, 17.3315);
    const tied = [SJJ, east, west];
    const { geography } = geographyOf(tied);
    const nearby = geography.findNearby(sjjLocation(tied), 200);
    expect(nearby.map((entry) => entry.airport.iata)).toEqual(["AAA", "EEE"]);
  });

  it("measures distance between two locations", () => {
    const { geography } = geographyOf(records);
    const repository = buildAirportRepository(records, provenance).repository;
    const tzl = repository.findByIata("TZL");
    if (tzl === undefined) throw new Error("expected TZL");
    expect(geography.distanceBetween(sjjLocation(records), tzl)).toBeCloseTo(77, 0);
  });

  it("carries provenance, counting only usable airports", () => {
    const { geography } = geographyOf(records);
    expect(geography.provenance).toMatchObject({
      source: "https://example.test/airports.json",
      recordCount: 4,
    });
  });
});
