import { lookupAirport, parseUtcInstant } from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import { buildAirportRepository, toLocation } from "./airports.js";

// Synthetic records shaped like the published dataset (observed 2026-09-18).
// Not provider data: names and coordinates here are test inputs.
const sarajevo = {
  name_translations: { en: "Sarajevo Test Airport" },
  city_code: "SJJ",
  country_code: "BA",
  time_zone: "Europe/Sarajevo",
  code: "SJJ",
  iata_type: "airport",
  name: null,
  coordinates: { lat: 43.826687, lon: 18.336065 },
  flightable: true,
};

const railwayStation = {
  ...sarajevo,
  name_translations: { en: "Test Railway Station" },
  code: "XWX",
  iata_type: "railway",
  flightable: false,
};

const provenance = {
  source: "https://example.test/airports.json",
  fetchedAt: parseUtcInstant("2026-09-18T09:00:00Z"),
};

describe("toLocation", () => {
  it("maps an airport record to a domain location", () => {
    const result = toLocation(sarajevo);
    expect(result).toEqual({
      ok: true,
      location: {
        id: "airport:SJJ",
        type: "airport",
        name: "Sarajevo Test Airport",
        countryCode: "BA",
        latitude: 43.826687,
        longitude: 18.336065,
        timeZone: "Europe/Sarajevo",
        iata: "SJJ",
      },
    });
  });

  it("maps railway and bus places to stations, and heliports to airports", () => {
    expect(toLocation(railwayStation)).toMatchObject({ ok: true, location: { type: "station" } });
    expect(toLocation({ ...sarajevo, iata_type: "bus" })).toMatchObject({
      ok: true,
      location: { type: "station" },
    });
    expect(toLocation({ ...sarajevo, iata_type: "heliport" })).toMatchObject({
      ok: true,
      location: { type: "airport" },
    });
  });

  it("skips place types the domain cannot represent", () => {
    const result = toLocation({ ...sarajevo, iata_type: "harbour" });
    expect(result).toMatchObject({ ok: false, issue: { code: "UNSUPPORTED_PLACE_TYPE" } });
  });

  it("skips non-IATA codes rather than coercing them", () => {
    // The published dataset contains a few Cyrillic codes.
    const result = toLocation({ ...sarajevo, code: "ТГК" });
    expect(result).toMatchObject({
      ok: false,
      issue: { code: "AIRPORT_RECORD_REJECTED_BY_DOMAIN" },
    });
  });

  it("skips records without a usable name or coordinates", () => {
    expect(
      toLocation({ ...sarajevo, name: null, name_translations: {} }),
    ).toMatchObject({ ok: false, issue: { code: "MISSING_AIRPORT_NAME" } });
    expect(
      toLocation({ ...sarajevo, coordinates: { lat: null, lon: null } }),
    ).toMatchObject({ ok: false, issue: { code: "MISSING_COORDINATES" } });
  });

  it("reports malformed records", () => {
    expect(toLocation({ code: "SJJ" })).toMatchObject({
      ok: false,
      issue: { code: "MALFORMED_AIRPORT_RECORD" },
    });
    expect(toLocation(null)).toMatchObject({ ok: false, issue: { code: "MALFORMED_AIRPORT_RECORD" } });
  });

  it("falls back to the plain name when there is no English translation", () => {
    expect(
      toLocation({ ...sarajevo, name: "Fallback Name", name_translations: undefined }),
    ).toMatchObject({ ok: true, location: { name: "Fallback Name" } });
  });

  it("ignores unknown fields so new dataset columns do not break loading", () => {
    expect(toLocation({ ...sarajevo, some_new_field: 42 })).toMatchObject({ ok: true });
  });
});

describe("buildAirportRepository", () => {
  it("indexes usable records and counts the rest", () => {
    const build = buildAirportRepository(
      [sarajevo, railwayStation, { ...sarajevo, iata_type: "harbour", code: "XXH" }],
      provenance,
    );
    expect(build.accepted).toBe(2);
    expect(build.repository.provenance.recordCount).toBe(2);
    expect(build.issues.map((issue) => issue.code)).toEqual(["UNSUPPORTED_PLACE_TYPE"]);
  });

  it("serves the AirportRepository port", () => {
    const { repository } = buildAirportRepository([sarajevo], provenance);
    expect(lookupAirport(repository, "sjj")).toMatchObject({ ok: true });
    expect(lookupAirport(repository, "FMM")).toMatchObject({
      ok: false,
      issue: { code: "UNKNOWN_IATA_CODE" },
    });
  });

  it("keeps the first of duplicate codes and reports the collision", () => {
    const build = buildAirportRepository([sarajevo, { ...sarajevo, name: "Other" }], provenance);
    expect(build.accepted).toBe(1);
    expect(build.issues.map((issue) => issue.code)).toEqual(["DUPLICATE_IATA_CODE"]);
    expect(build.repository.findByIata("SJJ")?.name).toBe("Sarajevo Test Airport");
  });

  it("carries provenance through to the repository", () => {
    const { repository } = buildAirportRepository([sarajevo], provenance);
    expect(repository.provenance).toMatchObject({
      source: "https://example.test/airports.json",
      fetchedAt: "2026-09-18T09:00:00.000Z",
      recordCount: 1,
    });
  });
});
