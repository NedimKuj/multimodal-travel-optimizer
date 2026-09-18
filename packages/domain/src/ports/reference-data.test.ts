import { describe, expect, it } from "vitest";

import {
  inMemoryAirportRepository,
  inMemoryCityRepository,
} from "../test-fixtures/airport-repository.js";
import { PRAGUE, PRG, SJJ, VIE, VIENNA } from "../test-fixtures/locations.js";
import { lookupAirport, lookupCityForAirport } from "./reference-data.js";

const repository = inMemoryAirportRepository([SJJ, PRG, VIENNA]);

describe("lookupAirport", () => {
  it("resolves a known code", () => {
    const result = lookupAirport(repository, "SJJ");
    expect(result).toEqual({ ok: true, airport: SJJ });
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(lookupAirport(repository, " sjj ")).toEqual({ ok: true, airport: SJJ });
  });

  it("reports an unknown code instead of inventing an airport", () => {
    const result = lookupAirport(repository, "FMM");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.issue).toMatchObject({ code: "UNKNOWN_IATA_CODE", iata: "FMM" });
  });

  it("rejects malformed codes", () => {
    for (const input of ["", "S", "SJJX", "S1J", "SARAJEVO"]) {
      const result = lookupAirport(repository, input);
      expect(result.ok, input).toBe(false);
      if (result.ok) throw new Error("expected a failure");
      expect(result.issue.code).toBe("INVALID_IATA_CODE");
    }
  });

  it("indexes only locations that carry an IATA code", () => {
    // VIENNA is a city without an IATA code, so it is not reachable by lookup.
    expect(repository.findByIata("VIE")).toBeUndefined();
    expect(repository.provenance.recordCount).toBe(2);
  });
});

describe("lookupCityForAirport", () => {
  const cities = inMemoryCityRepository([VIENNA, PRAGUE], {
    [VIE.id]: "vienna",
    [PRG.id]: "prague",
  });

  it("resolves the city an airport belongs to", () => {
    expect(lookupCityForAirport(cities, VIE)).toEqual({ ok: true, city: VIENNA });
  });

  it("maps several airports of one city to the same destination", () => {
    const multiAirport = inMemoryCityRepository([VIENNA], {
      [VIE.id]: "vienna",
      [SJJ.id]: "vienna",
    });
    const first = lookupCityForAirport(multiAirport, VIE);
    const second = lookupCityForAirport(multiAirport, SJJ);
    expect(first).toEqual(second);
  });

  it("reports an unknown mapping instead of inventing a city", () => {
    const result = lookupCityForAirport(cities, SJJ);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.issue).toMatchObject({ code: "UNKNOWN_CITY_FOR_AIRPORT", iata: "SJJ" });
  });

  it("looks a city up by its own code", () => {
    expect(cities.findByCode("vienna")).toEqual(VIENNA);
    expect(cities.findByCode("nowhere")).toBeUndefined();
  });
});
