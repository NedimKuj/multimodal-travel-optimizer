import {
  failedResult,
  okResult,
  type FlightProvider,
  type FlightSearchQuery,
  type ProviderResult,
  type TransportOffer,
  type TransportSearchResult,
  type TransportSegment,
} from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import { discoverOneWayLegs } from "./discovery.js";
import { resolveTravelWindow } from "./travel-window.js";
import {
  CIA,
  FCO,
  metrics,
  offer,
  request,
  SAW,
  segment,
  SJJ,
  TZL,
} from "./test-fixtures.js";

/** Arrival written in the destination's own zone, as a real fare would be. */
const ARRIVAL_OFFSET: Record<string, string> = {
  [FCO.id]: "+01:00",
  [CIA.id]: "+01:00",
  [SAW.id]: "+03:00",
};

function oneWay(id: string, to: typeof FCO, amountMinor: number) {
  const leg = segment({
    id,
    origin: SJJ,
    destination: to,
    departure: "2026-12-27T10:00+01:00",
    arrival: `2026-12-27T13:30${ARRIVAL_OFFSET[to.id] ?? "+01:00"}`,
  });
  return { segments: [leg], offers: [offer(`${id}-fare`, [leg.id], amountMinor)] };
}

function homeward(id: string, from: typeof FCO, amountMinor: number) {
  const leg = segment({
    id,
    origin: from,
    destination: SJJ,
    departure: `2027-01-02T18:00${ARRIVAL_OFFSET[from.id] ?? "+01:00"}`,
    arrival: "2027-01-02T19:30+01:00",
  });
  return { segments: [leg], offers: [offer(`${id}-fare`, [leg.id], amountMinor)] };
}

function result(
  parts: readonly { segments: TransportSegment[]; offers: TransportOffer[] }[],
): ProviderResult<TransportSearchResult> {
  return okResult(
    "fixture-flights",
    {
      segments: parts.flatMap((part) => part.segments),
      offers: parts.flatMap((part) => part.offers),
    },
    metrics,
  );
}

/** A provider that answers stage 1 once, then each return query by origin. */
function stagedProvider(
  outbound: ProviderResult<TransportSearchResult>,
  returns: Record<string, ProviderResult<TransportSearchResult>>,
  queries: FlightSearchQuery[] = [],
): FlightProvider {
  return {
    descriptor: {
      id: "fixture-flights",
      kind: "flight",
      enabled: true,
      sourceTypes: ["cached"],
      maxCallsPerSearch: 12,
    },
    search: (query) => {
      queries.push(query);
      if (query.destinations === "anywhere") return Promise.resolve(outbound);
      const [from] = query.origins;
      return Promise.resolve(
        returns[from ?? ""] ?? okResult("fixture-flights", { segments: [], offers: [] }, metrics),
      );
    },
  };
}

const window = (() => {
  const resolved = resolveTravelWindow(request());
  if (!resolved.ok) throw new Error("expected a window");
  return resolved.window;
})();

const origins = [{ airport: SJJ, distanceKm: 0, isPrimary: true }];

