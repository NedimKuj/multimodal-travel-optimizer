import { parseUtcInstant, type TransportSegment } from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import { applyAccommodation } from "./accommodation-search.js";
import { changesOf, comparabilityKey, coverageProfile, dominates } from "./dominance.js";
import { DEFAULT_CONNECTION_RULES } from "./connection-rules.js";
import {
  assembleCandidate,
  comparisonClass,
  type CandidateContext,
  type RankedCandidate,
} from "./flight-exploration.js";
import { DEFAULT_GROUND_TRANSFER_CONFIG } from "./ground-transfer.js";
import { resolveTravelWindow } from "./travel-window.js";
import {
  cityRepository,
  CIA,
  fixtureGeography,
  MXP,
  offer,
  request,
  segment,
  SJJ,
} from "./test-fixtures.js";
import { transportPattern } from "./transport-pattern.js";

/*
 * The dominance relation (ADR 0017). Candidates are assembled for real, so the
 * costs, times and changes under test are the ones the optimizer produces.
 * Fares here are test inputs, and no test touches a provider.
 */

const context: CandidateContext = {
  requestedOrigin: SJJ,
  cities: cityRepository,
  geography: fixtureGeography,
  connectionRules: DEFAULT_CONNECTION_RULES,
  groundTransfer: DEFAULT_GROUND_TRANSFER_CONFIG,
  fetchedAt: parseUtcInstant("2026-09-18T09:00:00Z"),
};

const overrides = { allowOpenJaw: true, allowMultiCity: true };

function windowFor() {
  const result = resolveTravelWindow(request(overrides));
  if (!result.ok) throw new Error("expected a window");
  return result.window;
}

interface Shape {
  readonly amountMinor: number;
  /** Extra minutes on the outbound, to move travel time alone. */
  readonly extraMinutes?: number;
  /** Stops inside the outbound leg, to move changes alone. */
  readonly stops?: number;
  readonly multiCity?: boolean;
  readonly openJaw?: boolean;
}

function build(id: string, shape: Shape): RankedCandidate {
  const extra = shape.extraMinutes ?? 0;
  const arrival = 30 + extra;
  const hours = 11 + Math.floor(arrival / 60);
  const minutes = arrival % 60;
  const outboundArrival = `2026-12-27T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}+01:00`;

  const out = segment({
    id: `${id}-out`,
    origin: SJJ,
    destination: shape.openJaw === true ? MXP : CIA,
    departure: "2026-12-27T10:00+01:00",
    arrival: outboundArrival,
    ...(shape.stops !== undefined && { transfers: shape.stops }),
  });
  const onward = segment({
    id: `${id}-onward`,
    origin: CIA,
    destination: MXP,
    departure: "2026-12-30T10:00+01:00",
    arrival: "2026-12-30T11:15+01:00",
  });
  const home = segment({
    id: `${id}-home`,
    origin: shape.multiCity === true && shape.openJaw !== true ? MXP : CIA,
    destination: SJJ,
    departure: "2027-01-02T18:00+01:00",
    arrival: "2027-01-02T19:30+01:00",
  });

  const legs: TransportSegment[] =
    shape.multiCity === true ? [out, onward, home] : [out, home];
  const outcome = assembleCandidate({
    id,
    legs,
    // The whole fare on the first leg, so the total is exactly what was asked.
    offers: legs.map((leg, index) =>
      offer(`${id}-f${String(index)}`, [leg.id], index === 0 ? shape.amountMinor : 0),
    ),
    request: request(overrides),
    window: windowFor(),
    context,
  });
  if (!outcome.ok) throw new Error(`${id}: ${outcome.counter}`);
  const { attempt } = outcome;
  return {
    candidate: attempt.candidate,
    summary: attempt.summary,
    nights: attempt.nights,
    nightsByStay: attempt.nightsByStay,
    stayIntervals: attempt.stayIntervals,
  };
}

