import { failedResult, partialResult, type FlightSearchQuery } from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import { exploreFlights } from "./flight-exploration.js";
import {
  cityRepository,
  CIA,
  FCO,
  metrics,
  request,
  roundTrip,
  SAW,
  searchResult,
  stubFlightProvider,
} from "./test-fixtures.js";

const options = { currency: "EUR" } as const;

// A 6-night Rome trip inside the 24 Dec .. 5 Jan window.
const romeTrip = roundTrip({
  id: "rome",
  destination: FCO,
  outbound: ["2026-12-27T10:00+01:00", "2026-12-27T11:30+01:00"],
  inbound: ["2027-01-02T18:00+01:00", "2027-01-02T19:30+01:00"],
  amountMinor: 12000,
});

// A cheaper 6-night Istanbul trip.
const istanbulTrip = roundTrip({
  id: "istanbul",
  destination: SAW,
  outbound: ["2026-12-27T09:00+01:00", "2026-12-27T12:00+03:00"],
  inbound: ["2027-01-02T13:00+03:00", "2027-01-02T14:00+01:00"],
  amountMinor: 7900,
});

async function explore(
  parts: Parameters<typeof searchResult>[0],
  overrides: Record<string, unknown> = {},
) {
  return exploreFlights(
    request(overrides),
    { flightProvider: stubFlightProvider(searchResult(parts)), cities: cityRepository },
    options,
  );
}

describe("exploreFlights", () => {
  it("queries the provider for round trips inside the resolved window", async () => {
    let seen: FlightSearchQuery | undefined;
    await exploreFlights(
      request(),
      {
        flightProvider: stubFlightProvider(searchResult([romeTrip]), (query) => {
          seen = query;
        }),
        cities: cityRepository,
      },
      options,
    );
    expect(seen).toMatchObject({
      origins: ["SJJ"],
      destinations: "anywhere",
      travelers: 2,
      currency: "EUR",
    });
    // Window mode: 24 Dec .. 5 Jan, departure bounded by the 5-night minimum.
    expect(seen?.departureDates).toEqual({ from: "2026-12-24", to: "2026-12-31" });
    expect(seen?.returnDates).toEqual({ from: "2026-12-29", to: "2027-01-05" });
  });

  it("builds one candidate per round-trip fare and ranks by total cost", async () => {
    const result = await explore([romeTrip, istanbulTrip]);
    expect(result.status).toBe("ok");
    expect(result.counts.candidatesBuilt).toBe(2);
    expect(result.destinations.map((destination) => destination.city?.name)).toEqual([
      "Istanbul",
      "Rome",
    ]);
    const [cheapest] = result.destinations;
    expect(cheapest?.candidates[0]?.summary.cost.total).toEqual({
      amountMinor: 15800, // 79.00 per traveler x 2, counted once
      currency: "EUR",
    });
    expect(cheapest?.candidates[0]?.nights).toBe(6);
  });

  it("labels costs as transport-only, never a complete-trip cost", async () => {
    const result = await explore([romeTrip]);
    expect(result.destinations[0]?.candidates[0]?.summary.cost.scope).toBe(
      "transport_and_partial_accommodation",
    );
    expect(result.destinations[0]?.candidates[0]?.summary.sourceType).toBe("cached");
  });

  it("groups two airports of one city into a single destination", async () => {
    const ciampino = roundTrip({
      id: "rome-cia",
      destination: CIA,
      outbound: ["2026-12-27T08:00+01:00", "2026-12-27T09:30+01:00"],
      inbound: ["2027-01-02T20:00+01:00", "2027-01-02T21:30+01:00"],
      amountMinor: 9000,
    });
    const result = await explore([romeTrip, ciampino]);
    expect(result.destinations).toHaveLength(1);
    const [rome] = result.destinations;
    expect(rome?.city?.name).toBe("Rome");
    expect(rome?.airports.map((airport) => airport.iata).sort()).toEqual(["CIA", "FCO"]);
    // Both candidates survive, cheapest first, each keeping its own airport.
    expect(rome?.candidates).toHaveLength(2);
    expect(rome?.candidates[0]?.candidate.segments[0]?.destination.iata).toBe("CIA");
  });

  it("keeps a destination whose city cannot be resolved, and reports it", async () => {
    const unknownCity = roundTrip({
      id: "unknown",
      destination: { ...FCO, id: "airport:ZZZ", iata: "ZZZ" },
      outbound: ["2026-12-27T10:00+01:00", "2026-12-27T11:30+01:00"],
      inbound: ["2027-01-02T18:00+01:00", "2027-01-02T19:30+01:00"],
      amountMinor: 5000,
    });
    const result = await explore([unknownCity]);
    expect(result.destinations).toHaveLength(1);
    expect(result.destinations[0]?.city).toBeUndefined();
    expect(result.destinations[0]?.airports[0]?.iata).toBe("ZZZ");
    expect(result.issues.map((issue) => issue.code)).toEqual(["UNKNOWN_CITY_FOR_AIRPORT"]);
  });
});

