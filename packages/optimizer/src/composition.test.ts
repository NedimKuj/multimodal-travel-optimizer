import { okResult, type FlightProvider, type FlightSearchQuery } from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import { exploreComposedItineraries } from "./composed-search.js";
import {
  cityRepository,
  CIA,
  FCO,
  fixtureAirports,
  fixtureGeography,
  metrics,
  MXP,
  offer,
  request,
  SAW,
  segment,
  SJJ,
} from "./test-fixtures.js";

/*
 * Composition from one-way fares: patterns 1 and 2 (Phase 3).
 * Fares here are test inputs, and no test touches the network.
 */

const ARRIVAL_OFFSET: Record<string, string> = {
  [FCO.id]: "+01:00",
  [CIA.id]: "+01:00",
  [SAW.id]: "+03:00",
};

function outboundLeg(id: string, to: typeof FCO, amountMinor: number) {
  const leg = segment({
    id,
    origin: SJJ,
    destination: to,
    departure: "2026-12-27T10:00+01:00",
    arrival: `2026-12-27T13:30${ARRIVAL_OFFSET[to.id] ?? "+01:00"}`,
  });
  return { segments: [leg], offers: [offer(`${id}-fare`, [leg.id], amountMinor)] };
}

function returnLeg(id: string, from: typeof FCO, amountMinor: number) {
  const leg = segment({
    id,
    origin: from,
    destination: SJJ,
    departure: `2027-01-02T18:00${ARRIVAL_OFFSET[from.id] ?? "+01:00"}`,
    arrival: "2027-01-02T20:30+01:00",
  });
  return { segments: [leg], offers: [offer(`${id}-fare`, [leg.id], amountMinor)] };
}

/** A matched round trip: one offer spanning an outbound and its way home. */
function matchedTrip(id: string, to: typeof FCO, amountMinor: number) {
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
    arrival: "2027-01-02T20:30+01:00",
  });
  return {
    segments: [out, back],
    offers: [offer(`${id}-fare`, [out.id, back.id], amountMinor)],
  };
}

type Legs = ReturnType<typeof outboundLeg>;

function provider(
  outbound: Legs[],
  returns: Record<string, Legs[]>,
  onward: Record<string, Legs[]> = {},
  roundTrip: Legs[] = [],
): FlightProvider {
  const pack = (parts: Legs[]) =>
    okResult(
      "fixture-flights",
      { segments: parts.flatMap((p) => p.segments), offers: parts.flatMap((p) => p.offers) },
      metrics,
    );
  return {
    descriptor: {
      id: "fixture-flights",
      kind: "flight",
      enabled: true,
      sourceTypes: ["cached"],
      maxCallsPerSearch: 12,
    },
    search: (query: FlightSearchQuery) => {
      const [from] = query.origins;
      if (query.destinations === "anywhere") {
        // From home without a return range this is stage 1, and with one it is
        // stage 1b; from a destination it is stage 3.
        if (from !== "SJJ") return Promise.resolve(pack(onward[from ?? ""] ?? []));
        return Promise.resolve(pack(query.returnDates === undefined ? outbound : roundTrip));
      }
      return Promise.resolve(pack(returns[from ?? ""] ?? []));
    },
  };
}

const deps = (flightProvider: FlightProvider) => ({
  flightProvider,
  cities: cityRepository,
  geography: fixtureGeography,
  airports: fixtureAirports,
});

const options = { currency: "EUR" } as const;