describe("the three dimensions", () => {
  it("prunes a candidate strictly worse on all three", () => {
    const best = build("best", { amountMinor: 10000 });
    const worst = build("worst", { amountMinor: 20000, extraMinutes: 60, stops: 2 });
    expect(dominates(best, worst)).toBe(true);
    expect(dominates(worst, best)).toBe(false);
  });

  it("keeps a candidate better on one dimension and worse on another", () => {
    const cheapSlow = build("cheap-slow", { amountMinor: 10000, extraMinutes: 120 });
    const dearFast = build("dear-fast", { amountMinor: 20000 });
    expect(dominates(cheapSlow, dearFast)).toBe(false);
    expect(dominates(dearFast, cheapSlow)).toBe(false);
  });

  it("does not let equality count as domination", () => {
    const a = build("a", { amountMinor: 10000 });
    const b = build("b", { amountMinor: 10000 });
    expect(dominates(a, b)).toBe(false);
    expect(dominates(b, a)).toBe(false);
  });

  it("dominates on cost alone, all else equal", () => {
    expect(dominates(build("x", { amountMinor: 9000 }), build("y", { amountMinor: 9001 }))).toBe(
      true,
    );
  });

  it("dominates on travel time alone, all else equal", () => {
    const quick = build("quick", { amountMinor: 9000 });
    const slow = build("slow", { amountMinor: 9000, extraMinutes: 45 });
    expect(quick.summary.cost.total).toEqual(slow.summary.cost.total);
    expect(dominates(quick, slow)).toBe(true);
  });

  it("dominates on changes alone, all else equal", () => {
    const direct = build("direct", { amountMinor: 9000 });
    const oneStop = build("one-stop", { amountMinor: 9000, stops: 1 });
    expect(changesOf(oneStop)).toBeGreaterThan(changesOf(direct));
    expect(direct.summary.travelTimeMinutes).toBe(oneStop.summary.travelTimeMinutes);
    expect(dominates(direct, oneStop)).toBe(true);
  });

  it("uses stops and connections together, not one of them", () => {
    const direct = build("direct", { amountMinor: 9000 });
    // A multi-city trip adds a connection; a stop adds to the same total.
    expect(changesOf(direct)).toBe(direct.summary.stops + direct.summary.connections);
    const oneStop = build("one-stop", { amountMinor: 9000, stops: 1 });
    expect(oneStop.summary.stops).toBe(1);
    expect(changesOf(oneStop)).toBe(1 + oneStop.summary.connections);
  });
});

describe("what may not be compared", () => {
  it("never compares across transport patterns", () => {
    // Cheaper, quicker and simpler, and still not comparable: a round trip and
    // a multi-city trip to the same place are different products.
    const roundTrip = build("rt", { amountMinor: 5000 });
    const multiCity = build("mc", { amountMinor: 30000, extraMinutes: 90, stops: 2, multiCity: true });
    expect(transportPattern(roundTrip)).not.toBe(transportPattern(multiCity));
    expect(dominates(roundTrip, multiCity)).toBe(false);
    expect(dominates(multiCity, roundTrip)).toBe(false);
  });

  it("never compares across comparison classes", () => {
    const complete = build("rt", { amountMinor: 5000 });
    const gapped = build("oj", { amountMinor: 30000, extraMinutes: 90, openJaw: true });
    expect(comparisonClass(complete)).not.toBe(comparisonClass(gapped));
    expect(dominates(complete, gapped)).toBe(false);
    expect(dominates(gapped, complete)).toBe(false);
  });

  it("never compares across cost scopes", () => {
    const partial = build("rt", { amountMinor: 5000 });
    const gapped = build("oj", { amountMinor: 30000, openJaw: true });
    expect(partial.summary.cost.scope).not.toBe(gapped.summary.cost.scope);
    expect(dominates(partial, gapped)).toBe(false);
  });

  it("never treats an unknown transport cost as zero", () => {
    // The open jaw's amount omits a whole sector, so it looks far cheaper.
    // It must not therefore eliminate a fully priced trip.
    const gapped = build("oj", { amountMinor: 1000, openJaw: true });
    const priced = build("rt", { amountMinor: 99000, extraMinutes: 120, stops: 3 });
    expect(gapped.summary.cost.total.amountMinor).toBeLessThan(
      priced.summary.cost.total.amountMinor,
    );
    expect(dominates(gapped, priced)).toBe(false);
  });
});