describe("exploreFlights — constraints", () => {
  it("rejects trips outside the travel window and counts them", async () => {
    const tooEarly = roundTrip({
      id: "too-early",
      destination: FCO,
      outbound: ["2026-12-20T10:00+01:00", "2026-12-20T11:30+01:00"],
      inbound: ["2026-12-26T18:00+01:00", "2026-12-26T19:30+01:00"],
      amountMinor: 5000,
    });
    const result = await explore([tooEarly, romeTrip]);
    expect(result.counts.rejectedOutsideWindow).toBe(1);
    expect(result.counts.candidatesBuilt).toBe(1);
  });

  it("rejects trips whose nights fall outside the requested range", async () => {
    const tooShort = roundTrip({
      id: "too-short",
      destination: FCO,
      outbound: ["2026-12-28T10:00+01:00", "2026-12-28T11:30+01:00"],
      inbound: ["2026-12-30T18:00+01:00", "2026-12-30T19:30+01:00"],
      amountMinor: 5000,
    });
    const result = await explore([tooShort]);
    expect(result.counts.rejectedNights).toBe(1);
    expect(result.destinations).toHaveLength(0);
  });

  it("rejects candidates already over budget on transport alone", async () => {
    // EUR 700 per person x 2 travelers = EUR 1,400 total.
    const expensive = roundTrip({
      id: "expensive",
      destination: FCO,
      outbound: ["2026-12-27T10:00+01:00", "2026-12-27T11:30+01:00"],
      inbound: ["2027-01-02T18:00+01:00", "2027-01-02T19:30+01:00"],
      amountMinor: 80000,
    });
    const result = await explore([expensive, istanbulTrip], {
      budget: { kind: "perPerson", amount: { amountMinor: 70000, currency: "EUR" } },
    });
    expect(result.counts.rejectedBudget).toBe(1);
    expect(result.counts.candidatesBuilt).toBe(1);
  });

  it("does not multiply a total budget by travelers", async () => {
    const result = await explore([istanbulTrip], {
      budget: { kind: "total", amount: { amountMinor: 15000, currency: "EUR" } },
    });
    // EUR 158 total is over a EUR 150 total budget.
    expect(result.counts.rejectedBudget).toBe(1);
  });

  it("refuses to compare a budget in another currency", async () => {
    const result = await explore([istanbulTrip], {
      budget: { kind: "total", amount: { amountMinor: 200000, currency: "BAM" } },
    });
    expect(result.counts.rejectedInvalid).toBe(1);
    expect(result.issues.map((issue) => issue.code)).toContain("BUDGET_CURRENCY_MISMATCH");
  });

  it("rejects an offer that is not a round trip", async () => {
    const oneWay = {
      segments: romeTrip.segments.slice(0, 1),
      offer: { ...romeTrip.offer, segmentIds: [romeTrip.segments[0]?.id ?? ""] },
    };
    const result = await explore([oneWay]);
    expect(result.counts.rejectedNotRoundTrip).toBe(1);
    expect(result.destinations).toHaveLength(0);
  });

  it("fails the search when the window cannot hold the requested nights", async () => {
    const result = await explore([romeTrip], {
      departureDate: "2026-12-26",
      returnDate: "2026-12-28",
      flexibilityDays: 0,
      minNights: 5,
    });
    expect(result.status).toBe("failed");
    expect(result.issues[0]?.code).toBe("WINDOW_TOO_SHORT_FOR_NIGHTS");
  });
});

describe("exploreFlights — provider outcomes", () => {
  it("fails when the provider fails, keeping its failures and metrics", async () => {
    const result = await exploreFlights(
      request(),
      {
        flightProvider: stubFlightProvider(
          failedResult("fixture-flights", [
            { kind: "unauthorized", message: "bad token", retryable: false },
          ], metrics),
        ),
        cities: cityRepository,
      },
      options,
    );
    expect(result.status).toBe("failed");
    expect(result.providerFailures[0]?.kind).toBe("unauthorized");
    expect(result.providerMetrics).toEqual(metrics);
  });

  it("stays partial when the provider returns data and failures", async () => {
    const result = await exploreFlights(
      request(),
      {
        flightProvider: stubFlightProvider(
          partialResult(
            "fixture-flights",
            { segments: romeTrip.segments, offers: [romeTrip.offer] },
            [{ kind: "timeout", message: "one month timed out", retryable: true }],
            metrics,
          ),
        ),
        cities: cityRepository,
      },
      options,
    );
    expect(result.status).toBe("partial");
    expect(result.destinations).toHaveLength(1);
    expect(result.providerFailures).toHaveLength(1);
  });

  it("treats no results as a successful search with counts", async () => {
    const result = await explore([]);
    expect(result.status).toBe("ok");
    expect(result.destinations).toEqual([]);
    expect(result.counts).toMatchObject({ offersReturned: 0, candidatesBuilt: 0, destinations: 0 });
  });

  it("is deterministic: same inputs, same order", async () => {
    const first = await explore([romeTrip, istanbulTrip]);
    const second = await explore([istanbulTrip, romeTrip]);
    expect(first.destinations.map((d) => d.city?.id)).toEqual(
      second.destinations.map((d) => d.city?.id),
    );
    expect(first.destinations.map((d) => d.candidates.map((c) => c.candidate.id))).toEqual(
      second.destinations.map((d) => d.candidates.map((c) => c.candidate.id)),
    );
  });
});