describe("composed round trips (pattern 1)", () => {
  it("builds a complete itinerary from two one-way fares", async () => {
    const result = await exploreComposedItineraries(
      request({ allowOpenJaw: true }),
      deps(provider([outboundLeg("out-cia", CIA, 4000)], { CIA: [returnLeg("back-cia", CIA, 3000)] })),
      options,
    );
    const candidate = result.destinations[0]?.candidates[0];
    expect(candidate).toBeDefined();
    expect(candidate?.summary.cost.fares).toEqual({ amountMinor: 14000, currency: "EUR" });
    expect(candidate?.summary.cost.scope).toBe("transport_and_partial_accommodation");
    expect(candidate?.summary.unpricedGaps).toEqual([]);
    expect(candidate?.candidate.offers).toHaveLength(2);
  });

  it("reports a destination that has no way home", async () => {
    const result = await exploreComposedItineraries(
      request({ allowOpenJaw: true }),
      deps(provider([outboundLeg("out-cia", CIA, 4000)], {})),
      options,
    );
    expect(result.counts.destinationsWithoutReturn).toBe(1);
    expect(result.destinations).toEqual([]);
    expect(result.discovery?.enriched[0]).toMatchObject({ returnOffersFound: 0 });
  });
});

describe("open jaw (pattern 2)", () => {
  const twoCities = provider(
    [outboundLeg("out-fco", FCO, 4000), outboundLeg("out-cia", CIA, 4200)],
    { CIA: [returnLeg("back-cia", CIA, 3000)] },
  );

  it("pairs an arrival at one airport with a departure from another", async () => {
    const result = await exploreComposedItineraries(
      request({ allowOpenJaw: true }),
      deps(twoCities),
      options,
    );
    const openJaw = result.destinations
      .flatMap((destination) => destination.candidates)
      .find((candidate) => candidate.summary.unpricedGaps.length > 0);
    expect(openJaw).toBeDefined();
    expect(openJaw?.candidate.segments[0]?.destination.iata).toBe("FCO");
    expect(openJaw?.candidate.segments.at(-1)?.origin.iata).toBe("CIA");
  });

  it("records the sector as unpriced, with its endpoints and distance", async () => {
    const result = await exploreComposedItineraries(
      request({ allowOpenJaw: true }),
      deps(twoCities),
      options,
    );
    const openJaw = result.destinations
      .flatMap((destination) => destination.candidates)
      .find((candidate) => candidate.summary.unpricedGaps.length > 0);
    const [gap] = openJaw?.summary.unpricedGaps ?? [];
    // Fiumicino is far enough out to need a transfer, so the itinerary leaves
    // the traveler in Rome and the sector starts there. Ciampino is close in,
    // so it ends at the airport: the geography is asymmetric, and so is the gap.
    expect(gap).toMatchObject({
      from: { iata: "ROM" },
      to: { iata: "CIA" },
      status: "unpriced",
      reason: "no_licensed_source",
    });
    expect(gap?.distanceKm).toBeGreaterThan(0);
  });

  it("starts the sector where the last priced segment leaves the traveler", async () => {
    const result = await exploreComposedItineraries(
      request({ allowOpenJaw: true }),
      deps(twoCities),
      options,
    );
    const openJaw = result.destinations
      .flatMap((destination) => destination.candidates)
      .find((candidate) => candidate.summary.unpricedGaps.length > 0);
    const [gap] = openJaw?.summary.unpricedGaps ?? [];
    // Nothing teleports: whatever the itinerary's last stop before the gap is,
    // the gap begins there, and the next segment begins where the gap ends.
    const before = openJaw?.candidate.segments.filter(
      (segment) => segment.destination.id === gap?.from.id,
    );
    expect(before?.length).toBeGreaterThan(0);
    expect(openJaw?.candidate.segments.at(-1)?.origin.id).toBe(gap?.to.id);
  });

  it("excludes the gap from the amount and says so", async () => {
    const result = await exploreComposedItineraries(
      request({ allowOpenJaw: true }),
      deps(twoCities),
      options,
    );
    const openJaw = result.destinations
      .flatMap((destination) => destination.candidates)
      .find((candidate) => candidate.summary.unpricedGaps.length > 0);
    // 40.00 out + 30.00 home, per traveler, for two. The gap adds nothing.
    expect(openJaw?.summary.cost.fares).toEqual({ amountMinor: 14000, currency: "EUR" });
    expect(openJaw?.summary.cost.scope).toBe("excludes_unpriced_segment");
    expect(openJaw?.summary.cost.exclusions).toContain("unpriced_segment");
  });

  it("does not compose an open jaw unless the request allows one", async () => {
    const result = await exploreComposedItineraries(
      request({ allowOpenJaw: false }),
      deps(twoCities),
      options,
    );
    const gapped = result.destinations
      .flatMap((destination) => destination.candidates)
      .filter((candidate) => candidate.summary.unpricedGaps.length > 0);
    expect(gapped).toEqual([]);
  });

  it("refuses a pairing whose sector is implausibly far", async () => {
    const result = await exploreComposedItineraries(
      request({ allowOpenJaw: true }),
      deps(
        provider([outboundLeg("out-saw", SAW, 4000), outboundLeg("out-cia", CIA, 4200)], {
          CIA: [returnLeg("back-cia", CIA, 3000)],
        }),
      ),
      {
        ...options,
        composition: { maxUnpricedGapKm: 100, maxOffersPerAirport: 8, minNightsPerCity: 1 },
      },
    );
    expect(result.counts.rejectedGapTooFar).toBeGreaterThan(0);
    const gapped = result.destinations
      .flatMap((destination) => destination.candidates)
      .filter((candidate) => candidate.summary.unpricedGaps.length > 0);
    expect(gapped).toEqual([]);
  });
});

