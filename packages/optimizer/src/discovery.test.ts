import {
  failedResult,
  okResult,
  parseLocalDate,
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
  airport,
  CIA,
  cityRepository,
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
 * "Anywhere" from home carrying a return range is stage 1b, the matched
 * round-trip question; "anywhere" from home without one is stage 1; "anywhere"
 * from a destination is stage 3; anything else is a return query, answered by
 * where it departs from.
 */
function stagedProvider(
  outbound: ProviderResult<TransportSearchResult>,
  returns: Record<string, ProviderResult<TransportSearchResult>>,
  queries: FlightSearchQuery[] = [],
  onward: Record<string, ProviderResult<TransportSearchResult>> = {},
  roundTrip: ProviderResult<TransportSearchResult> = nothing(),
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
        if (from !== "SJJ") return Promise.resolve(onward[from ?? ""] ?? nothing());
        return Promise.resolve(query.returnDates === undefined ? outbound : roundTrip);
      }
      return Promise.resolve(returns[from ?? ""] ?? nothing());
    },
  };
}

/** A matched round trip: one offer over an outbound and its way home. */
function matched(id: string, to: typeof FCO, amountMinor: number) {
  const out = segment({
    id: `${id}-out`,
    origin: SJJ,
    destination: to,
    departure: "2026-12-27T10:00+01:00",
    arrival: `2026-12-27T13:30${ARRIVAL_OFFSET[to.id] ?? "+01:00"}`,
  });
  const back = segment({
    id: `${id}-back`,
    origin: to,
    destination: SJJ,
    departure: `2027-01-02T18:00${ARRIVAL_OFFSET[to.id] ?? "+01:00"}`,
    arrival: "2027-01-02T19:30+01:00",
  });
  return {
    segments: [out, back],
    offers: [offer(`${id}-fare`, [out.id, back.id], amountMinor)],
  };
}

/** Origins of the stage-2/3 queries, with stages 1 and 1b left out. */
function laterOrigins(queries: readonly FlightSearchQuery[]): (string | undefined)[] {
  return queries
    .slice(1)
    .filter((query) => !(query.destinations === "anywhere" && query.returnDates !== undefined))
    .map((query) => query.origins[0]);
}

/** Origins of the directed way-home queries only. */
function returnOriginsOf(queries: readonly FlightSearchQuery[]): (string | undefined)[] {
  return queries
    .filter((query) => query.destinations !== "anywhere")
    .map((query) => query.origins[0]);
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
      cities: cityRepository,
    });

    expect(queries[0]).toMatchObject({ destinations: "anywhere", origins: ["SJJ"] });
    expect(queries[0]?.returnDates).toBeUndefined();
    // Stage 1b asks the same broad question of the primary origin, with a
    // return range — which is what makes it a round-trip query (ADR 0019).
    expect(queries[1]).toMatchObject({ destinations: "anywhere", origins: ["SJJ"] });
    expect(queries[1]?.returnDates).toBeDefined();
    expect(laterOrigins(queries)).toEqual(["FCO", "SAW"]);
    expect(queries[2]).toMatchObject({ destinations: ["SJJ"] });
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
      cities: cityRepository,
    });
    expect(laterOrigins(queries)).toEqual(["CIA", "FCO", "SAW"]);
    expect(discovery.enriched.map((entry) => entry.airport.iata)).toEqual(["CIA", "FCO", "SAW"]);
  });

  it("breaks ties on price by IATA code", async () => {
    const queries: FlightSearchQuery[] = [];
    const provider = stagedProvider(
      result([oneWay("to-fco", FCO, 2600), oneWay("to-cia", CIA, 2600)]),
      {},
      queries,
    );
    await discoverOneWayLegs(provider, { window, currency: "EUR", travelers: 2, origins, cities: cityRepository });
    expect(laterOrigins(queries)).toEqual(["CIA", "FCO"]);
  });

  it("stops at the call budget and records who was skipped and why", async () => {
    const queries: FlightSearchQuery[] = [];
    const provider = stagedProvider(
      result([oneWay("to-cia", CIA, 2000), oneWay("to-fco", FCO, 2600), oneWay("to-saw", SAW, 9000)]),
      {},
      queries,
    );
    // Departures sit in one month (1 call) and stage 1b costs 2; the return
    // window spans December and January, so each return query costs 2. Budget
    // 7 funds two of them.
    const discovery = await discoverOneWayLegs(provider, {
      window,
      currency: "EUR",
      travelers: 2,
      origins,
      cities: cityRepository,
      callBudget: 7,
    });
    expect(discovery.callsPlanned).toBeLessThanOrEqual(7);
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
      cities: cityRepository,
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
      cities: cityRepository,
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
      cities: cityRepository,
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
      cities: cityRepository,
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
      cities: cityRepository,
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
      cities: cityRepository,
    });
    expect(discovery.onward).toEqual([]);
    expect(discovery.onwardByAirport.size).toBe(0);
    // Stage 1 and stage 1b both ask "anywhere" of home; nothing was asked from
    // Rome, which is what an onward query would have looked like.
    const broad = queries.filter((query) => query.destinations === "anywhere");
    expect(broad).toHaveLength(2);
    expect(broad.every((query) => query.origins[0] === "SJJ")).toBe(true);
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
      cities: cityRepository,
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
      cities: cityRepository,
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
    // Stage 1 costs 1, stage 1b 2, each return 2: budget 7 funds both returns
    // and no more.
    const discovery = await discoverOneWayLegs(provider, {
      window,
      currency: "EUR",
      travelers: 2,
      origins,
      cities: cityRepository,
      callBudget: 7,
      multiCity: true,
    });
    expect(discovery.callsPlanned).toBeLessThanOrEqual(7);
    const onwardSkips = discovery.skipped.filter((entry) => entry.stage === "onward");
    expect(onwardSkips.map((entry) => entry.airport.iata)).toEqual(["CIA", "FCO"]);
    expect(onwardSkips.every((entry) => entry.reason === "call_budget")).toBe(true);
  });
});

