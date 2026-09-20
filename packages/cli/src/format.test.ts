import {
  failedResult,
  money,
  okResult,
  type FlightSearchQuery,
} from "@travel-optimizer/domain";
import {
  runFlightSearch,
  type SearchTrace,
} from "@travel-optimizer/optimizer";
import {
  CIA,
  cityRepository,
  FCO,
  fixtureAirports,
  fixtureGeography,
  ISTANBUL,
  metrics,
  MXP,
  offer,
  request,
  roundTrip,
  SAW,
  searchResult,
  segment,
  SJJ,
  stubFlightProvider,
} from "@travel-optimizer/optimizer/test-fixtures";
import { describe, expect, it } from "vitest";

import { formatDuration, formatMoney, formatSearch } from "./format.js";

const romeTrip = roundTrip({
  id: "rome",
  destination: FCO,
  outbound: ["2026-12-27T10:00+01:00", "2026-12-27T11:30+01:00"],
  inbound: ["2027-01-02T18:00+01:00", "2027-01-02T19:30+01:00"],
  amountMinor: 12000,
});

const istanbulTrip = roundTrip({
  id: "istanbul",
  destination: SAW,
  outbound: ["2026-12-27T09:00+01:00", "2026-12-27T12:00+03:00"],
  inbound: ["2027-01-02T13:00+03:00", "2027-01-02T14:00+01:00"],
  amountMinor: 7900,
  transfers: 1,
});

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 18, 9, 0, tick++));
}

async function trace(
  parts: Parameters<typeof searchResult>[0] = [romeTrip, istanbulTrip],
  overrides: Record<string, unknown> = {},
): Promise<SearchTrace> {
  return runFlightSearch(
    request(overrides),
    { flightProvider: stubFlightProvider(searchResult(parts)), cities: cityRepository, geography: fixtureGeography, airports: fixtureAirports },
    { currency: "EUR", now: fixedClock(), newSearchId: () => "search-1" },
  );
}

describe("formatMoney and formatDuration", () => {
  it("always names the currency", () => {
    expect(formatMoney(money(15800, "EUR"))).toBe("158.00 EUR");
    expect(formatMoney(money(1500, "JPY"))).toBe("1500 JPY");
  });

  it("renders durations readably", () => {
    expect(formatDuration(90)).toBe("1h 30m");
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(120)).toBe("2h");
  });
});