describe("ranking", () => {
  it("puts a complete itinerary ahead of a cheaper one with a gap", async () => {
    const result = await exploreComposedItineraries(
      request({ allowOpenJaw: true }),
      deps(
        provider(
          [
            // The open-jaw pairing (FCO out, CIA home) is the cheaper fare pair.
            outboundLeg("out-fco", FCO, 1000),
            outboundLeg("out-cia", CIA, 9000),
          ],
          { CIA: [returnLeg("back-cia", CIA, 1000)] },
        ),
      ),
      options,
    );
    const all = result.destinations.flatMap((destination) => destination.candidates);
    const firstGappedIndex = all.findIndex(
      (candidate) => candidate.summary.unpricedGaps.length > 0,
    );
    const lastCompleteIndex = all.reduce(
      (last, candidate, index) => (candidate.summary.unpricedGaps.length === 0 ? index : last),
      -1,
    );
    // Every complete itinerary precedes every gapped one...
    expect(lastCompleteIndex).toBeLessThan(firstGappedIndex);
    // ...even though the gapped one's known cost is lower.
    const cheapestGapped = all[firstGappedIndex];
    const best = all[0];
    expect(best?.summary.unpricedGaps).toEqual([]);
    expect(cheapestGapped?.summary.cost.total.amountMinor).toBeLessThan(
      best?.summary.cost.total.amountMinor ?? 0,
    );
  });
});

describe("determinism", () => {
  it("produces the same itineraries and order every run", async () => {
    const run = async () =>
      exploreComposedItineraries(
        request({ allowOpenJaw: true }),
        deps(
          provider([outboundLeg("out-fco", FCO, 4000), outboundLeg("out-cia", CIA, 4200)], {
            CIA: [returnLeg("back-cia", CIA, 3000)],
            FCO: [returnLeg("back-fco", FCO, 3500)],
          }),
        ),
        options,
      );
    const [first, second] = [await run(), await run()];
    const ids = (result: Awaited<ReturnType<typeof run>>) =>
      result.destinations.flatMap((destination) =>
        destination.candidates.map((candidate) => candidate.candidate.id),
      );
    expect(ids(first)).toEqual(ids(second));
    expect(ids(first).length).toBeGreaterThan(1);
  });
});

