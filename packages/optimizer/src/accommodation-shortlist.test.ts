import { describe, expect, it } from "vitest";

import { parseUtcInstant } from "@travel-optimizer/domain";

import { buildShortlist } from "./accommodation-shortlist.js";
import { DEFAULT_CONNECTION_RULES } from "./connection-rules.js";
import {
  assembleCandidate,
  type CandidateContext,
  type RankedCandidate,
} from "./flight-exploration.js";
import { DEFAULT_GROUND_TRANSFER_CONFIG } from "./ground-transfer.js";
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
import { resolveTravelWindow } from "./travel-window.js";
import { transportPattern, type TransportPattern } from "./transport-pattern.js";

/*
 * The accommodation shortlist (ADR 0016 §5). Amounts here are test inputs, and
 * no test touches a provider.
 */

/*
 * Candidates are assembled for real rather than hand-shaped, so the patterns
 * and exclusions under test are the ones the optimizer actually produces.
 */

const context: CandidateContext = {
  requestedOrigin: SJJ,
  cities: cityRepository,
  geography: fixtureGeography,
  connectionRules: DEFAULT_CONNECTION_RULES,
  groundTransfer: DEFAULT_GROUND_TRANSFER_CONFIG,
  fetchedAt: parseUtcInstant("2026-09-18T09:00:00Z"),
};

function windowFor(overrides: Record<string, unknown>) {
  const result = resolveTravelWindow(request(overrides));
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.code).join("; "));
  return result.window;
}

const leg = (id: string, from: typeof CIA, to: typeof CIA, departure: string, arrival: string) =>
  segment({ id, origin: from, destination: to, departure, arrival });

const OUT_CIA = leg("out-cia", SJJ, CIA, "2026-12-27T10:00+01:00", "2026-12-27T11:30+01:00");
const OUT_MXP = leg("out-mxp", SJJ, MXP, "2026-12-27T10:00+01:00", "2026-12-27T11:30+01:00");
const ONWARD = leg("cia-mxp", CIA, MXP, "2026-12-30T10:00+01:00", "2026-12-30T11:15+01:00");
const HOME_CIA = leg("home-cia", CIA, SJJ, "2027-01-02T18:00+01:00", "2027-01-02T19:30+01:00");
const HOME_MXP = leg("home-mxp", MXP, SJJ, "2027-01-02T18:00+01:00", "2027-01-02T19:45+01:00");

const SHAPES = {
  round_trip: [OUT_CIA, HOME_CIA],
  open_jaw: [OUT_MXP, HOME_CIA],
  multi_city: [OUT_CIA, ONWARD, HOME_MXP],
  multi_city_open_jaw: [OUT_MXP, ONWARD, HOME_CIA],
} as const;

/** A real candidate of the given shape, priced to order. */
function candidate(
  id: string,
  amountMinor: number,
  pattern: TransportPattern,
): RankedCandidate {
  const legs = SHAPES[pattern];
  const overrides = { allowOpenJaw: true, allowMultiCity: true };
  const outcome = assembleCandidate({
    id,
    legs: [...legs],
    // The whole fare on the first leg, so the total is exactly what was asked.
    offers: legs.map((entry, index) =>
      offer(`${id}-${entry.id}`, [entry.id], index === 0 ? amountMinor : 0),
    ),
    request: request(overrides),
    window: windowFor(overrides),
    context,
  });
  if (!outcome.ok) throw new Error(`${id}: assembly failed (${outcome.counter})`);
  const { attempt } = outcome;
  return {
    candidate: attempt.candidate,
    summary: attempt.summary,
    nights: attempt.nights,
    nightsByStay: attempt.nightsByStay,
    stayIntervals: attempt.stayIntervals,
  };
}

/** Candidate ids, which is what every assertion below is really about. */
const ids = (entries: readonly RankedCandidate[]) => entries.map((entry) => entry.candidate.id);

const everything = request({ allowOpenJaw: true, allowMultiCity: true });

describe("eligibility", () => {
  it("refuses a candidate whose transport cost already leaves a sector out", () => {
    const result = buildShortlist([candidate("oj", 100, "open_jaw")], {
      request: everything,
      limit: 5,
    });
    expect(result.selected).toEqual([]);
    expect(result.ineligible[0]).toMatchObject({ reason: "unpriced_transport_sector" });
  });

  it("refuses an open jaw whose stay it also cannot search for", () => {
    // An unresolvable stay only arises when an unpriced sector splits it, so
    // such a candidate fails the first test before reaching the second. Both
    // conditions hold; the reported reason is the transport one.
    const openJaw = candidate("oj", 100, "open_jaw");
    expect(openJaw.summary.accommodation.some((entry) => entry.state === "unresolved")).toBe(
      true,
    );
    const result = buildShortlist([openJaw], { request: everything, limit: 5 });
    expect(result.selected).toEqual([]);
    expect(result.ineligible[0]?.reason).toBe("unpriced_transport_sector");
  });

  it("keeps ineligible candidates rather than discarding them", () => {
    const result = buildShortlist(
      [candidate("rt", 100, "round_trip"), candidate("oj", 50, "open_jaw")],
      { request: everything, limit: 5 },
    );
    expect(ids(result.selected)).toEqual(["rt"]);
    expect(ids(result.ineligible.map((entry) => entry.candidate))).toEqual(["oj"]);
  });

  it("does not let an ineligible candidate fill a pattern slot", () => {
    // The only multi-city option carries an unpriced sector, so multi-city is
    // simply absent — it is not promoted to satisfy the floor.
    const result = buildShortlist(
      [candidate("rt", 100, "round_trip"), candidate("mcoj", 50, "multi_city_open_jaw")],
      { request: everything, limit: 5 },
    );
    expect(result.patterns).toEqual(["round_trip"]);
    expect(result.dropped).toEqual([]);
  });
});

