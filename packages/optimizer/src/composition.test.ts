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

type Legs = ReturnType<typeof outboundLeg>;

function provider(outbound: Legs[], returns: Record<string, Legs[]>): FlightProvider {
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
      if (query.destinations === "anywhere") return Promise.resolve(pack(outbound));
      const [from] = query.origins;
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
      { ...options, composition: { maxUnpricedGapKm: 100, maxOffersPerAirport: 8 } },
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
