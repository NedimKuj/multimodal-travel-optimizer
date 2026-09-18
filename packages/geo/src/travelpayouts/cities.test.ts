import { lookupCityForAirport, parseUtcInstant } from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import { buildAirportRepository } from "./airports.js";
import { buildCityRepository, toCity } from "./cities.js";

// Synthetic records shaped like the published datasets (observed 2026-09-18).
const rome = {
  name_translations: { en: "Rome" },
  country_code: "IT",
  code: "ROM",
  time_zone: "Europe/Rome",
  name: null,
  coordinates: { lat: 41.8905198, lon: 12.4942486 },
  has_flightable_airport: true,
};

function airportRecord(code: string, cityCode: string | undefined, timeZone = "Europe/Rome") {
  return {
    name_translations: { en: `${code} Test Airport` },
    ...(cityCode !== undefined && { city_code: cityCode }),
    country_code: "IT",
    time_zone: timeZone,
    code,
    iata_type: "airport",
    name: null,
    coordinates: { lat: 41.8, lon: 12.2 },
    flightable: true,
  };
}

const provenance = {
  source: "https://example.test/cities.json",
  fetchedAt: parseUtcInstant("2026-09-18T09:00:00Z"),
};

describe("toCity", () => {
  it("maps a city record to a domain location", () => {
    expect(toCity(rome)).toEqual({
      ok: true,
      city: {
        id: "city:ROM",
        type: "city",
        name: "Rome",
        countryCode: "IT",
        latitude: 41.8905198,
        longitude: 12.4942486,
        timeZone: "Europe/Rome",
        iata: "ROM",
      },
    });
  });

  it("skips records without a name or coordinates", () => {
    expect(toCity({ ...rome, name: null, name_translations: {} })).toMatchObject({
      ok: false,
      issue: { code: "MISSING_CITY_NAME" },
    });
    expect(toCity({ ...rome, coordinates: { lat: null, lon: null } })).toMatchObject({
      ok: false,
      issue: { code: "MISSING_COORDINATES" },
    });
  });

  it("skips codes the domain rejects rather than coercing them", () => {
    expect(toCity({ ...rome, code: "ТГК" })).toMatchObject({
      ok: false,
      issue: { code: "CITY_RECORD_REJECTED_BY_DOMAIN" },
    });
  });

  it("reports malformed records", () => {
    expect(toCity({ code: "ROM" })).toMatchObject({
      ok: false,
      issue: { code: "MALFORMED_CITY_RECORD" },
    });
  });
});

describe("buildCityRepository", () => {
  const airports = [airportRecord("FCO", "ROM"), airportRecord("CIA", "ROM")];

  it("maps every airport of a city to the same destination", () => {
    const { repository } = buildCityRepository({ cities: [rome], airports }, provenance);
    const airportRepo = buildAirportRepository(airports, provenance).repository;

    const fco = airportRepo.findByIata("FCO");
    const cia = airportRepo.findByIata("CIA");
    if (fco === undefined || cia === undefined) throw new Error("expected airports");

    expect(repository.findForAirport(fco)?.id).toBe("city:ROM");
    expect(repository.findForAirport(cia)?.id).toBe("city:ROM");
    expect(lookupCityForAirport(repository, fco)).toEqual({
      ok: true,
      city: repository.findByCode("ROM"),
    });
  });

  it("keeps the airports distinguishable underneath the city", () => {
    const airportRepo = buildAirportRepository(airports, provenance).repository;
    expect(airportRepo.findByIata("FCO")?.id).not.toBe(airportRepo.findByIata("CIA")?.id);
  });

  it("counts airports with no resolvable city instead of inventing one", () => {
    const build = buildCityRepository(
      { cities: [rome], airports: [...airports, airportRecord("ZZZ", "NOWHERE")] },
      provenance,
    );
    expect(build.unmappedAirports).toBe(1);

    const orphan = buildAirportRepository([airportRecord("ZZZ", "NOWHERE")], provenance).repository
      .findByIata("ZZZ");
    if (orphan === undefined) throw new Error("expected an airport");
    expect(build.repository.findForAirport(orphan)).toBeUndefined();
    expect(lookupCityForAirport(build.repository, orphan)).toMatchObject({
      ok: false,
      issue: { code: "UNKNOWN_CITY_FOR_AIRPORT" },
    });
  });

  it("counts unusable city records and duplicates", () => {
    const build = buildCityRepository(
      { cities: [rome, { ...rome }, { ...rome, code: "ТГК" }], airports },
      provenance,
    );
    expect(build.accepted).toBe(1);
    expect(build.issues.map((issue) => issue.code).sort()).toEqual([
      "CITY_RECORD_REJECTED_BY_DOMAIN",
      "DUPLICATE_CITY_CODE",
    ]);
  });

  it("carries provenance through to the repository", () => {
    const { repository } = buildCityRepository({ cities: [rome], airports }, provenance);
    expect(repository.provenance).toMatchObject({
      source: "https://example.test/cities.json",
      recordCount: 1,
    });
  });
});
