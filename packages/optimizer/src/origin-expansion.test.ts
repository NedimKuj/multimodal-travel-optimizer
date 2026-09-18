import {
  inMemoryAirportGeography,
  inMemoryAirportRepository,
} from "@travel-optimizer/domain/test-fixtures";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ORIGIN_EXPANSION_CONFIG,
  expandOrigins,
  originCodes,
  type ExpandOriginsInput,
} from "./origin-expansion.js";
import { airport, request } from "./test-fixtures.js";

// Sarajevo and its real neighbours, at their real distances.
const SJJ = airport("SJJ", "Sarajevo");
const TZL = airport("TZL", "Tuzla");
const OMO = airport("OMO", "Mostar");
const DBV = airport("DBV", "Dubrovnik");
const ZAG = airport("ZAG", "Zagreb");

const airportsById = {
  [SJJ.id]: SJJ,
  [TZL.id]: TZL,
  [OMO.id]: OMO,
  [DBV.id]: DBV,
  [ZAG.id]: ZAG,
};

const geography = inMemoryAirportGeography(
  { [SJJ.id]: { [TZL.id]: 71, [OMO.id]: 72, [DBV.id]: 141, [ZAG.id]: 278 } },
  airportsById,
);

const airports = inMemoryAirportRepository([SJJ, TZL, OMO, DBV, ZAG]);

function expand(overrides: Partial<ExpandOriginsInput> = {}) {
  return expandOrigins({
    request: request({ alternativeAirports: true }),
    airports,
    geography,
    callsPerOrigin: 2,
    callBudget: 12,
    ...overrides,
  });
}

describe("expandOrigins", () => {
  it("queries only the requested origin by default", () => {
    const expansion = expand({ request: request({ alternativeAirports: false }) });
    expect(originCodes(expansion)).toEqual(["SJJ"]);
    expect(expansion.skipped).toEqual([]);
    expect(expansion.plannedCalls).toBe(2);
  });

  it("adds the nearest alternatives, capped", () => {
    const expansion = expand();
    // Cap of 2: Tuzla and Mostar, not Dubrovnik.
    expect(originCodes(expansion)).toEqual(["SJJ", "TZL", "OMO"]);
    expect(expansion.origins[1]).toMatchObject({ distanceKm: 71, isPrimary: false });
    expect(expansion.origins[0]).toMatchObject({ isPrimary: true, distanceKm: 0 });
  });

  it("records alternatives dropped by the cap", () => {
    const expansion = expand();
    expect(expansion.skipped.map((entry) => ({ iata: entry.airport.iata, reason: entry.reason }))).toEqual(
      [{ iata: "DBV", reason: "cap" }],
    );
  });

  it("respects the radius", () => {
    const expansion = expand({
      config: { ...DEFAULT_ORIGIN_EXPANSION_CONFIG, alternativeOriginRadiusKm: 80 },
    });
    expect(originCodes(expansion)).toEqual(["SJJ", "TZL", "OMO"]);
    // Dubrovnik is outside the radius, so it is not even a candidate.
    expect(expansion.skipped).toEqual([]);
  });

  it("stops at the call budget and records what it skipped and why", () => {
    // Budget 12, 5 calls each: the primary plus one alternative fit.
    const expansion = expand({ callsPerOrigin: 5, callBudget: 12 });
    expect(originCodes(expansion)).toEqual(["SJJ", "TZL"]);
    expect(expansion.plannedCalls).toBe(10);
    expect(
      expansion.skipped.map((entry) => ({ iata: entry.airport.iata, reason: entry.reason })),
    ).toEqual([
      { iata: "DBV", reason: "cap" },
      { iata: "OMO", reason: "call_budget" },
    ]);
  });

  it("keeps the requested origin even when no alternative fits the budget", () => {
    const expansion = expand({ callsPerOrigin: 12, callBudget: 12 });
    expect(originCodes(expansion)).toEqual(["SJJ"]);
    expect(expansion.skipped.filter((entry) => entry.reason === "call_budget")).toHaveLength(2);
  });

  it("is deterministic when two airports are equally far", () => {
    const tied = inMemoryAirportGeography(
      { [SJJ.id]: { [TZL.id]: 100, [OMO.id]: 100, [DBV.id]: 100 } },
      airportsById,
    );
    const first = expand({ geography: tied });
    const second = expand({ geography: tied });
    expect(originCodes(first)).toEqual(originCodes(second));
    // IATA breaks the tie: DBV, OMO, then TZL, capped at two.
    expect(originCodes(first)).toEqual(["SJJ", "DBV", "OMO"]);
  });

  it("never includes the requested origin as its own alternative", () => {
    const expansion = expand({ config: { ...DEFAULT_ORIGIN_EXPANSION_CONFIG, maxAlternativeOrigins: 10 } });
    expect(expansion.origins.filter((origin) => origin.airport.id === SJJ.id)).toHaveLength(1);
  });

  it("reports an unresolvable origin instead of guessing", () => {
    const expansion = expand({ request: request({ origin: "ZZZ", alternativeAirports: true }) });
    expect(expansion.origins).toEqual([]);
    expect(expansion.issues[0]?.code).toBe("UNKNOWN_IATA_CODE");
  });
});