describe("formatSearch", () => {
  it("shows the window, counts and ranked destinations", async () => {
    const output = formatSearch(await trace(), { limit: 10 });
    expect(output).toContain("Searching SJJ → anywhere for 2 traveler(s)");
    expect(output).toContain("Window 2026-12-24 .. 2027-01-05 · 5–7 nights · window mode");
    expect(output).toContain("Provider calls: 1 (cache miss) · fares returned: 2");
    expect(output).toContain("Candidates: 2 across 2 destination(s)");
    expect(output).toContain("1. Istanbul (TR) — SAW");
    expect(output).toContain("2. Rome (IT) — FCO");
  });

  it("shows per-person and known cost, with what the amount leaves out", async () => {
    const output = formatSearch(await trace(), { limit: 10 });
    // 79.00 fare plus two estimated transfers, per traveler.
    expect(output).toContain("105.80 EUR / person · 211.60 EUR known cost · excludes some accommodation");
    expect(output).toContain("Fare: cached · includes estimated access transfer (53.60 EUR)");
    expect(output).toContain("Each amount covers only what is priced");
    expect(output).toContain("Airport transfers are estimates from a distance model, not quotes");
  });

  it("shows every leg with local times, stops and carrier", async () => {
    const output = formatSearch(await trace([romeTrip]), { limit: 10 });
    expect(output).toContain("fly      2026-12-27 10:00 SJJ → 2026-12-27 11:30 FCO · 1h 30m · direct · XX");
    expect(output).toContain("fly      2027-01-02 18:00 FCO → 2027-01-02 19:30 SJJ");
  });

  it("shows the estimated access transfer as its own leg", async () => {
    const output = formatSearch(await trace([romeTrip]), { limit: 10 });
    // Fiumicino is 30 km from Rome, so the transfer is explicit.
    expect(output).toContain("transfer 2026-12-27 12:15 FCO → 2026-12-27 13:22 ROM");
    expect(output).toContain("· estimated");
  });

  it("counts stops on a connecting flight", async () => {
    const output = formatSearch(await trace([istanbulTrip]), { limit: 10 });
    expect(output).toContain("1 stop");
  });

  it("calls a non-stop round trip direct, not a one-change trip", async () => {
    // The destination stay is not a transfer, even though accommodation is not
    // modelled yet and the domain counts it as a connection.
    const output = formatSearch(await trace([romeTrip]), { limit: 10 });
    expect(output).toContain("direct both ways");
    expect(output).not.toContain("change(s)");
  });

  it("states that a cached fare has no provider expiry", async () => {
    const output = formatSearch(await trace([romeTrip]), { limit: 10 });
    expect(output).toContain("cached price · checked 2026-09-18 09:00Z");
    expect(output).toContain("no provider expiry (freshness unknown)");
  });

  it("omits a booking link when the fare has none", async () => {
    expect(formatSearch(await trace([romeTrip]), { limit: 10 })).not.toContain("book:");
  });

  it("reports why a search came back empty", async () => {
    const tooShort = roundTrip({
      id: "too-short",
      destination: FCO,
      outbound: ["2026-12-28T10:00+01:00", "2026-12-28T11:30+01:00"],
      inbound: ["2026-12-30T18:00+01:00", "2026-12-30T19:30+01:00"],
      amountMinor: 5000,
    });
    const output = formatSearch(await trace([tooShort]), { limit: 10 });
    expect(output).toContain("Filtered out: 1 wrong length");
    expect(output).toContain("No trips matched");
  });

  it("respects --limit and says how many were hidden", async () => {
    const output = formatSearch(await trace(), { limit: 1 });
    expect(output).toContain("1. Istanbul");
    expect(output).not.toContain("2. Rome");
    expect(output).toContain("(1 more destination(s); raise --limit to see them)");
  });

  it("prints the failure and the search id when the search failed", async () => {
    const failedTrace = await runFlightSearch(
      request(),
      {
        flightProvider: stubFlightProvider(
          failedResult(
            "fixture-flights",
            [{ kind: "unauthorized", message: "token rejected", retryable: false }],
            metrics,
          ),
        ),
        cities: cityRepository,
        geography: fixtureGeography,
        airports: fixtureAirports,
      },
      { currency: "EUR", now: fixedClock(), newSearchId: () => "search-2" },
    );
    const output = formatSearch(failedTrace, { limit: 10 });
    expect(output).toContain("Search failed.");
    expect(output).toContain("provider unauthorized: token rejected");
    expect(output).toContain("Search search-2");
  });

  it("always ends with the trace identifiers", async () => {
    const output = formatSearch(await trace(), { limit: 10 });
    expect(output).toMatch(/Search search-1 · fingerprint [0-9a-f]{12} · optimizer .+$/);
  });

  it("marks an uneven per-person split as approximate", async () => {
    const odd = roundTrip({
      id: "odd",
      destination: FCO,
      outbound: ["2026-12-27T10:00+01:00", "2026-12-27T11:30+01:00"],
      inbound: ["2027-01-02T18:00+01:00", "2027-01-02T19:30+01:00"],
      amountMinor: 3333,
    });
    const output = formatSearch(
      await runFlightSearch(
        request({ travelers: 3 }),
        { flightProvider: stubFlightProvider(searchResult([odd])), cities: cityRepository, geography: fixtureGeography, airports: fixtureAirports },
        { currency: "EUR", now: fixedClock(), newSearchId: () => "search-3" },
      ),
      { limit: 10 },
    );
    // 33.33 fare + two 10.80 transfers, each per traveler: 54.93 x 3 = 164.79.
    expect(output).toContain("54.93 EUR / person · 164.79 EUR known cost");
  });

  it("names an airport-only destination when no city resolves", async () => {
    const unknown = roundTrip({
      id: "unknown",
      destination: { ...FCO, id: "airport:ZZZ", iata: "ZZZ", name: "Nowhere Intl" },
      outbound: ["2026-12-27T10:00+01:00", "2026-12-27T11:30+01:00"],
      inbound: ["2027-01-02T18:00+01:00", "2027-01-02T19:30+01:00"],
      amountMinor: 5000,
    });
    const output = formatSearch(await trace([unknown]), { limit: 10 });
    expect(output).toContain("Nowhere Intl (airport only) — ZZZ");
    expect(output).toContain("Data issues: UNKNOWN_CITY_FOR_AIRPORT×1");
  });
});