describe("temporal sanity", () => {
  it("never pairs a way home that leaves before the outbound lands", async () => {
    // The return departs a week before the outbound arrives.
    const earlyReturn = {
      segments: [
        segment({
          id: "back-too-early",
          origin: CIA,
          destination: SJJ,
          departure: "2026-12-25T18:00+01:00",
          arrival: "2026-12-25T20:30+01:00",
        }),
      ],
      offers: [offer("back-too-early-fare", ["back-too-early"], 3000)],
    };
    const result = await exploreComposedItineraries(
      request({ allowOpenJaw: true }),
      deps(provider([outboundLeg("out-cia", CIA, 4000)], { CIA: [earlyReturn] })),
      options,
    );
    expect(result.counts.rejectedReturnBeforeArrival).toBe(1);
    expect(result.destinations).toEqual([]);
  });
});

describe("composition without open jaw", () => {
  it("still composes round trips from one-way fares", async () => {
    // Pattern 1 is useful on its own: one-way discovery reaches destinations
    // the provider's round-trip fares never return.
    const result = await exploreComposedItineraries(
      request({ allowOpenJaw: false }),
      deps(
        provider([outboundLeg("out-cia", CIA, 4000)], { CIA: [returnLeg("back-cia", CIA, 3000)] }),
      ),
      options,
    );
    const candidate = result.destinations[0]?.candidates[0];
    expect(candidate).toBeDefined();
    expect(candidate?.candidate.offers).toHaveLength(2);
    expect(candidate?.summary.unpricedGaps).toEqual([]);
  });
});

describe("gaps are declared against the order the traveller travels", () => {
  it("rejects a pairing whose legs would reorder, rather than orphaning its gap", async () => {
    // FCO arrival is after the CIA departure, so sorting by departure would
    // flip the legs and leave the declared gap dangling.
    const lateOutbound = {
      segments: [
        segment({
          id: "late-out",
          origin: SJJ,
          destination: FCO,
          departure: "2027-01-01T10:00+01:00",
          arrival: "2027-01-01T11:30+01:00",
        }),
      ],
      offers: [offer("late-out-fare", ["late-out"], 4000)],
    };
    const earlyHome = {
      segments: [
        segment({
          id: "early-home",
          origin: CIA,
          destination: SJJ,
          departure: "2026-12-28T18:00+01:00",
          arrival: "2026-12-28T20:30+01:00",
        }),
      ],
      offers: [offer("early-home-fare", ["early-home"], 3000)],
    };
    const result = await exploreComposedItineraries(
      request({ allowOpenJaw: true }),
      // CIA must also be a discovered destination for its return to be queried.
      deps(provider([lateOutbound, outboundLeg("out-cia", CIA, 4200)], { CIA: [earlyHome] })),
      options,
    );
    expect(result.counts.rejectedReturnBeforeArrival).toBeGreaterThan(0);
    expect(result.counts.rejectedInvalid).toBe(0);
    expect(result.issues.map((issue) => issue.code)).not.toContain("INVALID_CANDIDATE");
  });
});