describe("reserving and filling", () => {
  const pool = [
    candidate("rt-120", 120, "round_trip"),
    candidate("rt-125", 125, "round_trip"),
    candidate("rt-130", 130, "round_trip"),
    candidate("mc-160", 160, "multi_city"),
    candidate("mc-170", 170, "multi_city"),
  ];

  it("takes the cheapest, and makes room for a pattern the top N would miss", () => {
    const result = buildShortlist(pool, { request: everything, limit: 4 });
    expect(ids(result.selected)).toEqual([
      "rt-120",
      "mc-160",
      "rt-125",
      "rt-130",
    ]);
    expect([...result.patterns].sort()).toEqual(["multi_city", "round_trip"]);
  });

  it("preserves every missing pattern when more than one is absent", () => {
    const withThree = [
      candidate("rt-100", 100, "round_trip"),
      candidate("rt-101", 101, "round_trip"),
      candidate("rt-102", 102, "round_trip"),
      candidate("mc-900", 900, "multi_city"),
    ];
    const result = buildShortlist(withThree, { request: everything, limit: 2 });
    // Both eligible patterns survive, even though multi-city is far dearer.
    expect([...result.patterns].sort()).toEqual(["multi_city", "round_trip"]);
    expect(result.dropped).toEqual([]);
  });

  it("never lets one reserved pattern displace another", () => {
    const result = buildShortlist(pool, { request: everything, limit: 2 });
    expect(ids(result.selected)).toEqual(["rt-120", "mc-160"]);
    expect([...result.patterns].sort()).toEqual(["multi_city", "round_trip"]);
  });

  it("leaves a pattern with no eligible candidate simply absent", () => {
    const result = buildShortlist([candidate("rt-120", 120, "round_trip")], {
      request: everything,
      limit: 4,
    });
    expect(result.patterns).toEqual(["round_trip"]);
    expect(result.dropped).toEqual([]);
  });

  it("ignores a pattern the request did not enable", () => {
    // Multi-city is not permitted, so it reserves nothing even though a
    // candidate of that shape exists.
    const result = buildShortlist(pool, { request: request(), limit: 2 });
    expect(result.patterns).toEqual(["round_trip"]);
    expect(ids(result.selected)).toEqual(["rt-120", "rt-125"]);
  });
});

describe("a shortlist too small for the floor", () => {
  const pool = [
    candidate("rt-120", 120, "round_trip"),
    candidate("mc-160", 160, "multi_city"),
  ];

  it("holds the floor exactly when the limit equals the pattern count", () => {
    const result = buildShortlist(pool, { request: everything, limit: 2 });
    expect([...result.patterns].sort()).toEqual(["multi_city", "round_trip"]);
    expect(result.dropped).toEqual([]);
  });

  it("keeps the cheapest reservations and says which patterns that cost", () => {
    const result = buildShortlist(pool, { request: everything, limit: 1 });
    expect(ids(result.selected)).toEqual(["rt-120"]);
    expect(result.dropped).toEqual([
      { pattern: "multi_city", reason: "shortlist_too_small" },
    ]);
  });

  it("selects nothing when there is no room at all", () => {
    const result = buildShortlist(pool, { request: everything, limit: 0 });
    expect(result.selected).toEqual([]);
    expect([...result.dropped].map((entry) => entry.pattern).sort()).toEqual([
      "multi_city",
      "round_trip",
    ]);
  });
});

describe("determinism", () => {
  const pool = [
    candidate("mc-170", 170, "multi_city"),
    candidate("rt-125", 125, "round_trip"),
    candidate("mc-160", 160, "multi_city"),
    candidate("rt-120", 120, "round_trip"),
  ];

  it("gives the same answer however the candidates arrived", () => {
    const forwards = buildShortlist(pool, { request: everything, limit: 3 });
    const backwards = buildShortlist([...pool].reverse(), { request: everything, limit: 3 });
    expect(ids(forwards.selected)).toEqual(ids(backwards.selected));
  });

  it("breaks a price tie by candidate id, not arrival order", () => {
    const tied = [
      candidate("b-rt", 120, "round_trip"),
      candidate("a-rt", 120, "round_trip"),
    ];
    expect(ids(buildShortlist(tied, { request: everything, limit: 1 }).selected)).toEqual([
      "a-rt",
    ]);
    expect(
      ids(buildShortlist([...tied].reverse(), { request: everything, limit: 1 }).selected),
    ).toEqual(["a-rt"]);
  });

  it("reserves one slot per pattern, never two for the same candidate", () => {
    const result = buildShortlist(pool, { request: everything, limit: 4 });
    const selected = ids(result.selected);
    expect(new Set(selected).size).toBe(selected.length);
    // Every selected candidate has exactly one pattern, so a slot is never
    // consumed twice by one trip.
    expect(result.selected.map(transportPattern)).toHaveLength(selected.length);
  });
});