describe("discoverOneWayLegs", () => {
  it("asks one broad outbound question, then a return query per destination", async () => {
    const queries: FlightSearchQuery[] = [];
    const provider = stagedProvider(
      result([oneWay("to-fco", FCO, 2600), oneWay("to-saw", SAW, 2900)]),
      { FCO: result([homeward("fco-home", FCO, 3200)]) },
      queries,
    );

    const discovery = await discoverOneWayLegs(provider, {
      window,
      currency: "EUR",
      travelers: 2,
      origins,
    });

    expect(queries[0]).toMatchObject({ destinations: "anywhere", origins: ["SJJ"] });
    expect(queries[0]?.returnDates).toBeUndefined();
    expect(queries.slice(1).map((query) => query.origins[0])).toEqual(["FCO", "SAW"]);
    expect(queries[1]).toMatchObject({ destinations: ["SJJ"] });
    expect(discovery.status).toBe("ok");
  });

  it("enriches cheapest first, regardless of the order they came back in", async () => {
    const queries: FlightSearchQuery[] = [];
    const provider = stagedProvider(
      // Returned dearest-first; enrichment must not follow that order.
      result([oneWay("to-saw", SAW, 9000), oneWay("to-cia", CIA, 2000), oneWay("to-fco", FCO, 2600)]),
      {},
      queries,
    );
    const discovery = await discoverOneWayLegs(provider, {
      window,
      currency: "EUR",
      travelers: 2,
      origins,
    });
    expect(queries.slice(1).map((query) => query.origins[0])).toEqual(["CIA", "FCO", "SAW"]);
    expect(discovery.enriched.map((entry) => entry.airport.iata)).toEqual(["CIA", "FCO", "SAW"]);
  });

  it("breaks ties on price by IATA code", async () => {
    const queries: FlightSearchQuery[] = [];
    const provider = stagedProvider(
      result([oneWay("to-fco", FCO, 2600), oneWay("to-cia", CIA, 2600)]),
      {},
      queries,
    );
    await discoverOneWayLegs(provider, { window, currency: "EUR", travelers: 2, origins });
    expect(queries.slice(1).map((query) => query.origins[0])).toEqual(["CIA", "FCO"]);
  });

  it("stops at the call budget and records who was skipped and why", async () => {
    const queries: FlightSearchQuery[] = [];
    const provider = stagedProvider(
      result([oneWay("to-cia", CIA, 2000), oneWay("to-fco", FCO, 2600), oneWay("to-saw", SAW, 9000)]),
      {},
      queries,
    );
    // Departures sit in one month (1 call); the return window spans December
    // and January, so each return query costs 2. Budget 5 funds two of them.
    const discovery = await discoverOneWayLegs(provider, {
      window,
      currency: "EUR",
      travelers: 2,
      origins,
      callBudget: 5,
    });
    expect(discovery.callsPlanned).toBeLessThanOrEqual(5);
    expect(discovery.enriched.map((entry) => entry.airport.iata)).toEqual(["CIA", "FCO"]);
    expect(discovery.skipped.map((entry) => entry.airport.iata)).toEqual(["SAW"]);
    expect(discovery.skipped.map((entry) => entry.reason)).toEqual(["call_budget"]);
  });

  it("shares the budget with alternative origins", async () => {
    const queries: FlightSearchQuery[] = [];
    const provider = stagedProvider(result([oneWay("to-fco", FCO, 2600)]), {}, queries);
    const discovery = await discoverOneWayLegs(provider, {
      window,
      currency: "EUR",
      travelers: 2,
      // Two origins double the cost of stage 1.
      origins: [...origins, { airport: TZL, distanceKm: 71, isPrimary: false }],
      callBudget: 12,
    });
    expect(queries[0]?.origins).toEqual(["SJJ", "TZL"]);
    expect(discovery.callsPlanned).toBeLessThanOrEqual(12);
  });

  it("never exceeds the budget, however many destinations come back", async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      oneWay(`to-${String(index)}`, index % 2 === 0 ? FCO : SAW, 1000 + index),
    );
    const discovery = await discoverOneWayLegs(stagedProvider(result(many), {}), {
      window,
      currency: "EUR",
      travelers: 2,
      origins,
    });
    expect(discovery.callsPlanned).toBeLessThanOrEqual(12);
  });

  it("records how many return legs each destination actually had", async () => {
    const provider = stagedProvider(result([oneWay("to-fco", FCO, 2600)]), {
      FCO: result([homeward("fco-home", FCO, 3200)]),
    });
    const discovery = await discoverOneWayLegs(provider, {
      window,
      currency: "EUR",
      travelers: 2,
      origins,
    });
    expect(discovery.enriched[0]).toMatchObject({ returnOffersFound: 1 });
    expect(discovery.returnsByAirport.get(FCO.id)?.offers).toHaveLength(1);
  });

  it("keeps a destination with no way home, so the gap in the data is visible", async () => {
    const provider = stagedProvider(result([oneWay("to-fco", FCO, 2600)]), {});
    const discovery = await discoverOneWayLegs(provider, {
      window,
      currency: "EUR",
      travelers: 2,
      origins,
    });
    expect(discovery.enriched[0]).toMatchObject({ returnOffersFound: 0 });
    expect(discovery.returnsByAirport.get(FCO.id)?.offers ?? []).toHaveLength(0);
  });

  it("fails the discovery when the outbound call fails", async () => {
    const provider = stagedProvider(
      failedResult("fixture-flights", [
        { kind: "unauthorized", message: "no", retryable: false },
      ], metrics),
      {},
    );
    const discovery = await discoverOneWayLegs(provider, {
      window,
      currency: "EUR",
      travelers: 2,
      origins,
    });
    expect(discovery.status).toBe("failed");
    expect(discovery.enriched).toEqual([]);
  });
});
