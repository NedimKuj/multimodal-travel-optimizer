import { parseLocalDate, parseUtcInstant, type FlightSearchQuery } from "@travel-optimizer/domain";
import { buildAirportRepository } from "@travel-optimizer/geo";
import { describe, expect, it } from "vitest";

import { createInMemoryResponseCache } from "../cache.js";
import type { FetchLike } from "../http.js";
import { loadAviasalesConfig, type AviasalesConfig } from "./config.js";
import { createAviasalesFlightProvider, monthsInRange } from "./provider.js";
import { ONE_WAY_RECORD, pricesForDatesBody, ROUND_TRIP_RECORD } from "./test-fixtures.js";

function airportRecord(code: string, timeZone: string) {
  return {
    name_translations: { en: `${code} Test Airport` },
    city_code: code,
    country_code: "BA",
    time_zone: timeZone,
    code,
    iata_type: "airport",
    name: null,
    coordinates: { lat: 43.8, lon: 18.3 },
    flightable: true,
  };
}

const airports = buildAirportRepository(
  [
    airportRecord("SJJ", "Europe/Sarajevo"),
    airportRecord("FCO", "Europe/Rome"),
    airportRecord("SAW", "Europe/Istanbul"),
  ],
  { source: "https://example.test/a.json", fetchedAt: parseUtcInstant("2026-09-18T08:00:00Z") },
).repository;

function config(overrides: Partial<Record<string, string>> = {}): AviasalesConfig {
  const result = loadAviasalesConfig({ AVIASALES_API_TOKEN: "secret-token", ...overrides });
  if (!result.ok) throw new Error("expected config");
  return result.config;
}

const december: FlightSearchQuery = {
  origins: ["SJJ"],
  destinations: "anywhere",
  departureDates: { from: parseLocalDate("2026-12-20"), to: parseLocalDate("2026-12-31") },
  travelers: 2,
  currency: "EUR",
};

function stubFetch(body: string, urls: string[] = []): FetchLike {
  return (url) => {
    urls.push(url);
    return Promise.resolve(new Response(body));
  };
}

describe("monthsInRange", () => {
  it("covers each month a range touches", () => {
    expect(
      monthsInRange({ from: parseLocalDate("2026-12-26"), to: parseLocalDate("2027-01-03") }),
    ).toEqual(["2026-12", "2027-01"]);
    expect(
      monthsInRange({ from: parseLocalDate("2026-12-01"), to: parseLocalDate("2026-12-31") }),
    ).toEqual(["2026-12"]);
  });
});

