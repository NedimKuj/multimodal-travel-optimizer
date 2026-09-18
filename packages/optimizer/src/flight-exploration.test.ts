import { failedResult, partialResult, type FlightSearchQuery } from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import { exploreFlights } from "./flight-exploration.js";
import { offer, segment } from "./test-fixtures.js";
import {
  cityRepository,
  fixtureAirports,
  fixtureGeography,
  CIA,
  FCO,
  metrics,
  request,
  roundTrip,
  SAW,
  searchResult,
  stubFlightProvider,
  TZL,
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
    { flightProvider: stubFlightProvider(searchResult(parts)), cities: cityRepository, geography: fixtureGeography, airports: fixtureAirports },
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
        geography: fixtureGeography,
        airports: fixtureAirports,
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
    const best = cheapest?.candidates[0];
    // 79.00 fare per traveler x 2, counted once, plus two estimated transfers
    // to and from Istanbul (13.40 each per traveler).
    expect(best?.summary.cost.fares).toEqual({ amountMinor: 15800, currency: "EUR" });
    expect(best?.summary.cost.groundTransfer).toEqual({ amountMinor: 5360, currency: "EUR" });
    expect(best?.summary.cost.total).toEqual({ amountMinor: 21160, currency: "EUR" });
    expect(best?.nights).toBe(6);
  });

  it("labels costs as transport-only, never a complete-trip cost", async () => {
    const result = await explore([romeTrip]);
    expect(result.destinations[0]?.candidates[0]?.summary.cost.scope).toBe(
      "transport_and_partial_accommodation",
    );
    // The fare stays cached; only the transfer is estimated (ADR 0011).
    expect(result.destinations[0]?.candidates[0]?.summary.provenance).toMatchObject({
      fareSourceType: "cached",
      fareSources: ["fixture-flights"],
      estimatedComponents: ["access_transfer"],
      partiallyEstimated: true,
    });
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
        geography: fixtureGeography,
        airports: fixtureAirports,
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
        geography: fixtureGeography,
        airports: fixtureAirports,
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

describe("exploreFlights — access transfers and feasibility", () => {
  it("attaches a transfer for a far airport and none for a near one", async () => {
    // Fiumicino is 30 km from Rome; Ciampino is 15 km.
    const viaCiampino = roundTrip({
      id: "rome-cia",
      destination: CIA,
      outbound: ["2026-12-27T08:00+01:00", "2026-12-27T09:30+01:00"],
      inbound: ["2027-01-02T20:00+01:00", "2027-01-02T21:30+01:00"],
      amountMinor: 12000,
    });
    const result = await explore([viaCiampino]);
    const candidate = result.destinations[0]?.candidates[0];
    expect(candidate?.candidate.segments.map((s) => s.mode)).toEqual(["flight", "flight"]);
    expect(candidate?.summary.cost.groundTransfer.amountMinor).toBe(0);
    expect(candidate?.summary.provenance.partiallyEstimated).toBe(false);
  });

  it("counts a far airport's transfer in the total, both ways", async () => {
    const result = await explore([romeTrip]);
    const candidate = result.destinations[0]?.candidates[0];
    expect(candidate?.candidate.segments.map((s) => s.mode)).toEqual([
      "flight",
      "ground_transfer",
      "ground_transfer",
      "flight",
    ]);
    // 10.80 each way, per traveler, for two travelers.
    expect(candidate?.summary.cost.groundTransfer).toEqual({ amountMinor: 4320, currency: "EUR" });
  });

  it("lets a dearer fare into a near airport beat a cheap one into a far airport", async () => {
    // Spec §19: FMM at EUR 75 plus a transfer should lose to MUC at EUR 100.
    const cheapFarAirport = roundTrip({
      id: "far",
      destination: FCO, // 30 km out
      outbound: ["2026-12-27T08:00+01:00", "2026-12-27T09:30+01:00"],
      inbound: ["2027-01-02T20:00+01:00", "2027-01-02T21:30+01:00"],
      amountMinor: 7500,
    });
    const dearerNearAirport = roundTrip({
      id: "near",
      destination: CIA, // 15 km out, no transfer
      outbound: ["2026-12-27T08:00+01:00", "2026-12-27T09:30+01:00"],
      inbound: ["2027-01-02T20:00+01:00", "2027-01-02T21:30+01:00"],
      amountMinor: 8200,
    });
    const result = await explore([cheapFarAirport, dearerNearAirport]);
    const [rome] = result.destinations;
    // Both are Rome, so they compete inside one destination.
    expect(rome?.candidates).toHaveLength(2);
    const winner = rome?.candidates[0];
    expect(winner?.candidate.id).toContain("near");
    expect(winner?.summary.cost.total).toEqual({ amountMinor: 16400, currency: "EUR" });
    // The far airport's fare is cheaper, but its total is not.
    expect(rome?.candidates[1]?.summary.cost.fares.amountMinor).toBe(15000);
    expect(rome?.candidates[1]?.summary.cost.total.amountMinor).toBe(19320);
  });

  it("rejects a fare whose connection cannot be made", async () => {
    // A 30-minute turnaround at the same airport: 120 minutes are required.
    const impossible = roundTrip({
      id: "impossible",
      destination: CIA,
      outbound: ["2026-12-27T08:00+01:00", "2026-12-27T09:30+01:00"],
      inbound: ["2026-12-27T10:00+01:00", "2026-12-27T11:30+01:00"],
      amountMinor: 5000,
    });
    const result = await explore([impossible]);
    expect(result.counts.rejectedInfeasible).toBe(1);
    expect(result.destinations).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toContain("INFEASIBLE_CONNECTION");
  });

  it("keeps the transfer out of the requested date window", async () => {
    // The window bounds the flights; a transfer either side does not move them.
    const result = await explore([romeTrip]);
    const candidate = result.destinations[0]?.candidates[0];
    expect(candidate?.summary.departureDate).toBe("2026-12-27");
    expect(candidate?.summary.returnDate).toBe("2027-01-02");
  });
});


describe("exploreFlights — alternative origins", () => {
  // A fare leaving from Tuzla, 71 km from the requested origin.
  const fromTuzla = {
    segments: [
      segment({
        id: "tzl-out",
        origin: TZL,
        destination: CIA,
        departure: "2026-12-27T10:00+01:00",
        arrival: "2026-12-27T11:30+01:00",
      }),
      segment({
        id: "tzl-back",
        origin: CIA,
        destination: TZL,
        departure: "2027-01-02T18:00+01:00",
        arrival: "2027-01-02T19:30+01:00",
      }),
    ],
    offer: offer("tzl-fare", ["tzl-out", "tzl-back"], 6000),
  };

  it("queries only the requested origin by default", async () => {
    let seen: FlightSearchQuery | undefined;
    await exploreFlights(
      request(),
      {
        flightProvider: stubFlightProvider(searchResult([romeTrip]), (query) => {
          seen = query;
        }),
        cities: cityRepository,
        geography: fixtureGeography,
        airports: fixtureAirports,
      },
      options,
    );
    expect(seen?.origins).toEqual(["SJJ"]);
  });

  it("queries nearby origins when asked, and reports which", async () => {
    let seen: FlightSearchQuery | undefined;
    const result = await exploreFlights(
      request({ alternativeAirports: true }),
      {
        flightProvider: stubFlightProvider(searchResult([romeTrip]), (query) => {
          seen = query;
        }),
        cities: cityRepository,
        geography: fixtureGeography,
        airports: fixtureAirports,
      },
      options,
    );
    expect(seen?.origins).toEqual(["SJJ", "TZL"]);
    expect(result.origins?.origins.map((entry) => entry.airport.iata)).toEqual(["SJJ", "TZL"]);
    expect(result.origins?.plannedCalls).toBeGreaterThan(0);
  });

  it("adds the journey to an alternative origin, so it is judged as a whole trip", async () => {
    const result = await exploreFlights(
      request({ alternativeAirports: true }),
      {
        flightProvider: stubFlightProvider(searchResult([fromTuzla])),
        cities: cityRepository,
        geography: fixtureGeography,
        airports: fixtureAirports,
      },
      options,
    );
    const candidate = result.destinations[0]?.candidates[0];
    // Ciampino needs no access transfer, so these two are the drive to Tuzla.
    expect(candidate?.candidate.segments.filter((s) => s.mode === "ground_transfer")).toHaveLength(2);
    expect(candidate?.candidate.origin.iata).toBe("SJJ");
    expect(candidate?.summary.cost.fares).toEqual({ amountMinor: 12000, currency: "EUR" });
    expect(candidate?.summary.cost.groundTransfer.amountMinor).toBeGreaterThan(0);
    expect(candidate?.summary.provenance).toMatchObject({
      fareSourceType: "cached",
      partiallyEstimated: true,
    });
  });
});

describe("exploreFlights — a transfer that starts the day before", () => {
  it("validates an early flight reached by an overnight transfer", async () => {
    // Leaves Tuzla at 01:30; the drive there starts the previous evening.
    const earlyFromTuzla = {
      segments: [
        segment({
          id: "tzl-early-out",
          origin: TZL,
          destination: CIA,
          departure: "2026-12-27T01:30+01:00",
          arrival: "2026-12-27T03:00+01:00",
        }),
        segment({
          id: "tzl-early-back",
          origin: CIA,
          destination: TZL,
          departure: "2027-01-01T18:00+01:00",
          arrival: "2027-01-01T19:30+01:00",
        }),
      ],
      offer: offer("tzl-early-fare", ["tzl-early-out", "tzl-early-back"], 6000),
    };
    const result = await exploreFlights(
      request({ alternativeAirports: true }),
      {
        flightProvider: stubFlightProvider(searchResult([earlyFromTuzla])),
        cities: cityRepository,
        geography: fixtureGeography,
        airports: fixtureAirports,
      },
      options,
    );
    const candidate = result.destinations[0]?.candidates[0];
    expect(result.counts.rejectedInfeasible).toBe(0);
    // The drive begins on the 26th, before the flight's date.
    const [firstLeg] = candidate?.candidate.segments ?? [];
    expect(firstLeg?.mode).toBe("ground_transfer");
    expect(firstLeg?.departureAt.instant.slice(0, 10)).toBe("2026-12-26");
    // The requested departure date is still the flight's.
    expect(candidate?.summary.departureDate).toBe("2026-12-27");
  });
});
