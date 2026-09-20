import { failedResult } from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import { exploreFlights, type RankedCandidate } from "./flight-exploration.js";
import { OPTIMIZER_VERSION, runFlightSearch, searchFingerprint } from "./search-trace.js";
import {
  cityRepository,
  fixtureAirports,
  fixtureGeography,
  FCO,
  metrics,
  request,
  roundTrip,
  SAW,
  searchResult,
  stubFlightProvider,
} from "./test-fixtures.js";

const istanbulTrip = roundTrip({
  id: "istanbul",
  destination: SAW,
  outbound: ["2026-12-27T09:00+01:00", "2026-12-27T12:00+03:00"],
  inbound: ["2027-01-02T13:00+03:00", "2027-01-02T14:00+01:00"],
  amountMinor: 7900,
});

const romeTrip = roundTrip({
  id: "rome",
  destination: FCO,
  outbound: ["2026-12-27T10:00+01:00", "2026-12-27T11:30+01:00"],
  inbound: ["2027-01-02T18:00+01:00", "2027-01-02T19:30+01:00"],
  amountMinor: 12000,
});

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 18, 9, 0, tick++));
}

async function trace(overrides: Record<string, unknown> = {}) {
  return runFlightSearch(
    request(overrides),
    { flightProvider: stubFlightProvider(searchResult([romeTrip])), cities: cityRepository, geography: fixtureGeography, airports: fixtureAirports },
    { currency: "EUR", now: fixedClock(), newSearchId: () => "search-1" },
  );
}

describe("searchFingerprint", () => {
  it("is stable for the same request", () => {
    expect(searchFingerprint(request(), "EUR")).toBe(searchFingerprint(request(), "EUR"));
  });

  it("ignores the order fields were written in", () => {
    const a = searchFingerprint(request({ travelers: 2, minNights: 5 }), "EUR");
    const b = searchFingerprint(request({ minNights: 5, travelers: 2 }), "EUR");
    expect(a).toBe(b);
  });

  it("changes when the request changes", () => {
    expect(searchFingerprint(request({ travelers: 3 }), "EUR")).not.toBe(
      searchFingerprint(request(), "EUR"),
    );
    expect(searchFingerprint(request({ flexibilityDays: 3 }), "EUR")).not.toBe(
      searchFingerprint(request(), "EUR"),
    );
  });

  it("changes with the search strategy, which answers the same request differently", () => {
    expect(searchFingerprint(request(), "EUR", OPTIMIZER_VERSION, "composed")).not.toBe(
      searchFingerprint(request(), "EUR", OPTIMIZER_VERSION, "provider_round_trips"),
    );
  });

  it("changes with the currency and the optimizer version", () => {
    expect(searchFingerprint(request(), "BAM")).not.toBe(searchFingerprint(request(), "EUR"));
    expect(searchFingerprint(request(), "EUR", "other")).not.toBe(
      searchFingerprint(request(), "EUR"),
    );
  });
});

describe("runFlightSearch", () => {
  it("records what produced the result", async () => {
    const result = await trace();
    expect(result).toMatchObject({
      searchId: "search-1",
      optimizerVersion: OPTIMIZER_VERSION,
      status: "ok",
      currency: "EUR",
    });
    expect(result.fingerprint).toHaveLength(64);
    expect(result.request.origin).toBe("SJJ");
    expect(result.window?.mode).toBe("window");
    expect(result.counts.candidatesBuilt).toBe(1);
    expect(result.destinations[0]?.city?.name).toBe("Rome");
  });

  it("records the provider it used and its metrics", async () => {
    const result = await trace();
    expect(result.provider.descriptor.id).toBe("fixture-flights");
    expect(result.provider.metrics).toEqual(metrics);
    expect(result.provider.failures).toEqual([]);
  });

  it("reports only the stages this phase runs", async () => {
    const result = await trace();
    expect(result.stages.map((stage) => stage.stage)).toEqual([
      "flights",
      "accommodation",
      "optimization",
      "complete",
    ]);
    // Ground transport has no licensed source, so it is absent rather than
    // reported as an empty stage.
    expect(result.stages.some((stage) => stage.stage === "ground_transport")).toBe(false);
  });

  it("runs the accommodation stage without a provider, and says so", async () => {
    const result = await trace();
    expect(result.accommodation?.providerId).toBeUndefined();
    expect(result.accommodation?.queriesMade).toBe(0);
    // Every stay reports why it has no price, rather than showing none.
    const coverage = result.destinations
      .flatMap((destination) => destination.candidates)
      .flatMap((candidate) => candidate.summary.accommodation);
    expect(coverage.length).toBeGreaterThan(0);
    expect(coverage.every((entry) => entry.state === "not_searched")).toBe(true);
    expect(
      coverage.every((entry) => "reason" in entry && entry.reason === "no_provider"),
    ).toBe(true);
  });

  it("times the run", async () => {
    const result = await trace();
    expect(result.startedAt).toBe("2026-09-18T09:00:00.000Z");
    // The clock also stamps the estimates the exploration produces.
    expect(result.completedAt).toBe("2026-09-18T09:00:04.000Z");
  });

  it("keeps the trace when the search fails", async () => {
    const result = await runFlightSearch(
      request(),
      {
        flightProvider: stubFlightProvider(
          failedResult(
            "fixture-flights",
            [{ kind: "unauthorized", message: "bad token", retryable: false }],
            metrics,
          ),
        ),
        cities: cityRepository,
        geography: fixtureGeography,
        airports: fixtureAirports,
      },
      { currency: "EUR", now: fixedClock(), newSearchId: () => "search-2" },
    );
    expect(result.status).toBe("failed");
    expect(result.searchId).toBe("search-2");
    expect(result.provider.failures[0]?.kind).toBe("unauthorized");
    expect(result.destinations).toEqual([]);
  });

  it("gives identical requests the same fingerprint but different search ids", async () => {
    let counter = 0;
    const run = async () =>
      runFlightSearch(
        request(),
        { flightProvider: stubFlightProvider(searchResult([romeTrip])), cities: cityRepository, geography: fixtureGeography, airports: fixtureAirports },
        { currency: "EUR", now: fixedClock(), newSearchId: () => `search-${String(++counter)}` },
      );
    const [first, second] = [await run(), await run()];
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.searchId).not.toBe(second.searchId);
    expect(first.destinations.map((d) => d.candidates.map((c) => c.candidate.id))).toEqual(
      second.destinations.map((d) => d.candidates.map((c) => c.candidate.id)),
    );
  });

  it("carries the counts that explain a thin result", async () => {
    const tooShort = roundTrip({
      id: "too-short",
      destination: SAW,
      outbound: ["2026-12-28T10:00+01:00", "2026-12-28T13:00+03:00"],
      inbound: ["2026-12-30T14:00+03:00", "2026-12-30T15:00+01:00"],
      amountMinor: 5000,
    });
    const result = await runFlightSearch(
      request(),
      {
        flightProvider: stubFlightProvider(searchResult([romeTrip, tooShort])),
        cities: cityRepository,
        geography: fixtureGeography,
        airports: fixtureAirports,
      },
      { currency: "EUR", now: fixedClock(), newSearchId: () => "search-3" },
    );
    expect(result.counts).toMatchObject({
      offersReturned: 2,
      candidatesBuilt: 1,
      rejectedNights: 1,
      destinations: 1,
    });
  });
});