describe("discoverOneWayLegs — splitting the budget between stages", () => {
  /** Four destinations, so both queues have more than the budget can fund. */
  const four = result([
    oneWay("to-cia", CIA, 2000),
    oneWay("to-fco", FCO, 2600),
    oneWay("to-mxp", MXP, 3000),
    oneWay("to-saw", SAW, 9000),
  ]);

  /** The stage each query belongs to, in the order they were asked. */
  /** The stage-2 and stage-3 queries, with stages 1 and 1b left out. */
  function stagesOf(queries: readonly FlightSearchQuery[]): string[] {
    return queries
      .slice(1)
      .filter((query) => !(query.destinations === "anywhere" && query.returnDates !== undefined))
      .map((query) => (query.destinations === "anywhere" ? "onward" : "return"));
  }

  it("funds the guaranteed ways home before any onward leg", async () => {
    const queries: FlightSearchQuery[] = [];
    await discoverOneWayLegs(stagedProvider(four, {}, queries), {
      window,
      currency: "EUR",
      travelers: 2,
      origins,
      cities: cityRepository,
      callBudget: 12,
      multiCity: true,
    });
    expect(stagesOf(queries).slice(0, 2)).toEqual(["return", "return"]);
  });

  it("alternates once the floor is covered", async () => {
    const queries: FlightSearchQuery[] = [];
    await discoverOneWayLegs(stagedProvider(four, {}, queries), {
      window,
      currency: "EUR",
      travelers: 2,
      origins,
      cities: cityRepository,
      callBudget: 12,
      multiCity: true,
    });
    // Stage 1 costs 1 and stage 1b 2; each query after them costs 2, so 12
    // funds four in all: two guaranteed ways home, then return, onward.
    expect(stagesOf(queries)).toEqual(["return", "return", "return", "onward"]);
  });

  it("asks nothing onward when multi-city was not requested", async () => {
    const queries: FlightSearchQuery[] = [];
    await discoverOneWayLegs(stagedProvider(four, {}, queries), {
      window,
      currency: "EUR",
      travelers: 2,
      origins,
      cities: cityRepository,
      callBudget: 12,
    });
    expect(stagesOf(queries).every((stage) => stage === "return")).toBe(true);
  });

  it("spends the floor on ways home even when that leaves nothing onward", async () => {
    const queries: FlightSearchQuery[] = [];
    // Three origins over a two-month departure window cost 6 of 12 before
    // anything else, and stage 1b costs 4 more (two departure months × two
    // return months) for 10. Only one way home then fits, and onward discovery
    // never gets a call: the floor binds onward, never the budget.
    const discovery = await discoverOneWayLegs(stagedProvider(four, {}, queries), {
      window: {
        ...window,
        departure: { from: parseLocalDate("2026-12-24"), to: parseLocalDate("2027-01-01") },
      },
      currency: "EUR",
      travelers: 2,
      cities: cityRepository,
      origins: [
        ...origins,
        { airport: TZL, distanceKm: 71, isPrimary: false },
        { airport: CIA, distanceKm: 120, isPrimary: false },
      ],
      callBudget: 12,
      multiCity: true,
    });
    expect(discovery.callsPlanned).toBeLessThanOrEqual(12);
    expect(stagesOf(queries)).toEqual(["return"]);
    // What matters is that no onward query ran before a way home, and that the
    // ones that could not run are recorded rather than dropped.
    expect(stagesOf(queries).includes("onward")).toBe(false);
    expect(discovery.skipped.filter((entry) => entry.stage === "onward").length).toBeGreaterThan(0);
  });

  it("never exceeds the budget with every dimension turned on", async () => {
    const discovery = await discoverOneWayLegs(stagedProvider(four, {}), {
      window,
      currency: "EUR",
      travelers: 2,
      cities: cityRepository,
      origins: [...origins, { airport: TZL, distanceKm: 71, isPrimary: false }],
      callBudget: 12,
      multiCity: true,
    });
    expect(discovery.callsPlanned).toBeLessThanOrEqual(12);
  });

  it("keeps what it found when the budget runs out", async () => {
    const discovery = await discoverOneWayLegs(
      stagedProvider(four, { CIA: result([homeward("cia-home", CIA, 3000)]) }),
      {
        window,
        currency: "EUR",
        travelers: 2,
        origins,
        cities: cityRepository,
        // Stage 1 costs 1 and stage 1b 2, so 5 leaves exactly one way home.
        callBudget: 5,
        multiCity: true,
      },
    );
    expect(discovery.status).not.toBe("failed");
    expect(discovery.enriched.map((entry) => entry.airport.iata)).toEqual(["CIA"]);
    expect(discovery.returnsByAirport.get(CIA.id)?.offers).toHaveLength(1);
  });

  it("gives the same answer twice", async () => {
    const run = async () => {
      const queries: FlightSearchQuery[] = [];
      await discoverOneWayLegs(stagedProvider(four, {}, queries), {
        window,
        currency: "EUR",
        travelers: 2,
        origins,
        cities: cityRepository,
        callBudget: 12,
        multiCity: true,
      });
      return queries.map((query) => `${query.origins.join("+")}->${String(query.destinations)}`);
    };
    expect(await run()).toEqual(await run());
  });
});