describe("accommodation coverage profile", () => {
  /** The coverage a priced stay of the given amount implies. */
  const priceStays = (candidate: RankedCandidate, amountMinor: number) => {
    const entries = candidate.stayIntervals.map((interval, index) => ({
      state: "priced" as const,
      city: interval.cities[0],
      checkIn: interval.checkIn,
      checkOut: interval.checkOut,
      nights: interval.nights,
      stay: {
        id: `${candidate.candidate.id}-stay-${String(index)}`,
        propertyId: "p",
        city: interval.cities[0],
        checkIn: interval.checkIn,
        checkOut: interval.checkOut,
        nights: interval.nights,
        guests: 2,
        rooms: 1,
        price: { amountMinor, currency: "EUR" as const },
        provenance: {
          provider: "fixture-stays",
          sourceType: "cached" as const,
          fetchedAt: parseUtcInstant("2026-09-18T09:00:00Z"),
        },
      },
    }));
    const result = applyAccommodation(candidate, entries);
    if (!result.ok) throw new Error(result.issues.map((issue) => issue.code).join(", "));
    return result.candidate;
  };

  it("reads the states of a candidate's stays, sorted", () => {
    const unsearched = build("u", { amountMinor: 9000 });
    expect(coverageProfile(unsearched)).toBe("not_searched");
    expect(coverageProfile(priceStays(unsearched, 5000))).toBe("priced");
  });

  it("refuses to compare candidates with different completeness", () => {
    // Both class 0 once priced; but one knows more of its cost than the other.
    const partly = build("partly", { amountMinor: 9000 });
    const fully = priceStays(build("fully", { amountMinor: 9000 }), 5000);
    expect(coverageProfile(partly)).not.toBe(coverageProfile(fully));
    expect(dominates(partly, fully)).toBe(false);
    expect(dominates(fully, partly)).toBe(false);
  });

  it("still compares candidates whose accommodation merely costs different amounts", () => {
    // Same completeness, different prices: cost remains a dimension.
    const cheap = priceStays(build("cheap", { amountMinor: 9000 }), 3000);
    const dear = priceStays(build("dear", { amountMinor: 9000 }), 8000);
    expect(coverageProfile(cheap)).toBe(coverageProfile(dear));
    expect(dominates(cheap, dear)).toBe(true);
    expect(dominates(dear, cheap)).toBe(false);
  });

  it("keeps the profile out of the comparability key only when it matches", () => {
    const a = build("a", { amountMinor: 9000 });
    const b = build("b", { amountMinor: 9000 });
    expect(comparabilityKey(a)).toBe(comparabilityKey(b));
    expect(comparabilityKey(a)).not.toBe(comparabilityKey(priceStays(b, 4000)));
  });
});

describe("nights are not a dimension", () => {
  it("does not let a shorter trip dominate a longer one", () => {
    const shortHome = segment({
      id: "short-home",
      origin: CIA,
      destination: SJJ,
      departure: "2027-01-01T18:00+01:00",
      arrival: "2027-01-01T19:30+01:00",
    });
    const out = segment({
      id: "short-out",
      origin: SJJ,
      destination: CIA,
      departure: "2026-12-27T10:00+01:00",
      arrival: "2026-12-27T11:30+01:00",
    });
    const outcome = assembleCandidate({
      id: "short",
      legs: [out, shortHome],
      offers: [offer("short-f", [out.id], 9000), offer("short-h", [shortHome.id], 0)],
      request: request(overrides),
      window: windowFor(),
      context,
    });
    if (!outcome.ok) throw new Error(outcome.counter);
    const shorter: RankedCandidate = {
      candidate: outcome.attempt.candidate,
      summary: outcome.attempt.summary,
      nights: outcome.attempt.nights,
      nightsByStay: outcome.attempt.nightsByStay,
      stayIntervals: outcome.attempt.stayIntervals,
    };
    const longer = build("longer", { amountMinor: 9000 });

    expect(shorter.nights).not.toBe(longer.nights);
    // Identical on every dimension dominance uses, so neither is redundant
    // however their lengths differ.
    expect(shorter.summary.cost.total).toEqual(longer.summary.cost.total);
    expect(changesOf(shorter)).toBe(changesOf(longer));
    expect(dominates(shorter, longer)).toBe(false);
    expect(dominates(longer, shorter)).toBe(false);
  });
});

describe("the relation is a strict partial order", () => {
  const a = build("a", { amountMinor: 9000 });
  const b = build("b", { amountMinor: 12000 });
  const c = build("c", { amountMinor: 15000 });

  it("is irreflexive", () => {
    expect(dominates(a, a)).toBe(false);
  });

  it("is antisymmetric", () => {
    expect(dominates(a, b)).toBe(true);
    expect(dominates(b, a)).toBe(false);
  });

  it("is transitive", () => {
    expect(dominates(a, b) && dominates(b, c)).toBe(true);
    expect(dominates(a, c)).toBe(true);
  });
});