describe("AviasalesFlightProvider", () => {
  it("declares itself a cached-only flight provider", () => {
    const provider = createAviasalesFlightProvider({ config: config(), airports });
    expect(provider.descriptor).toEqual({
      id: "aviasales",
      kind: "flight",
      enabled: true,
      sourceTypes: ["cached"],
    });
  });

  it("queries by month with unique=true for anywhere searches", async () => {
    const urls: string[] = [];
    const provider = createAviasalesFlightProvider({
      config: config(),
      airports,
      fetchImpl: stubFetch(pricesForDatesBody([ONE_WAY_RECORD]), urls),
    });
    const result = await provider.search(december);

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("departure_at=2026-12");
    expect(urls[0]).toContain("unique=true");
    expect(urls[0]).toContain("one_way=true");
    expect(urls[0]).not.toContain("secret-token");
    expect(urls[0]).not.toContain("secret-token");
    expect(result.status).toBe("ok");
  });

  it("returns normalized segments and offers, never provider records", async () => {
    const provider = createAviasalesFlightProvider({
      config: config(),
      airports,
      fetchImpl: stubFetch(pricesForDatesBody([ONE_WAY_RECORD])),
    });
    const result = await provider.search(december);
    if (result.status === "failed") throw new Error("expected data");
    expect(result.data.offers[0]?.provenance).toMatchObject({
      provider: "aviasales",
      sourceType: "cached",
    });
    expect(JSON.stringify(result.data)).not.toContain("origin_airport");
  });

  it("filters month results back to the requested window", async () => {
    const outsideWindow = { ...ONE_WAY_RECORD, departure_at: "2026-12-05T17:10:00+01:00" };
    const provider = createAviasalesFlightProvider({
      config: config(),
      airports,
      fetchImpl: stubFetch(pricesForDatesBody([ONE_WAY_RECORD, outsideWindow])),
    });
    const result = await provider.search(december);
    if (result.status === "failed") throw new Error("expected data");
    expect(result.data.offers).toHaveLength(1);
    expect(result.data.segments).toHaveLength(1);
    expect(result.data.segments[0]?.departureAt.instant).toBe("2026-12-26T16:10:00.000Z");
  });

  it("requires round-trip returns to fall in the return window", async () => {
    const provider = createAviasalesFlightProvider({
      config: config(),
      airports,
      fetchImpl: stubFetch(pricesForDatesBody([ROUND_TRIP_RECORD])),
    });
    const inWindow = await provider.search({
      ...december,
      departureDates: { from: parseLocalDate("2026-12-26"), to: parseLocalDate("2026-12-31") },
      returnDates: { from: parseLocalDate("2027-01-05"), to: parseLocalDate("2027-01-10") },
    });
    if (inWindow.status === "failed") throw new Error("expected data");
    expect(inWindow.data.offers).toHaveLength(1);
    expect(inWindow.data.segments).toHaveLength(2);

    const outOfWindow = await provider.search({
      ...december,
      departureDates: { from: parseLocalDate("2026-12-26"), to: parseLocalDate("2026-12-31") },
      returnDates: { from: parseLocalDate("2027-01-01"), to: parseLocalDate("2027-01-04") },
    });
    if (outOfWindow.status === "failed") throw new Error("expected data");
    expect(outOfWindow.data.offers).toHaveLength(0);
  });

  it("does not ask for unique destinations on a round-trip search", async () => {
    // One record per destination means one date pair per destination, which
    // mostly falls outside a specific travel window.
    const urls: string[] = [];
    const provider = createAviasalesFlightProvider({
      config: config(),
      airports,
      fetchImpl: stubFetch(pricesForDatesBody([]), urls),
    });
    await provider.search({
      ...december,
      departureDates: { from: parseLocalDate("2026-12-26"), to: parseLocalDate("2026-12-31") },
      returnDates: { from: parseLocalDate("2027-01-01"), to: parseLocalDate("2027-01-05") },
    });
    expect(urls[0]).toContain("one_way=false");
    expect(urls[0]).not.toContain("unique");
  });

  it("queries every month a return window touches", async () => {
    const urls: string[] = [];
    const provider = createAviasalesFlightProvider({
      config: config(),
      airports,
      fetchImpl: stubFetch(pricesForDatesBody([]), urls),
    });
    await provider.search({
      ...december,
      departureDates: { from: parseLocalDate("2026-12-26"), to: parseLocalDate("2026-12-31") },
      // Crosses a month boundary: January returns must not be dropped.
      returnDates: { from: parseLocalDate("2026-12-30"), to: parseLocalDate("2027-01-04") },
    });
    expect(urls).toHaveLength(2);
    expect(urls.some((url) => url.includes("return_at=2026-12"))).toBe(true);
    expect(urls.some((url) => url.includes("return_at=2027-01"))).toBe(true);
  });

  it("skips return months that precede the outbound month", async () => {
    const urls: string[] = [];
    const provider = createAviasalesFlightProvider({
      config: config(),
      airports,
      fetchImpl: stubFetch(pricesForDatesBody([]), urls),
    });
    await provider.search({
      ...december,
      departureDates: { from: parseLocalDate("2026-12-26"), to: parseLocalDate("2027-01-02") },
      returnDates: { from: parseLocalDate("2027-01-01"), to: parseLocalDate("2027-01-05") },
    });
    // Dec→Jan and Jan→Jan, but never Jan→Dec.
    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.includes("return_at=2027-01"))).toBe(true);
  });

  it("reports dropped records instead of hiding them", async () => {
    const unknownAirport = { ...ONE_WAY_RECORD, destination_airport: "ZZZ" };
    const provider = createAviasalesFlightProvider({
      config: config(),
      airports,
      fetchImpl: stubFetch(pricesForDatesBody([ONE_WAY_RECORD, unknownAirport])),
    });
    const result = await provider.search(december);
    expect(result.status).toBe("partial");
    if (result.status === "failed") throw new Error("expected data");
    expect(result.failures[0]?.message).toContain("UNKNOWN_IATA_CODE×1");
    expect(result.data.offers).toHaveLength(1);
  });

  it("fails without throwing when the provider rejects the token", async () => {
    const provider = createAviasalesFlightProvider({
      config: config(),
      airports,
      fetchImpl: () => Promise.resolve(new Response("nope", { status: 401 })),
    });
    const result = await provider.search(december);
    expect(result.status).toBe("failed");
    expect(result.failures[0]?.kind).toBe("unauthorized");
    expect(result.metrics.requestCount).toBe(1);
  });

  it("keeps partial data when only some calls fail", async () => {
    let call = 0;
    const provider = createAviasalesFlightProvider({
      config: config(),
      airports,
      fetchImpl: () => {
        call += 1;
        return Promise.resolve(
          call === 1
            ? new Response(pricesForDatesBody([ONE_WAY_RECORD]))
            : new Response("boom", { status: 503 }),
        );
      },
    });
    const result = await provider.search({
      ...december,
      departureDates: { from: parseLocalDate("2026-12-20"), to: parseLocalDate("2027-01-10") },
    });
    expect(result.status).toBe("partial");
    if (result.status === "failed") throw new Error("expected data");
    expect(result.data.offers).toHaveLength(1);
    expect(result.failures.some((failure) => failure.kind === "unavailable")).toBe(true);
  });

  it("never mixes currencies: a mismatched response currency is a failure", async () => {
    const provider = createAviasalesFlightProvider({
      config: config(),
      airports,
      fetchImpl: stubFetch(
        JSON.stringify({ success: true, currency: "usd", data: [ONE_WAY_RECORD] }),
      ),
    });
    const result = await provider.search(december);
    expect(result.status).toBe("failed");
    expect(result.failures[0]?.message).toContain("usd");
  });

  it("checks the cache before calling the provider", async () => {
    const urls: string[] = [];
    const cache = createInMemoryResponseCache(60_000);
    const provider = createAviasalesFlightProvider({
      config: config(),
      airports,
      cache,
      fetchImpl: stubFetch(pricesForDatesBody([ONE_WAY_RECORD]), urls),
    });
    const first = await provider.search(december);
    const second = await provider.search(december);

    expect(urls).toHaveLength(1);
    expect(first.metrics.requestCount).toBe(1);
    expect(second.metrics.requestCount).toBe(0);
    expect(second.metrics.cache).toBe("hit");
    if (second.status === "failed") throw new Error("expected data");
    expect(second.data.offers).toHaveLength(1);
  });

  it("refuses a query that would exceed the call budget rather than truncating it", async () => {
    const urls: string[] = [];
    const provider = createAviasalesFlightProvider({
      config: config(),
      airports,
      fetchImpl: stubFetch(pricesForDatesBody([]), urls),
    });
    const result = await provider.search({
      ...december,
      origins: ["SJJ", "TZL", "OMO"],
      destinations: ["FCO", "SAW", "VIE", "PRG", "BER"],
    });
    expect(result.status).toBe("failed");
    expect(result.failures[0]?.message).toContain("call budget");
    expect(urls).toHaveLength(0);
  });

  it("allows a query that sits exactly on the call budget", async () => {
    const urls: string[] = [];
    const provider = createAviasalesFlightProvider({
      config: config(),
      airports,
      fetchImpl: stubFetch(pricesForDatesBody([]), urls),
    });
    const result = await provider.search({
      ...december,
      origins: ["SJJ", "TZL", "OMO"],
      destinations: ["FCO", "SAW", "VIE", "PRG"],
    });
    expect(urls).toHaveLength(12);
    expect(result.status).toBe("ok");
  });

  it("does not call the provider when disabled", async () => {
    const urls: string[] = [];
    const provider = createAviasalesFlightProvider({
      config: { ...config(), enabled: false },
      airports,
      fetchImpl: stubFetch(pricesForDatesBody([ONE_WAY_RECORD]), urls),
    });
    const result = await provider.search(december);
    expect(result.status).toBe("failed");
    expect(urls).toHaveLength(0);
  });
});