describe("discoverOneWayLegs — mixed return candidates", () => {
  /** An onward leg between two destinations, priced as a test input. */
  function onwardLeg(id: string, from: typeof FCO, to: typeof FCO, amountMinor: number) {
    const leg = segment({
      id,
      origin: from,
      destination: to,
      departure: `2026-12-30T10:00${ARRIVAL_OFFSET[from.id] ?? "+01:00"}`,
      // Wide enough to stay positive whichever way it crosses a time zone.
      arrival: `2026-12-30T14:15${ARRIVAL_OFFSET[to.id] ?? "+01:00"}`,
    });
    return { segments: [leg], offers: [offer(`${id}-fare`, [leg.id], amountMinor)] };
  }

  /** Which airport each way-home query departed from, in order. */
  function returnOrigins(queries: readonly FlightSearchQuery[]): (string | undefined)[] {
    return queries
      .filter((query) => query.destinations !== "anywhere")
      .map((query) => query.origins[0]);
  }

  it("spends a way-home query on a city stage 1 never found", async () => {
    const queries: FlightSearchQuery[] = [];
    const discovery = await discoverOneWayLegs(
      stagedProvider(
        result([oneWay("to-cia", CIA, 2000)]),
        {},
        queries,
        // Milan is reachable only onward from Rome, never from home.
        { CIA: result([onwardLeg("cia-mxp", CIA, MXP, 1000)]) },
      ),
      { window, currency: "EUR", travelers: 2, origins, cities: cityRepository, multiCity: true },
    );
    expect(returnOrigins(queries)).toContain("MXP");
    const milan = discovery.enriched.find((entry) => entry.airport.iata === "MXP");
    expect(milan?.source).toBe("onward");
    expect(milan?.via.map((stop) => stop.iata)).toEqual(["CIA", "MXP"]);
    expect(milan?.reachCostMinor).toBe(3000);
    expect(milan?.city?.name).toBe("Milan");
  });

  it("lets a cheap second city take the query a dear stage-1 destination wanted", async () => {
    const queries: FlightSearchQuery[] = [];
    const vienna = airport("VIE", "Vienna");
    const discovery = await discoverOneWayLegs(
      stagedProvider(
        result([
          oneWay("to-cia", CIA, 2000),
          oneWay("to-fco", FCO, 2100),
          oneWay("to-saw", SAW, 9000),
          oneWay("to-vie", vienna, 9500),
        ]),
        {},
        queries,
        // Milan through Rome: 20.00 + 5.00, far under Vienna's 95.00.
        { CIA: result([onwardLeg("cia-mxp", CIA, MXP, 500)]) },
      ),
      {
        window,
        currency: "EUR",
        travelers: 2,
        origins,
        cities: cityRepository,
        // Stage 1b costs 2, so 14 leaves the allocator the same room as 12 did.
        callBudget: 14,
        multiCity: true,
      },
    );
    // Milan did not exist when the run began; once Rome's onward query found
    // it, its 25.00 reach cost beat Vienna to the last way-home query.
    const order = returnOrigins(queries);
    expect(order).toContain("MXP");
    expect(order).not.toContain("VIE");
    expect(discovery.skipped.find((entry) => entry.airport.iata === "VIE")).toMatchObject({
      stage: "return",
      reason: "call_budget",
      source: "stage_1",
    });
  });

  it("ignores the unknown way-home fare when ranking, because that is the question", async () => {
    const ask = async (romeReturn: number, istanbulReturn: number) => {
      const queries: FlightSearchQuery[] = [];
      await discoverOneWayLegs(
        stagedProvider(
          result([oneWay("to-cia", CIA, 2000), oneWay("to-saw", SAW, 2100), oneWay("to-fco", FCO, 9000)]),
          {
            CIA: result([homeward("cia-home", CIA, romeReturn)]),
            SAW: result([homeward("saw-home", SAW, istanbulReturn)]),
          },
          queries,
        ),
        {
          window,
          currency: "EUR",
          travelers: 2,
          origins,
          cities: cityRepository,
          callBudget: 12,
        },
      );
      return returnOrigins(queries);
    };
    // Wildly different return fares, identical reach costs: same order.
    expect(await ask(100, 90000)).toEqual(await ask(90000, 100));
  });

  it("queries a return airport once however many paths reach it", async () => {
    const queries: FlightSearchQuery[] = [];
    await discoverOneWayLegs(
      stagedProvider(
        result([oneWay("to-cia", CIA, 2000), oneWay("to-saw", SAW, 2100)]),
        {},
        queries,
        // Both Rome and Istanbul can reach Milan.
        {
          CIA: result([onwardLeg("cia-mxp", CIA, MXP, 1000)]),
          SAW: result([onwardLeg("saw-mxp", SAW, MXP, 800)]),
        },
      ),
      {
        window,
        currency: "EUR",
        travelers: 2,
        origins,
        cities: cityRepository,
        callBudget: 12,
        multiCity: true,
      },
    );
    const toMilan = returnOrigins(queries).filter((code) => code === "MXP");
    expect(toMilan).toHaveLength(1);
  });

  it("keeps both airports of one city, each as its own query", async () => {
    const queries: FlightSearchQuery[] = [];
    const discovery = await discoverOneWayLegs(
      stagedProvider(
        // Fiumicino from home; Ciampino only onward from Istanbul.
        result([oneWay("to-fco", FCO, 2000), oneWay("to-saw", SAW, 2100)]),
        {},
        queries,
        { SAW: result([onwardLeg("saw-cia", SAW, CIA, 500)]) },
      ),
      {
        window,
        currency: "EUR",
        travelers: 2,
        origins,
        cities: cityRepository,
        // Stage 1b costs 2, so 14 leaves the allocator the same room as 12 did.
        callBudget: 14,
        multiCity: true,
      },
    );
    const origins2 = returnOrigins(queries);
    expect(origins2).toContain("FCO");
    expect(origins2).toContain("CIA");
    // Two queries, one destination city: grouping is presentation, not identity.
    const rome = discovery.enriched.filter((entry) => entry.city?.iata === "ROM");
    expect(rome.map((entry) => entry.airport.iata).sort()).toEqual(["CIA", "FCO"]);
  });

  it("still guarantees two ways home before any onward query", async () => {
    const queries: FlightSearchQuery[] = [];
    await discoverOneWayLegs(
      stagedProvider(
        result([oneWay("to-cia", CIA, 2000), oneWay("to-fco", FCO, 2100), oneWay("to-saw", SAW, 2200)]),
        {},
        queries,
        { CIA: result([onwardLeg("cia-mxp", CIA, MXP, 100)]) },
      ),
      {
        window,
        currency: "EUR",
        travelers: 2,
        origins,
        cities: cityRepository,
        // Stage 1b costs 2, so 14 leaves the allocator the same room as 12 did.
        callBudget: 14,
        multiCity: true,
      },
    );
    const stages = queries
      .slice(1)
      .filter((query) => !(query.destinations === "anywhere" && query.returnDates !== undefined))
      .map((query) => (query.destinations === "anywhere" ? "onward" : "return"));
    expect(stages.slice(0, 2)).toEqual(["return", "return"]);
  });

  it("records a second city the budget could not reach, naming how it was found", async () => {
    const discovery = await discoverOneWayLegs(
      stagedProvider(
        result([oneWay("to-cia", CIA, 2000)]),
        {},
        [],
        { CIA: result([onwardLeg("cia-mxp", CIA, MXP, 1000)]) },
      ),
      {
        window,
        currency: "EUR",
        travelers: 2,
        origins,
        cities: cityRepository,
        // Stage 1 costs 1, stage 1b 2, Rome's way home 2, Rome's onward 2:
        // 7 of 7 spent, so Milan is discovered and then cannot be asked about.
        callBudget: 7,
        multiCity: true,
      },
    );
    expect(discovery.callsPlanned).toBeLessThanOrEqual(7);
    const milan = discovery.skipped.find((entry) => entry.airport.iata === "MXP");
    expect(milan).toMatchObject({ stage: "return", reason: "call_budget", source: "onward" });
    expect(milan?.via.map((stop) => stop.iata)).toEqual(["CIA", "MXP"]);
  });

  it("never exceeds the budget once second cities join the queue", async () => {
    const discovery = await discoverOneWayLegs(
      stagedProvider(
        result([oneWay("to-cia", CIA, 2000), oneWay("to-fco", FCO, 2100), oneWay("to-saw", SAW, 2200)]),
        {},
        [],
        {
          CIA: result([onwardLeg("cia-mxp", CIA, MXP, 100)]),
          FCO: result([onwardLeg("fco-saw", FCO, SAW, 150)]),
        },
      ),
      {
        window,
        currency: "EUR",
        travelers: 2,
        origins: [...origins, { airport: TZL, distanceKm: 71, isPrimary: false }],
        cities: cityRepository,
        callBudget: 12,
        multiCity: true,
      },
    );
    expect(discovery.callsPlanned).toBeLessThanOrEqual(12);
  });
});

