import { describe, expect, it } from "vitest";

import { inMemoryAirportRepository } from "../test-fixtures/airport-repository.js";
import { PRG, SJJ, VIENNA } from "../test-fixtures/locations.js";
import { lookupAirport } from "./reference-data.js";

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
