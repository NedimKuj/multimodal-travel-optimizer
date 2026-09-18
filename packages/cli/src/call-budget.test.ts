import { parseUtcInstant, type AirportRepository } from "@travel-optimizer/domain";
import { buildAirportRepository } from "@travel-optimizer/geo";
import { callsPerOrigin, resolveTravelWindow, runFlightSearch } from "@travel-optimizer/optimizer";
import {
  cityRepository,
  fixtureGeography,
  request,
} from "@travel-optimizer/optimizer/test-fixtures";
import {
  createAviasalesFlightProvider,
  loadAviasalesConfig,
  type FetchLike,
} from "@travel-optimizer/providers";
import { describe, expect, it } from "vitest";

/*
 * The optimizer budgets provider calls; the provider plans them. Two pieces of
 * month arithmetic that must agree, or a search silently over- or under-spends
 * its budget. This is the only place both sides meet.
 */

const airportRecords = ["SJJ", "FCO"].map((code) => ({
  name_translations: { en: `${code} Test Airport` },
  city_code: code,
  country_code: "BA",
  time_zone: "Europe/Sarajevo",
  code,
  iata_type: "airport",
  name: null,
  coordinates: { lat: 43.8, lon: 18.3 },
  flightable: true,
}));

const airports: AirportRepository = buildAirportRepository(airportRecords, {
  source: "https://example.test/a.json",
  fetchedAt: parseUtcInstant("2026-09-18T08:00:00Z"),
}).repository;

function countingFetch(urls: string[]): FetchLike {
  return (url) => {
    urls.push(url);
    return Promise.resolve(new Response(JSON.stringify({ success: true, currency: "eur", data: [] })));
  };
}

async function callsMadeFor(overrides: Record<string, unknown>): Promise<{
  planned: number;
  actual: number;
}> {
  const urls: string[] = [];
  const configResult = loadAviasalesConfig({ AVIASALES_API_TOKEN: "token" });
  if (!configResult.ok) throw new Error("expected config");

  const searchRequest = request(overrides);
  const window = resolveTravelWindow(searchRequest);
  if (!window.ok) throw new Error(window.issues.map((issue) => issue.code).join(", "));

  const trace = await runFlightSearch(
    searchRequest,
    {
      // No cache: every planned call must become a request.
      flightProvider: createAviasalesFlightProvider({
        config: configResult.config,
        airports,
        fetchImpl: countingFetch(urls),
      }),
      cities: cityRepository,
      geography: fixtureGeography,
      airports,
    },
    { currency: "EUR" },
  );

  return {
    planned: callsPerOrigin(window.window) * (trace.origins?.origins.length ?? 1),
    actual: trace.provider.metrics?.requestCount ?? urls.length,
  };
}

describe("call budgeting agrees with the provider", () => {
  it("matches for a window inside one month", async () => {
    const { planned, actual } = await callsMadeFor({
      departureDate: "2026-12-10",
      returnDate: "2026-12-20",
      flexibilityDays: 0,
      minNights: 5,
      maxNights: 7,
    });
    expect(planned).toBe(actual);
  });

  it("matches for a window spanning two months", async () => {
    const { planned, actual } = await callsMadeFor({
      departureDate: "2026-12-26",
      returnDate: "2027-01-03",
      flexibilityDays: 2,
      minNights: 5,
      maxNights: 7,
    });
    expect(planned).toBe(actual);
  });

  it("matches for a window spanning three months", async () => {
    const { planned, actual } = await callsMadeFor({
      departureDate: "2026-12-20",
      returnDate: "2027-02-10",
      flexibilityDays: 0,
      minNights: 5,
      maxNights: 40,
    });
    expect(planned).toBe(actual);
  });
});