describe("discoverOneWayLegs — admitting second cities", () => {
  it("admits only the onward legs composition will pair", async () => {
    // Ten onward destinations from Rome, priced 1.00 to 10.00. Composition
    // keeps the cheapest MAX_OFFERS_PER_AIRPORT of them, so a way-home query
    // must never be spent on one of the others (ADR 0015 §7).
    const code = (prefix: string, index: number) =>
      `${prefix}A${String.fromCharCode(65 + index)}`;
    const reachable = Array.from({ length: 10 }, (_, index) =>
      airport(code("X", index), `City ${String(index)}`),
    );
    const onwardResults = reachable.map((to, index) => {
      const leg = segment({
        id: `cia-${code("X", index)}`,
        origin: CIA,
        destination: to,
        departure: "2026-12-30T10:00+01:00",
        arrival: "2026-12-30T14:15+01:00",
      });
      return {
        segments: [leg],
        offers: [offer(`cia-${code("X", index)}-fare`, [leg.id], 100 * (index + 1))],
      };
    });

    const queries: FlightSearchQuery[] = [];
    await discoverOneWayLegs(
      stagedProvider(
        result([oneWay("to-cia", CIA, 2000)]),
        {},
        queries,
        { CIA: result(onwardResults) },
      ),
      {
        window,
        currency: "EUR",
        travelers: 2,
        origins,
        cities: cityRepository,
        callBudget: 40,
        multiCity: true,
      },
    );
    const asked = new Set(
      queries
        .filter((query) => query.destinations !== "anywhere")
        .map((query) => query.origins[0]),
    );
    // The two dearest fall outside the cap of 8 and are never asked about.
    expect(asked.has(code("X", 7))).toBe(true);
    expect(asked.has(code("X", 8))).toBe(false);
    expect(asked.has(code("X", 9))).toBe(false);
  });

  it("honours a narrower admission cap", async () => {
    const code = (index: number) => `YA${String.fromCharCode(65 + index)}`;
    const reachable = [0, 1, 2].map((index) => airport(code(index), `Y ${String(index)}`));
    const onwardResults = reachable.map((to, index) => {
      const leg = segment({
        id: `cia-${code(index)}`,
        origin: CIA,
        destination: to,
        departure: "2026-12-30T10:00+01:00",
        arrival: "2026-12-30T14:15+01:00",
      });
      return {
        segments: [leg],
        offers: [offer(`cia-${code(index)}-fare`, [leg.id], 100 * (index + 1))],
      };
    });
    const queries: FlightSearchQuery[] = [];
    await discoverOneWayLegs(
      stagedProvider(result([oneWay("to-cia", CIA, 2000)]), {}, queries, {
        CIA: result(onwardResults),
      }),
      {
        window,
        currency: "EUR",
        travelers: 2,
        origins,
        cities: cityRepository,
        callBudget: 40,
        multiCity: true,
        maxOnwardLegsPerAirport: 1,
      },
    );
    const asked = new Set(
      queries.filter((q) => q.destinations !== "anywhere").map((q) => q.origins[0]),
    );
    expect(asked.has(code(0))).toBe(true);
    expect(asked.has(code(1))).toBe(false);
  });
});

