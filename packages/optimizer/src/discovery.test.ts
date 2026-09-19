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
  MXP,
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

const nothing = () => okResult("fixture-flights", { segments: [], offers: [] }, metrics);

/**
 * A provider that answers each stage by the shape of its query.
 *
 * "Anywhere" from home is stage 1; "anywhere" from a destination is stage 3;
 * anything else is a return query, answered by where it departs from.
 */
function stagedProvider(
  outbound: ProviderResult<TransportSearchResult>,
  returns: Record<string, ProviderResult<TransportSearchResult>>,
  queries: FlightSearchQuery[] = [],
  onward: Record<string, ProviderResult<TransportSearchResult>> = {},
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
      const [from] = query.origins;
      if (query.destinations === "anywhere") {
        if (from === "SJJ") return Promise.resolve(outbound);
        return Promise.resolve(onward[from ?? ""] ?? nothing());
      }
      return Promise.resolve(returns[from ?? ""] ?? nothing());
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

describe("discoverOneWayLegs — onward legs (stage 3)", () => {
  /** Rome to Milan: the middle leg of a multi-city trip. */
  const romeToMilan = (() => {
    const leg = segment({
      id: "fco-mxp",
      origin: FCO,
      destination: MXP,
      departure: "2026-12-30T10:00+01:00",
      arrival: "2026-12-30T11:15+01:00",
    });
    return { segments: [leg], offers: [offer("fco-mxp-fare", [leg.id], 4000)] };
  })();

  it("asks nothing about onward legs unless multi-city was requested", async () => {
    const queries: FlightSearchQuery[] = [];
    const provider = stagedProvider(
      result([oneWay("to-fco", FCO, 2600)]),
      { FCO: result([homeward("fco-home", FCO, 3200)]) },
      queries,
      { FCO: result([romeToMilan]) },
    );
    const discovery = await discoverOneWayLegs(provider, {
      window,
      currency: "EUR",
      travelers: 2,
      origins,
    });
    expect(discovery.onward).toEqual([]);
    expect(discovery.onwardByAirport.size).toBe(0);
    // One stage-1 query and one return query: nothing was asked from Rome.
    expect(queries.filter((query) => query.destinations === "anywhere")).toHaveLength(1);
  });

  it("asks each destination where it can go on to", async () => {
    const queries: FlightSearchQuery[] = [];
    const provider = stagedProvider(
      result([oneWay("to-fco", FCO, 2600)]),
      { FCO: result([homeward("fco-home", FCO, 3200)]) },
      queries,
      { FCO: result([romeToMilan]) },
    );
    const discovery = await discoverOneWayLegs(provider, {
      window,
      currency: "EUR",
      travelers: 2,
      origins,
      multiCity: true,
    });
    expect(discovery.onward).toEqual([{ airport: FCO, onwardOffersFound: 1 }]);
    expect(discovery.onwardByAirport.get(FCO.id)?.offers).toHaveLength(1);
    const onwardQuery = queries.find(
      (query) => query.destinations === "anywhere" && query.origins[0] === "FCO",
    );
    // The onward leg may leave any time the traveler is away, so it is asked
    // against the whole window, not the return range.
    expect(onwardQuery?.departureDates).toEqual(window.outerBounds);
  });

  it("keeps onward queries inside the same budget as everything else", async () => {
    const queries: FlightSearchQuery[] = [];
    const provider = stagedProvider(
      result([oneWay("to-cia", CIA, 2000), oneWay("to-fco", FCO, 2600)]),
      {},
      queries,
      { CIA: result([]), FCO: result([]) },
    );
    const discovery = await discoverOneWayLegs(provider, {
      window,
      currency: "EUR",
      travelers: 2,
      origins,
      callBudget: 7,
      multiCity: true,
    });
    expect(discovery.callsPlanned).toBeLessThanOrEqual(7);
    expect(queries.length).toBeGreaterThan(1);
  });

  it("records an onward query it could not afford, naming the stage", async () => {
    const provider = stagedProvider(
      result([oneWay("to-cia", CIA, 2000), oneWay("to-fco", FCO, 2600)]),
      {},
      [],
      {},
    );
    // Stage 1 costs 1, each return 2: budget 5 funds both returns and no more.
    const discovery = await discoverOneWayLegs(provider, {
      window,
      currency: "EUR",
      travelers: 2,
      origins,
      callBudget: 5,
      multiCity: true,
    });
    expect(discovery.callsPlanned).toBeLessThanOrEqual(5);
    const onwardSkips = discovery.skipped.filter((entry) => entry.stage === "onward");
    expect(onwardSkips.map((entry) => entry.airport.iata)).toEqual(["CIA", "FCO"]);
    expect(onwardSkips.every((entry) => entry.reason === "call_budget")).toBe(true);
  });
});