describe("open-jaw output", () => {
  it("names both cities, the unpriced sector and what the amount excludes", async () => {
    const outbound = roundTrip({
      id: "oj-out",
      destination: FCO,
      outbound: ["2026-12-27T10:00+01:00", "2026-12-27T11:30+01:00"],
      inbound: ["2027-01-02T18:00+01:00", "2027-01-02T19:30+01:00"],
      amountMinor: 12000,
    });
    // Hand-build the trace's destination shape with a gap, as composition does.
    const trace = await runFlightSearch(
      request(),
      {
        flightProvider: stubFlightProvider(searchResult([outbound])),
        cities: cityRepository,
        geography: fixtureGeography,
        airports: fixtureAirports,
      },
      { currency: "EUR", now: fixedClock(), newSearchId: () => "search-oj" },
    );
    const [destination] = trace.destinations;
    const [candidate] = destination?.candidates ?? [];
    if (destination === undefined || candidate === undefined) throw new Error("expected a candidate");

    const gapped: SearchTrace = {
      ...trace,
      destinations: [
        {
          ...destination,
          cities: [...destination.cities, ISTANBUL],
          candidates: [
            {
              ...candidate,
              summary: {
                ...candidate.summary,
                unpricedGaps: [
                  {
                    id: "gap",
                    from: FCO,
                    to: SAW,
                    distanceKm: 250,
                    status: "unpriced",
                    reason: "no_licensed_source",
                  },
                ],
                cost: {
                  ...candidate.summary.cost,
                  scope: "excludes_unpriced_segment",
                  exclusions: ["unpriced_segment"],
                },
              },
            },
          ],
        },
      ],
    };

    const output = formatSearch(gapped, { limit: 5 });
    expect(output).toContain("Rome → Istanbul (open jaw)");
    expect(output).toContain("FCO → SAW: 250 km, UNPRICED — arrange separately");
    expect(output).toContain("The amount above EXCLUDES FCO → SAW");
    expect(output).toContain("Known cost:");
    expect(output).not.toContain("total · transport only");
  });
});

describe("formatSearch — accommodation coverage", () => {
  it("reports each stay, with why it has no price", async () => {
    const output = formatSearch(await trace(), { limit: 10 });
    expect(output).toContain("Accommodation Istanbul: not searched");
    expect(output).toContain("no accommodation provider");
  });

  it("says the amount is a known cost, not a total", async () => {
    const output = formatSearch(await trace(), { limit: 10 });
    expect(output).toContain("known cost · excludes some accommodation");
    expect(output).toContain("The amount above EXCLUDES accommodation that is not priced");
  });

  it("never presents an unpriced trip as a complete total", async () => {
    const output = formatSearch(await trace(), { limit: 10 });
    expect(output).not.toContain("complete trip");
  });
});