describe("discoverOneWayLegs — one account per airport", () => {
  it("does not report a beyond-shortlist destination as capped once it was queried", async () => {
    // Istanbul ranks third, outside a shortlist of two, so stage 2 would
    // normally never consider it. An onward leg from Rome reaches it, which
    // puts it in the pool on its own merits — and then it must be reported as
    // queried, not as a destination a cap kept us from.
    const onward = segment({
      id: "cia-saw",
      origin: CIA,
      destination: SAW,
      departure: "2026-12-30T10:00+01:00",
      arrival: "2026-12-30T16:15+03:00",
    });
    const discovery = await discoverOneWayLegs(
      stagedProvider(
        result([
          oneWay("to-cia", CIA, 2000),
          oneWay("to-fco", FCO, 2100),
          oneWay("to-saw", SAW, 9000),
        ]),
        {},
        [],
        { CIA: result([{ segments: [onward], offers: [offer("cia-saw-fare", [onward.id], 500)] }]) },
      ),
      {
        window,
        currency: "EUR",
        travelers: 2,
        origins,
        cities: cityRepository,
        callBudget: 20,
        maxEnrichedDestinations: 2,
        multiCity: true,
      },
    );

    const queried = discovery.enriched.map((entry) => entry.airport.iata);
    expect(queried).toContain("SAW");
    // Exactly one account of Istanbul: queried, and not also skipped.
    expect(discovery.skipped.filter((entry) => entry.airport.iata === "SAW")).toEqual([]);
    const everyAirport = [...queried, ...discovery.skipped.map((entry) => entry.airport.iata)];
    expect(new Set(everyAirport).size).toBe(everyAirport.length);
  });

  it("still reports a beyond-shortlist destination nothing reached", async () => {
    const discovery = await discoverOneWayLegs(
      stagedProvider(
        result([
          oneWay("to-cia", CIA, 2000),
          oneWay("to-fco", FCO, 2100),
          oneWay("to-saw", SAW, 9000),
        ]),
        {},
      ),
      {
        window,
        currency: "EUR",
        travelers: 2,
        origins,
        cities: cityRepository,
        callBudget: 20,
        maxEnrichedDestinations: 2,
      },
    );
    expect(discovery.skipped.find((entry) => entry.airport.iata === "SAW")).toMatchObject({
      reason: "cap",
    });
  });
});

