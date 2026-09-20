import { parseUtcInstant, type TransportSegment } from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import { deriveStayIntervals } from "./accommodation-stays.js";
import { DEFAULT_CONNECTION_RULES } from "./connection-rules.js";
import { assembleCandidate, type CandidateContext } from "./flight-exploration.js";
import { DEFAULT_GROUND_TRANSFER_CONFIG } from "./ground-transfer.js";
import { resolveTravelWindow } from "./travel-window.js";
import {
  cityRepository,
  CIA,
  FCO,
  fixtureGeography,
  MXP,
  offer,
  request,
  segment,
  SJJ,
} from "./test-fixtures.js";

/*
 * Stay intervals come from the junctions assembly already computed (ADR 0016).
 * Fares here are test inputs, and no test touches the network.
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

function assemble(legs: readonly TransportSegment[], overrides: Record<string, unknown> = {}) {
  const outcome = assembleCandidate({
    id: `trip:${legs.map((leg) => leg.id).join("+")}`,
    legs,
    offers: legs.map((leg, index) => offer(`fare-${leg.id}`, [leg.id], 3000 + index * 100)),
    request: request(overrides),
    window: windowFor(overrides),
    context,
  });
  if (!outcome.ok) throw new Error(`assembly failed: ${outcome.counter}`);
  return outcome.attempt;
}

/** Ciampino is close to Rome; Malpensa is 50 km from Milan. */
const toRome = segment({
  id: "out-cia",
  origin: SJJ,
  destination: CIA,
  departure: "2026-12-27T10:00+01:00",
  arrival: "2026-12-27T11:30+01:00",
});
const homeFromRome = segment({
  id: "home-cia",
  origin: CIA,
  destination: SJJ,
  departure: "2027-01-02T18:00+01:00",
  arrival: "2027-01-02T19:30+01:00",
});
const toMilan = segment({
  id: "out-mxp",
  origin: SJJ,
  destination: MXP,
  departure: "2026-12-27T10:00+01:00",
  arrival: "2026-12-27T11:30+01:00",
});
const homeFromMilan = segment({
  id: "home-mxp",
  origin: MXP,
  destination: SJJ,
  departure: "2027-01-02T18:00+01:00",
  arrival: "2027-01-02T19:45+01:00",
});
const romeToMilan = segment({
  id: "cia-mxp",
  origin: CIA,
  destination: MXP,
  departure: "2026-12-30T10:00+01:00",
  arrival: "2026-12-30T11:15+01:00",
});

describe("deriveStayIntervals", () => {
  it("gives a single-city trip one stay, named by its city", () => {
    const { stayIntervals } = assemble([toRome, homeFromRome]);
    expect(stayIntervals).toHaveLength(1);
    expect(stayIntervals[0]).toMatchObject({
      checkIn: "2026-12-27",
      checkOut: "2027-01-02",
      nights: 6,
      unresolved: false,
    });
    expect(stayIntervals[0]?.cities.map((city) => city.name)).toEqual(["Rome"]);
  });

  it("gives a multi-city trip one stay per city", () => {
    const { stayIntervals } = assemble([toRome, romeToMilan, homeFromMilan]);
    expect(stayIntervals.map((entry) => entry.cities[0]?.name)).toEqual(["Rome", "Milan"]);
    expect(stayIntervals.map((entry) => entry.nights)).toEqual([3, 3]);
    expect(stayIntervals.every((entry) => !entry.unresolved)).toBe(true);
  });

  it("starts the stay when the transfer lands, not when the flight does", () => {
    // Malpensa is 50 km out, so the traveler reaches Milan later than MXP.
    const { stayIntervals } = assemble([toMilan, homeFromMilan]);
    const [milan] = stayIntervals;
    expect(milan?.cities[0]?.name).toBe("Milan");
    // Arrives 11:30, rides in, and leaves the city before the 18:00 departure.
    expect(milan).toMatchObject({ checkIn: "2026-12-27", checkOut: "2027-01-02", nights: 6 });
  });

  it("names every city an unresolved stay spans", () => {
    const { stayIntervals } = assemble([toMilan, homeFromRome], { allowOpenJaw: true });
    expect(stayIntervals).toHaveLength(1);
    expect(stayIntervals[0]?.unresolved).toBe(true);
    expect(stayIntervals[0]?.cities.map((city) => city.name)).toEqual(["Milan", "Rome"]);
  });

  it("resolves an open jaw between two airports of one city", () => {
    // Fiumicino out, Ciampino home: two airports, one Rome. The nights belong
    // to Rome unambiguously, so nothing is unresolved.
    const intoFco = segment({
      id: "out-fco",
      origin: SJJ,
      destination: FCO,
      departure: "2026-12-27T10:00+01:00",
      arrival: "2026-12-27T11:30+01:00",
    });
    const { stayIntervals } = assemble([intoFco, homeFromRome], { allowOpenJaw: true });
    expect(stayIntervals[0]?.cities.map((city) => city.name)).toEqual(["Rome"]);
    expect(stayIntervals[0]?.unresolved).toBe(false);
  });

  it("produces nothing for a junction with no nights", () => {
    expect(deriveStayIntervals([], [], cityRepository)).toEqual([]);
  });

  it("skips a junction the trip only connects through", () => {
    // Same two junctions, but the first has no nights: a connection, governed
    // by minimum connection times, not a destination needing a bed.
    const intervals = deriveStayIntervals(
      [
        { reached: toRome, left: romeToMilan, place: CIA },
        { reached: romeToMilan, left: homeFromMilan, place: MXP },
      ],
      [0, 3],
      cityRepository,
    );
    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toMatchObject({ nights: 3 });
    expect(intervals[0]?.cities[0]?.name).toBe("Milan");
  });
});