describe("multi-city (patterns 3 and 4)", () => {
  /** Ciampino is close to Rome, Malpensa is not: transfers differ per stay. */
  function onwardLeg(id: string, from: typeof CIA, to: typeof MXP, amountMinor: number) {
    const leg = segment({
      id,
      origin: from,
      destination: to,
      departure: `2026-12-30T10:00${ARRIVAL_OFFSET[from.id] ?? "+01:00"}`,
      arrival: `2026-12-30T11:15${ARRIVAL_OFFSET[to.id] ?? "+01:00"}`,
    });
    return { segments: [leg], offers: [offer(`${id}-fare`, [leg.id], amountMinor)] };
  }

  // Milan is reachable from home as well as from Rome. That matters: return
  // legs are only queried for the destinations stage 1 found, so a second city
  // stage 1 never saw has no retrieved way home (ADR 0015).
  const viaMilan = provider(
    [outboundLeg("out-cia", CIA, 4000), outboundLeg("out-mxp", MXP, 8000)],
    {
      CIA: [returnLeg("back-cia", CIA, 3000)],
      MXP: [returnLeg("back-mxp", MXP, 3500)],
    },
    { CIA: [onwardLeg("cia-mxp", CIA, MXP, 2000)] },
  );

  async function search(overrides: Record<string, unknown> = {}) {
    return exploreComposedItineraries(
      request({ allowMultiCity: true, ...overrides }),
      deps(viaMilan),
      options,
    );
  }

  function threeLeg(result: Awaited<ReturnType<typeof search>>) {
    return result.destinations
      .flatMap((destination) => destination.candidates)
      .filter(
        (candidate) =>
          candidate.candidate.offers.filter((entry) => entry.provenance.sourceType !== "estimated")
            .length === 3,
      );
  }

  it("builds a fully priced trip through two cities", async () => {
    const [trip] = threeLeg(await search());
    expect(trip).toBeDefined();
    // 40.00 out + 20.00 on + 35.00 home, per traveler, for two.
    expect(trip?.summary.cost.fares).toEqual({ amountMinor: 19000, currency: "EUR" });
    expect(trip?.summary.unpricedGaps).toEqual([]);
    expect(trip?.summary.cost.scope).toBe("transport_and_partial_accommodation");
  });

  it("splits the nights between the two cities", async () => {
    const [trip] = threeLeg(await search());
    // Rome 27–30 Dec, Milan 30 Dec–2 Jan.
    expect(trip?.nightsByStay).toEqual([3, 3]);
    expect(trip?.nights).toBe(6);
  });

  it("names both cities, in the order they are visited", async () => {
    const result = await search();
    const multiCity = result.destinations.find((destination) => destination.cities.length > 1);
    expect(multiCity?.cities.map((city) => city.name)).toEqual(["Rome", "Milan"]);
    expect(multiCity?.airports.map((airport) => airport.iata)).toEqual(["CIA", "MXP"]);
  });

  it("builds nothing three-legged unless multi-city was requested", async () => {
    const result = await exploreComposedItineraries(
      request({ allowMultiCity: false }),
      deps(viaMilan),
      options,
    );
    expect(threeLeg(result)).toEqual([]);
  });

  it("will not fly home from a third city unless an open jaw is allowed", async () => {
    // Rome, on to Milan, home from Rome: that leaves Milan to Rome unpriced.
    const result = await search({ allowOpenJaw: false });
    const gapped = threeLeg(result).filter(
      (candidate) => candidate.summary.unpricedGaps.length > 0,
    );
    expect(gapped).toEqual([]);
  });

  it("flies home from a third city as an open jaw, with the sector unpriced", async () => {
    const result = await search({ allowOpenJaw: true });
    const gapped = threeLeg(result).filter(
      (candidate) => candidate.summary.unpricedGaps.length > 0,
    );
    expect(gapped.length).toBeGreaterThan(0);
    const [gap] = gapped[0]?.summary.unpricedGaps ?? [];
    // Malpensa is far from Milan, so the traveler is in the city by then.
    expect(gap).toMatchObject({ from: { iata: "MIL" }, status: "unpriced" });
    expect(gapped[0]?.summary.cost.scope).toBe("excludes_unpriced_segment");
  });

  it("ranks a complete multi-city trip above one with an unpriced sector", async () => {
    const result = await search({ allowOpenJaw: true });
    // Within a destination, every fully priced itinerary comes before every
    // one whose amount leaves a sector out (ADR 0014 §3).
    for (const destination of result.destinations) {
      const gapped = destination.candidates.map(
        (candidate) => candidate.summary.unpricedGaps.length > 0,
      );
      const firstGapped = gapped.indexOf(true);
      if (firstGapped < 0) continue;
      expect(gapped.slice(firstGapped).every(Boolean)).toBe(true);
    }
    // And such an itinerary really is among the results, not quietly dropped.
    const anyGapped = result.destinations
      .flatMap((destination) => destination.candidates)
      .some((candidate) => candidate.summary.unpricedGaps.length > 0);
    expect(anyGapped).toBe(true);
  });

  it("refuses a city the trip only passes through", async () => {
    // The onward leg leaves Rome the same afternoon the outbound lands there,
    // so Rome gets no night: that is a connection, not a second city.
    const sameDay = provider(
      [outboundLeg("out-cia", CIA, 4000), outboundLeg("out-mxp", MXP, 8000)],
      { CIA: [returnLeg("back-cia", CIA, 3000)], MXP: [returnLeg("back-mxp", MXP, 3500)] },
      {
        CIA: [
          (() => {
            const leg = segment({
              id: "cia-mxp-sameday",
              origin: CIA,
              destination: MXP,
              departure: "2026-12-27T17:00+01:00",
              arrival: "2026-12-27T18:15+01:00",
            });
            return { segments: [leg], offers: [offer("cia-mxp-sameday-fare", [leg.id], 2000)] };
          })(),
        ],
      },
    );
    const result = await exploreComposedItineraries(
      request({ allowMultiCity: true }),
      deps(sameDay),
      options,
    );
    expect(result.counts.rejectedStayTooShort).toBeGreaterThan(0);
    expect(threeLeg(result)).toEqual([]);
  });

  it("completes a trip through a city stage 1 never found", async () => {
    // Milan is unreachable from home: the only way there is on from Rome. Its
    // way home exists solely because onward discovery put it in the return
    // pool in its own right (ADR 0015 §7).
    const onlyOnward = provider(
      [outboundLeg("out-cia", CIA, 4000)],
      { CIA: [returnLeg("back-cia", CIA, 3000)], MXP: [returnLeg("back-mxp", MXP, 3500)] },
      { CIA: [onwardLeg("cia-mxp", CIA, MXP, 2000)] },
    );
    const result = await exploreComposedItineraries(
      request({ allowMultiCity: true }),
      deps(onlyOnward),
      options,
    );
    const [trip] = threeLeg(result);
    expect(trip).toBeDefined();
    expect(trip?.candidate.segments.filter((leg) => leg.mode === "flight").map((leg) => leg.origin.iata)).toEqual([
      "SJJ",
      "CIA",
      "MXP",
    ]);
    // 40.00 out + 20.00 on + 35.00 home, per traveler, for two.
    expect(trip?.summary.cost.fares).toEqual({ amountMinor: 19000, currency: "EUR" });
    expect(trip?.summary.unpricedGaps).toEqual([]);
    expect(trip?.nightsByStay).toEqual([3, 3]);
    expect(result.counts.secondCitiesWithoutReturn).toBe(0);
  });

  it("counts three-leg candidates apart from the rest", async () => {
    const result = await search();
    const threeLegCount = threeLeg(result).length;
    expect(result.counts.multiCityCandidatesBuilt).toBe(threeLegCount);
    expect(result.counts.multiCityCandidatesBuilt).toBeGreaterThan(0);
    // A multi-city candidate is still a candidate, never counted twice.
    expect(result.counts.multiCityCandidatesBuilt).toBeLessThanOrEqual(
      result.counts.candidatesBuilt,
    );
  });

  it("counts no multi-city candidates when none were asked for", async () => {
    const result = await exploreComposedItineraries(
      request({ allowMultiCity: false }),
      deps(viaMilan),
      options,
    );
    expect(result.counts.multiCityCandidatesBuilt).toBe(0);
    expect(result.counts.candidatesBuilt).toBeGreaterThan(0);
  });

  it("pairs every second city it spent a way-home query on", async () => {
    // Whatever discovery admitted to the return pool, composition must be
    // willing to pair, or a provider call was spent on a leg it then prunes.
    const result = await exploreComposedItineraries(
      request({ allowMultiCity: true }),
      deps(viaMilan),
      options,
    );
    const queriedOnward = (result.discovery?.enriched ?? [])
      .filter((entry) => entry.source === "onward")
      .map((entry) => entry.airport.iata);
    const paired = new Set(
      result.destinations
        .flatMap((destination) => destination.candidates)
        .flatMap((candidate) => candidate.candidate.segments)
        .map((leg) => leg.destination.iata),
    );
    for (const code of queriedOnward) expect(paired.has(code)).toBe(true);
  });

  it("counts second cities it reached but cannot get home from", async () => {
    const stranded = provider(
      [outboundLeg("out-cia", CIA, 4000)],
      { CIA: [returnLeg("back-cia", CIA, 3000)] },
      { CIA: [onwardLeg("cia-mxp", CIA, MXP, 2000)] },
    );
    const result = await exploreComposedItineraries(
      request({ allowMultiCity: true }),
      deps(stranded),
      options,
    );
    expect(result.counts.secondCitiesReached).toBe(1);
    expect(result.counts.secondCitiesWithoutReturn).toBe(1);
  });
});

