import { parseUtcInstant, type TransportSegment } from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import { DEFAULT_CONNECTION_RULES } from "./connection-rules.js";
import { assembleCandidate, type CandidateContext } from "./flight-exploration.js";
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

/*
 * Assembly over any number of legs (Phase 3b).
 *
 * Two legs is a round trip, three a multi-city trip, and the same rules apply
 * to both. Fares here are test inputs, and no test touches the network.
 */

const context: CandidateContext = {
  requestedOrigin: SJJ,
  cities: cityRepository,
  geography: fixtureGeography,
  connectionRules: DEFAULT_CONNECTION_RULES,
  groundTransfer: DEFAULT_GROUND_TRANSFER_CONFIG,
  fetchedAt: parseUtcInstant("2026-09-18T09:00:00Z"),
};

function windowFor(overrides: Record<string, unknown> = {}) {
  const result = resolveTravelWindow(request(overrides));
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.code).join("; "));
  return result.window;
}

/** Ciampino is close to Rome, so these legs carry no access transfers. */
const outbound = segment({
  id: "out",
  origin: SJJ,
  destination: CIA,
  departure: "2026-12-27T10:00+01:00",
  arrival: "2026-12-27T11:30+01:00",
});
const onward = segment({
  id: "onward",
  origin: CIA,
  destination: MXP,
  departure: "2026-12-30T10:00+01:00",
  arrival: "2026-12-30T11:15+01:00",
});
const homeFromMilan = segment({
  id: "home-mxp",
  origin: MXP,
  destination: SJJ,
  departure: "2027-01-01T18:00+01:00",
  arrival: "2027-01-01T19:45+01:00",
});
const homeFromRome = segment({
  id: "home-cia",
  origin: CIA,
  destination: SJJ,
  departure: "2027-01-01T18:00+01:00",
  arrival: "2027-01-01T19:30+01:00",
});

function assemble(legs: readonly TransportSegment[], overrides: Record<string, unknown> = {}) {
  return assembleCandidate({
    id: `trip:${legs.map((leg) => leg.id).join("+")}`,
    legs,
    offers: legs.map((leg, index) => offer(`fare-${leg.id}`, [leg.id], 3000 + index * 100)),
    gaps: [],
    request: request(overrides),
    window: windowFor(overrides),
    context,
  });
}

describe("assembleCandidate — leg counts", () => {
  it("builds a round trip from two legs", () => {
    const outcome = assemble([outbound, homeFromRome]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.attempt.candidate.segments).toHaveLength(2);
    expect(outcome.attempt.nightsByStay).toEqual([5]);
    expect(outcome.attempt.destinationAirports.map((a) => a.iata)).toEqual(["CIA"]);
  });

  it("builds a multi-city trip from three legs", () => {
    const outcome = assemble([outbound, onward, homeFromMilan]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Rome 27–30 Dec, Milan 30 Dec–1 Jan: 3 + 2 nights.
    expect(outcome.attempt.nightsByStay).toEqual([3, 2]);
    expect(outcome.attempt.nights).toBe(5);
    expect(outcome.attempt.destinationAirports.map((a) => a.iata)).toEqual(["CIA", "MXP"]);
  });

  it("builds a four-leg trip, reporting every place it stops", () => {
    const first = segment({
      id: "a",
      origin: SJJ,
      destination: CIA,
      departure: "2026-12-26T08:00+01:00",
      arrival: "2026-12-26T09:30+01:00",
    });
    const second = segment({
      id: "b",
      origin: CIA,
      destination: MXP,
      departure: "2026-12-28T08:00+01:00",
      arrival: "2026-12-28T09:15+01:00",
    });
    const third = segment({
      id: "c",
      origin: MXP,
      destination: CIA,
      departure: "2026-12-30T08:00+01:00",
      arrival: "2026-12-30T09:15+01:00",
    });
    const fourth = segment({
      id: "d",
      origin: CIA,
      destination: SJJ,
      departure: "2027-01-01T18:00+01:00",
      arrival: "2027-01-01T19:30+01:00",
    });
    const outcome = assemble([first, second, third, fourth]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.attempt.nightsByStay).toEqual([2, 2, 2]);
    expect(outcome.attempt.destinationAirports.map((a) => a.iata)).toEqual(["CIA", "MXP", "CIA"]);
  });

  it("refuses fewer than two legs", () => {
    const outcome = assemble([outbound]);
    expect(outcome).toEqual({ ok: false, counter: "rejectedInvalid" });
  });
});

describe("assembleCandidate — temporal chaining", () => {
  it("rejects a leg that leaves before the one before it lands", () => {
    const tooEarly = segment({
      id: "home-early",
      origin: CIA,
      destination: SJJ,
      departure: "2026-12-27T09:00+01:00",
      arrival: "2026-12-27T10:30+01:00",
    });
    expect(assemble([outbound, tooEarly])).toEqual({
      ok: false,
      counter: "rejectedReturnBeforeArrival",
    });
  });

  it("names the real reason rather than blaming the itinerary's shape", () => {
    // The onward leg leaves Rome before the outbound has landed there. Sorting
    // by time would put it first and break the chain spatially, so without the
    // temporal check this would surface as an unexplained discontinuity.
    const earlyOnward = segment({
      id: "onward-early",
      origin: CIA,
      destination: MXP,
      departure: "2026-12-27T06:00+01:00",
      arrival: "2026-12-27T07:15+01:00",
    });
    const outcome = assemble([outbound, earlyOnward, homeFromMilan]);
    expect(outcome).toEqual({ ok: false, counter: "rejectedReturnBeforeArrival" });
  });

  it("checks every junction, not only the first", () => {
    const backwardsHome = segment({
      id: "home-backwards",
      origin: MXP,
      destination: SJJ,
      departure: "2026-12-29T18:00+01:00",
      arrival: "2026-12-29T19:45+01:00",
    });
    expect(assemble([outbound, onward, backwardsHome])).toEqual({
      ok: false,
      counter: "rejectedReturnBeforeArrival",
    });
  });
});