describe("discoverOneWayLegs — funnel accounting", () => {
  const onwardFrom = (from: typeof CIA, to: typeof CIA, id: string, minor: number) => {
    const leg = segment({
      id,
      origin: from,
      destination: to,
      departure: `2026-12-30T10:00${ARRIVAL_OFFSET[from.id] ?? "+01:00"}`,
      arrival: `2026-12-30T16:15${ARRIVAL_OFFSET[to.id] ?? "+01:00"}`,
    });
    return { segments: [leg], offers: [offer(`${id}-fare`, [leg.id], minor)] };
  };

  async function run(overrides: Record<string, unknown> = {}) {
    return discoverOneWayLegs(
      stagedProvider(
        result([
          oneWay("to-cia", CIA, 2000),
          oneWay("to-fco", FCO, 2100),
          oneWay("to-saw", SAW, 9000),
        ]),
        { CIA: result([homeward("cia-home", CIA, 3000)]) },
        [],
        { CIA: result([onwardFrom(CIA, MXP, "cia-mxp", 500)]) },
      ),
      {
        window,
        currency: "EUR",
        travelers: 2,
        origins,
        cities: cityRepository,
        callBudget: 20,
        multiCity: true,
        ...overrides,
      },
    );
  }

  it("counts what stage 1 found and what it admitted", async () => {
    const { funnel } = await run({ maxEnrichedDestinations: 2 });
    expect(funnel.destinationsDiscovered).toBe(3);
    expect(funnel.destinationsAdmitted).toBe(2);
    expect(funnel.destinationsAdmitted).toBeLessThanOrEqual(funnel.destinationsDiscovered);
  });

  it("counts onward queries made and the second cities they reached", async () => {
    const { funnel } = await run();
    expect(funnel.onwardQueriesExecuted).toBeGreaterThan(0);
    expect(funnel.secondCityAirportsDiscovered).toBe(1);
    expect(funnel.secondCityAirportsAdmitted).toBeLessThanOrEqual(
      funnel.secondCityAirportsDiscovered,
    );
  });

  it("never admits more second cities than it discovered", async () => {
    const { funnel } = await run({ maxOnwardLegsPerAirport: 0 });
    expect(funnel.secondCityAirportsAdmitted).toBe(0);
    expect(funnel.secondCityAirportsDiscovered).toBe(1);
  });

  it("splits way-home queries and fares by how the place was found", async () => {
    const discovery = await run();
    const { funnel } = discovery;
    expect(funnel.returnQueriesFromStageOne + funnel.returnQueriesFromSecondCity).toBe(
      discovery.enriched.length,
    );
    expect(funnel.returnFaresFoundFromStageOne).toBeLessThanOrEqual(
      funnel.returnQueriesFromStageOne,
    );
    expect(funnel.returnFaresFoundFromSecondCity).toBeLessThanOrEqual(
      funnel.returnQueriesFromSecondCity,
    );
    // Rome is the only place with a way home in this fixture.
    expect(funnel.returnFaresFoundFromStageOne).toBe(1);
  });

  it("gives every place exactly one account: queried or not, never both", async () => {
    const discovery = await run({ maxEnrichedDestinations: 2 });
    const queried = discovery.enriched.map((entry) => entry.airport.id);
    const notQueried = discovery.skipped.map((entry) => entry.airport.id);
    const all = [...queried, ...notQueried];
    expect(new Set(all).size).toBe(all.length);
    expect(queried.filter((id) => notQueried.includes(id))).toEqual([]);
  });

  it("holds that account when the budget cuts the run short", async () => {
    const discovery = await run({ callBudget: 3, maxEnrichedDestinations: 2 });
    const queried = discovery.enriched.map((entry) => entry.airport.id);
    const notQueried = discovery.skipped
      .filter((entry) => entry.stage === "return")
      .map((entry) => entry.airport.id);
    const all = [...queried, ...notQueried];
    expect(new Set(all).size).toBe(all.length);
    expect(discovery.funnel.returnQueriesFromStageOne).toBe(queried.length);
  });

  it("counts nothing when the outbound call fails", async () => {
    const discovery = await discoverOneWayLegs(
      stagedProvider(
        failedResult("fixture-flights", [{ kind: "unauthorized", message: "no", retryable: false }], metrics),
        {},
      ),
      { window, currency: "EUR", travelers: 2, origins, cities: cityRepository },
    );
    expect(discovery.funnel).toMatchObject({
      destinationsDiscovered: 0,
      destinationsAdmitted: 0,
      onwardQueriesExecuted: 0,
      returnQueriesFromStageOne: 0,
    });
  });
});