/*
 * Matched round-trip discovery (stage 1b, ADR 0019).
 *
 * Fares here are synthetic. The captured Aviasales responses that motivated
 * this stage are raw provider data and stay out of version control
 * (docs/provider-compliance.md), so these fixtures reproduce their *shape*: a
 * one-way universe whose destinations have no retrievable way home, and a
 * round-trip universe that answers both halves at once.
 */
describe("matched round-trip discovery (stage 1b)", () => {
  it("builds a candidate straight from a matched fare, as one offer", async () => {
    const result = await exploreComposedItineraries(
      request(),
      deps(provider([], {}, {}, [matchedTrip("rt-cia", CIA, 9000)])),
      options,
    );
    const candidate = result.destinations[0]?.candidates[0];
    expect(candidate).toBeDefined();
    // One commercial offer over two segments — not two fares we paired.
    expect(candidate?.candidate.offers).toHaveLength(1);
    expect(candidate?.candidate.offers[0]?.segmentIds).toHaveLength(2);
    expect(candidate?.summary.cost.fares).toEqual({ amountMinor: 18000, currency: "EUR" });
    // A matched round trip leaves no sector for the traveler to arrange.
    expect(candidate?.summary.unpricedGaps).toEqual([]);
  });

  it("finds trips where one-way discovery alone finds none", async () => {
    // The measured failure: every one-way destination lacked a way home, so
    // composition had nothing to pair and returned no candidate at all.
    const oneWayOnly = await exploreComposedItineraries(
      request(),
      deps(provider([outboundLeg("out-cia", CIA, 4000)], {})),
      options,
    );
    expect(oneWayOnly.destinations).toEqual([]);
    expect(oneWayOnly.counts.candidatesBuilt).toBe(0);

    const hybrid = await exploreComposedItineraries(
      request(),
      deps(
        provider([outboundLeg("out-cia", CIA, 4000)], {}, {}, [matchedTrip("rt-cia", CIA, 9000)]),
      ),
      options,
    );
    expect(hybrid.counts.candidatesBuilt).toBeGreaterThan(0);
    expect(hybrid.destinations.length).toBeGreaterThan(0);
  });

  it("runs whether or not an open jaw is allowed", async () => {
    // Allowing an open jaw widens what a trip may look like. It never means
    // only open jaws are wanted, so the matched round trip is still offered.
    for (const allowOpenJaw of [false, true]) {
      const result = await exploreComposedItineraries(
        request({ allowOpenJaw }),
        deps(provider([], {}, {}, [matchedTrip("rt-cia", CIA, 9000)])),
        options,
      );
      expect(result.destinations[0]?.candidates[0]?.candidate.offers).toHaveLength(1);
    }
  });

  it("keeps a matched fare whole rather than pricing its legs apart", async () => {
    const result = await exploreComposedItineraries(
      request(),
      deps(provider([], {}, {}, [matchedTrip("rt-cia", CIA, 9000)])),
      options,
    );
    const candidate = result.destinations[0]?.candidates[0];
    // Two priced segments, one price. No per-leg allocation was invented.
    expect(candidate?.candidate.segments.length).toBeGreaterThanOrEqual(2);
    expect(candidate?.candidate.offers).toHaveLength(1);
    expect(candidate?.summary.cost.estimated).toEqual({ amountMinor: 0, currency: "EUR" });
  });
});