describe("transport behaviour with no accommodation provider", () => {
  /** What transport alone produced, before any accommodation stage ran. */
  async function transportOnly(overrides: Record<string, unknown> = {}) {
    return exploreFlights(
      request(overrides),
      {
        flightProvider: stubFlightProvider(searchResult([romeTrip, istanbulTrip])),
        cities: cityRepository,
        geography: fixtureGeography,
        airports: fixtureAirports,
      },
      { currency: "EUR", now: fixedClock() },
    );
  }

  async function traced(overrides: Record<string, unknown> = {}) {
    return runFlightSearch(
      request(overrides),
      {
        flightProvider: stubFlightProvider(searchResult([romeTrip, istanbulTrip])),
        cities: cityRepository,
        geography: fixtureGeography,
        airports: fixtureAirports,
      },
      { currency: "EUR", now: fixedClock(), newSearchId: () => "search-r" },
    );
  }

  const flat = (destinations: readonly { candidates: readonly RankedCandidate[] }[]) =>
    destinations.flatMap((destination) => destination.candidates);

  it("leaves the candidates and their order exactly as transport found them", async () => {
    const before = flat((await transportOnly()).destinations);
    const after = flat((await traced()).destinations);
    expect(after.map((entry) => entry.candidate.id)).toEqual(
      before.map((entry) => entry.candidate.id),
    );
  });

  it("leaves transport costs and per-person shares untouched", async () => {
    const before = flat((await transportOnly()).destinations);
    const after = flat((await traced()).destinations);
    expect(after.map((entry) => entry.summary.cost.total)).toEqual(
      before.map((entry) => entry.summary.cost.total),
    );
    expect(after.map((entry) => entry.summary.cost.perPersonShares)).toEqual(
      before.map((entry) => entry.summary.cost.perPersonShares),
    );
    expect(after.map((entry) => entry.summary.cost.fares)).toEqual(
      before.map((entry) => entry.summary.cost.fares),
    );
  });

  it("leaves transport provenance untouched", async () => {
    const before = flat((await transportOnly()).destinations);
    const after = flat((await traced()).destinations);
    expect(after.map((entry) => entry.summary.provenance)).toEqual(
      before.map((entry) => entry.summary.provenance),
    );
  });

  it("adds no accommodation amount to any total", async () => {
    const after = flat((await traced()).destinations);
    expect(after.every((entry) => entry.summary.cost.accommodation.amountMinor === 0)).toBe(true);
    expect(
      after.every((entry) => entry.summary.cost.total.amountMinor === entry.summary.cost.transport.amountMinor),
    ).toBe(true);
  });

  it("makes no accommodation provider call", async () => {
    const result = await traced();
    expect(result.accommodation?.queriesMade).toBe(0);
    expect(result.accommodation?.queriesPlanned).toBe(0);
    expect(result.accommodation?.budget.usedProviderCalls).toBe(0);
    expect(result.accommodation?.failures).toEqual([]);
  });

  it("presents nothing as a complete trip cost", async () => {
    const after = flat((await traced()).destinations);
    expect(after.every((entry) => entry.summary.cost.scope !== "complete")).toBe(true);
  });
});