describe("discoverOneWayLegs — matched round trips (stage 1b)", () => {
  it("does not ask for a way home from a destination a matched fare covers", async () => {
    const queries: FlightSearchQuery[] = [];
    const discovery = await discoverOneWayLegs(
      stagedProvider(
        result([oneWay("to-cia", CIA, 2000), oneWay("to-fco", FCO, 2600)]),
        {},
        queries,
        {},
        result([matched("rt-cia", CIA, 9000)]),
      ),
      { window, currency: "EUR", travelers: 2, origins, cities: cityRepository },
    );

    expect(discovery.matchedReturnAirports.has(CIA.id)).toBe(true);
    // Rome still needs asking; Ciampino does not, because the question has an
    // answer already (ADR 0019).
    expect(returnOriginsOf(queries)).toEqual(["FCO"]);
    const skipped = discovery.skipped.find((entry) => entry.airport.iata === "CIA");
    expect(skipped).toMatchObject({ stage: "return", reason: "matched_round_trip" });
    expect(discovery.funnel.returnQueriesSavedByMatch).toBe(1);
  });

  it("still asks for a way home from a destination no matched fare covers", async () => {
    const queries: FlightSearchQuery[] = [];
    const discovery = await discoverOneWayLegs(
      stagedProvider(
        result([oneWay("to-cia", CIA, 2000), oneWay("to-fco", FCO, 2600)]),
        { FCO: result([homeward("fco-home", FCO, 3200)]) },
        queries,
        {},
        result([matched("rt-cia", CIA, 9000)]),
      ),
      { window, currency: "EUR", travelers: 2, origins, cities: cityRepository },
    );
    expect(returnOriginsOf(queries)).toEqual(["FCO"]);
    expect(discovery.returnsByAirport.get(FCO.id)?.offers).toHaveLength(1);
  });

  it("carries the matched fares through as offers over two segments", async () => {
    const discovery = await discoverOneWayLegs(
      stagedProvider(result([]), {}, [], {}, result([matched("rt-cia", CIA, 9000)])),
      { window, currency: "EUR", travelers: 2, origins, cities: cityRepository },
    );
    expect(discovery.matchedOffers).toHaveLength(1);
    expect(discovery.matchedOffers[0]?.segmentIds).toHaveLength(2);
    expect(discovery.matchedSegments).toHaveLength(2);
    expect(discovery.funnel.matchedRoundTripOffers).toBe(1);
    expect(discovery.funnel.matchedRoundTripDestinations).toBe(1);
  });

  it("charges a return window spanning two months two calls, not one", async () => {
    // The fixture window departs inside December and returns across December
    // and January, so the round-trip question costs one call per month pair.
    const discovery = await discoverOneWayLegs(
      stagedProvider(result([]), {}, [], {}, nothing()),
      { window, currency: "EUR", travelers: 2, origins, cities: cityRepository },
    );
    expect(discovery.funnel.matchedRoundTripCalls).toBe(2);
  });

  it("asks nothing round-trip for a one-way trip, which has no way home", async () => {
    const oneWayWindow = resolveTravelWindow(
      request({
        returnDate: undefined,
        endDate: "2027-01-03",
        minNights: undefined,
        maxNights: undefined,
      }),
    );
    if (!oneWayWindow.ok) throw new Error("expected a window");
    const queries: FlightSearchQuery[] = [];
    const discovery = await discoverOneWayLegs(
      stagedProvider(result([oneWay("to-cia", CIA, 2000)]), {}, queries),
      { window: oneWayWindow.window, currency: "EUR", travelers: 2, origins, cities: cityRepository },
    );
    expect(discovery.funnel.matchedRoundTripCalls).toBe(0);
    expect(queries.every((query) => query.returnDates === undefined)).toBe(true);
  });

  it("stays inside the global call budget with every stage turned on", async () => {
    const discovery = await discoverOneWayLegs(
      stagedProvider(
        result([oneWay("to-cia", CIA, 2000), oneWay("to-fco", FCO, 2600), oneWay("to-saw", SAW, 9000)]),
        {},
        [],
        {},
        result([matched("rt-cia", CIA, 9000)]),
      ),
      {
        window,
        currency: "EUR",
        travelers: 2,
        cities: cityRepository,
        origins: [...origins, { airport: TZL, distanceKm: 71, isPrimary: false }],
        callBudget: 12,
        multiCity: true,
      },
    );
    expect(discovery.callsPlanned).toBeLessThanOrEqual(12);
  });
});