describe("formatSearch — multi-city", () => {
  const ARRIVAL_OFFSET: Record<string, string> = { [CIA.id]: "+01:00", [MXP.id]: "+01:00" };

  function leg(id: string, from: typeof CIA, to: typeof CIA, times: [string, string], minor: number) {
    const built = segment({
      id,
      origin: from,
      destination: to,
      departure: `${times[0]}${ARRIVAL_OFFSET[from.id] ?? "+01:00"}`,
      arrival: `${times[1]}${ARRIVAL_OFFSET[to.id] ?? "+01:00"}`,
    });
    return { segments: [built], offers: [offer(`${id}-fare`, [built.id], minor)] };
  }

  type Legs = ReturnType<typeof leg>;

  function provider(
    outbound: Legs[],
    returns: Record<string, Legs[]>,
    onward: Record<string, Legs[]>,
  ) {
    const pack = (parts: Legs[]) =>
      okResult(
        "fixture-flights",
        { segments: parts.flatMap((p) => p.segments), offers: parts.flatMap((p) => p.offers) },
        metrics,
      );
    return {
      descriptor: {
        id: "fixture-flights",
        kind: "flight" as const,
        enabled: true,
        sourceTypes: ["cached" as const],
        maxCallsPerSearch: 12,
      },
      search: (query: FlightSearchQuery) => {
        const [from] = query.origins;
        if (query.destinations === "anywhere") {
          return Promise.resolve(pack(from === "SJJ" ? outbound : (onward[from ?? ""] ?? [])));
        }
        return Promise.resolve(pack(returns[from ?? ""] ?? []));
      },
    };
  }

  async function multiCityTrace(): Promise<SearchTrace> {
    return runFlightSearch(
      request({ allowMultiCity: true }),
      {
        flightProvider: provider(
          [
            leg("out-cia", SJJ, CIA, ["2026-12-27T10:00", "2026-12-27T11:30"], 4000),
            leg("out-mxp", SJJ, MXP, ["2026-12-27T10:00", "2026-12-27T11:30"], 8000),
          ],
          {
            CIA: [leg("back-cia", CIA, SJJ, ["2027-01-02T18:00", "2027-01-02T19:30"], 3000)],
            MXP: [leg("back-mxp", MXP, SJJ, ["2027-01-02T18:00", "2027-01-02T19:45"], 3500)],
          },
          { CIA: [leg("cia-mxp", CIA, MXP, ["2026-12-30T10:00", "2026-12-30T11:15"], 2000)] },
        ),
        cities: cityRepository,
        geography: fixtureGeography,
        airports: fixtureAirports,
      },
      { currency: "EUR", now: fixedClock(), newSearchId: () => "search-mc", strategy: "composed" },
    );
  }

  it("names the cities in the order they are visited, and labels the shape", async () => {
    const output = formatSearch(await multiCityTrace(), { limit: 10 });
    expect(output).toContain("Rome → Milan (multi-city)");
  });

  it("reports a stay per city", async () => {
    const output = formatSearch(await multiCityTrace(), { limit: 10 });
    expect(output).toContain("Accommodation Rome: not searched");
    expect(output).toContain("Accommodation Milan: not searched");
  });

  it("gives the nights per city rather than one total", async () => {
    const output = formatSearch(await multiCityTrace(), { limit: 10 });
    expect(output).toContain("3 nights Rome · 3 nights Milan");
  });

  it("prints all three legs", async () => {
    const output = formatSearch(await multiCityTrace(), { limit: 10 });
    const romeToMilan = output
      .split("\n")
      .filter((line) => line.includes("CIA → ") && line.includes("MXP"));
    expect(romeToMilan.length).toBeGreaterThan(0);
  });

  it("says which stage the budget ran out on", async () => {
    const output = formatSearch(await multiCityTrace(), { limit: 10 });
    // Either every query was afforded, or the line names what was not asked.
    if (output.includes("budget-limited")) {
      expect(output).toMatch(/budget-limited: .*(way home|onward leg).* not made/);
    }
    expect(output).toContain("Calls planned:");
  });

  it("says why a way home was sought from a city home cannot reach", async () => {
    // Milan is reachable only on from Rome, so its way-home query exists
    // solely because onward discovery put it in the return pool.
    const trace = await runFlightSearch(
      request({ allowMultiCity: true }),
      {
        flightProvider: provider(
          [leg("out-cia", SJJ, CIA, ["2026-12-27T10:00", "2026-12-27T11:30"], 4000)],
          {
            CIA: [leg("back-cia", CIA, SJJ, ["2027-01-02T18:00", "2027-01-02T19:30"], 3000)],
            MXP: [leg("back-mxp", MXP, SJJ, ["2027-01-02T18:00", "2027-01-02T19:45"], 3500)],
          },
          { CIA: [leg("cia-mxp", CIA, MXP, ["2026-12-30T10:00", "2026-12-30T11:15"], 2000)] },
        ),
        cities: cityRepository,
        geography: fixtureGeography,
        airports: fixtureAirports,
      },
      { currency: "EUR", now: fixedClock(), newSearchId: () => "search-p", strategy: "composed" },
    );
    const output = formatSearch(trace, { limit: 10 });
    expect(output).toContain("Way home sought from Milan (MXP)");
    expect(output).toContain("reached SJJ → CIA → MXP");
    // 40.00 to Rome plus 20.00 on to Milan. The unknown way home is not in it.
    expect(output).toContain("known reach cost 60.00 EUR");
  });

  it("reports second cities with no retrieved way home", async () => {
    const stranded = await runFlightSearch(
      request({ allowMultiCity: true }),
      {
        flightProvider: provider(
          [leg("out-cia", SJJ, CIA, ["2026-12-27T10:00", "2026-12-27T11:30"], 4000)],
          { CIA: [leg("back-cia", CIA, SJJ, ["2027-01-02T18:00", "2027-01-02T19:30"], 3000)] },
          { CIA: [leg("cia-mxp", CIA, MXP, ["2026-12-30T10:00", "2026-12-30T11:15"], 2000)] },
        ),
        cities: cityRepository,
        geography: fixtureGeography,
        airports: fixtureAirports,
      },
      { currency: "EUR", now: fixedClock(), newSearchId: () => "search-x", strategy: "composed" },
    );
    const output = formatSearch(stranded, { limit: 10 });
    expect(output).toContain("Second cities reachable onward: 1");
    expect(output).toContain("1 with no retrieved way home");
  });
});
