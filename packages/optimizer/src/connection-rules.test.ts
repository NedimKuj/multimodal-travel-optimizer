import { locationSchema, type Location } from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONNECTION_RULES,
  requiredConnectionMinutes,
  validateConnections,
} from "./connection-rules.js";
import { FCO, SAW, segment, SJJ } from "./test-fixtures.js";

function station(code: string, name: string): Location {
  return locationSchema.parse({
    id: `station:${code}`,
    type: "station",
    name,
    countryCode: "IT",
    latitude: 41.9,
    longitude: 12.5,
    timeZone: "Europe/Rome",
    iata: code,
  });
}

const ROMA_TERMINI = station("XRJ", "Roma Termini");
const ROMA_TIBURTINA = station("XRT", "Roma Tiburtina");

describe("requiredConnectionMinutes", () => {
  it("applies spec §12's table", () => {
    expect(requiredConnectionMinutes(FCO, SAW)).toEqual({ ok: true, minutes: 120 });
    expect(requiredConnectionMinutes(FCO, ROMA_TERMINI)).toEqual({ ok: true, minutes: 150 });
    expect(requiredConnectionMinutes(ROMA_TERMINI, FCO)).toEqual({ ok: true, minutes: 150 });
    expect(requiredConnectionMinutes(ROMA_TERMINI, ROMA_TIBURTINA)).toEqual({
      ok: true,
      minutes: 30,
    });
    expect(requiredConnectionMinutes(ROMA_TERMINI, ROMA_TERMINI)).toEqual({ ok: true, minutes: 15 });
  });

  it("treats two flights at the same airport as an airport connection", () => {
    // Separately sold journeys: bags and a new check-in, not a through ticket.
    expect(requiredConnectionMinutes(FCO, FCO)).toEqual({ ok: true, minutes: 120 });
  });

  it("treats a city as a station", () => {
    const rome = locationSchema.parse({
      id: "city:ROM",
      type: "city",
      name: "Rome",
      countryCode: "IT",
      latitude: 41.9,
      longitude: 12.5,
      timeZone: "Europe/Rome",
    });
    expect(requiredConnectionMinutes(rome, FCO)).toEqual({ ok: true, minutes: 150 });
    expect(requiredConnectionMinutes(rome, ROMA_TERMINI)).toEqual({ ok: true, minutes: 30 });
  });

  it("treats stepping off a flight onto a transfer as deplaning, not a check-in", () => {
    expect(
      requiredConnectionMinutes(FCO, FCO, DEFAULT_CONNECTION_RULES, {
        arrivingBy: "flight",
        departingBy: "ground_transfer",
      }),
    ).toEqual({ ok: true, minutes: 45 });
  });

  it("still requires check-in time when a transfer feeds a flight", () => {
    expect(
      requiredConnectionMinutes(FCO, FCO, DEFAULT_CONNECTION_RULES, {
        arrivingBy: "ground_transfer",
        departingBy: "flight",
      }),
    ).toEqual({ ok: true, minutes: 120 });
  });

  it("honours a tightened configuration", () => {
    const rules = { ...DEFAULT_CONNECTION_RULES, airportToAirportMinutes: 90 };
    expect(requiredConnectionMinutes(FCO, SAW, rules)).toEqual({ ok: true, minutes: 90 });
  });
});

describe("validateConnections", () => {
  const arrival = segment({
    id: "seg-in",
    origin: SJJ,
    destination: FCO,
    departure: "2026-12-27T08:00+01:00",
    arrival: "2026-12-27T09:30+01:00",
  });

  function onward(departure: string) {
    return segment({
      id: "seg-out",
      origin: FCO,
      destination: SAW,
      departure,
      arrival: "2026-12-27T23:00+03:00",
    });
  }

  it("accepts a connection exactly at the minimum", () => {
    // Lands 09:30, leaves 11:30: exactly 120 minutes.
    const result = validateConnections([arrival, onward("2026-12-27T11:30+01:00")]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid");
    expect(result.connections[0]).toMatchObject({ availableMinutes: 120, requiredMinutes: 120 });
  });

  it("rejects a connection one minute short", () => {
    const result = validateConnections([arrival, onward("2026-12-27T11:29+01:00")]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected issues");
    expect(result.issues[0]?.code).toBe("CONNECTION_TOO_SHORT");
    expect(result.issues[0]?.message).toContain("119 minutes available at FCO");
  });

  it("measures across time zones on instants, not clocks", () => {
    // Lands Istanbul 12:00+03:00 (09:00Z); next leaves Rome 10:30+01:00 (09:30Z):
    // only 30 real minutes, even though the local clocks look hours apart.
    const intoIstanbul = segment({
      id: "seg-ist",
      origin: SJJ,
      destination: SAW,
      departure: "2026-12-27T08:00+01:00",
      arrival: "2026-12-27T12:00+03:00",
    });
    const outOfIstanbul = segment({
      id: "seg-rome",
      origin: SAW,
      destination: FCO,
      departure: "2026-12-27T12:30+03:00",
      arrival: "2026-12-27T14:00+01:00",
    });
    const result = validateConnections([intoIstanbul, outOfIstanbul]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected issues");
    expect(result.issues[0]?.message).toContain("30 minutes available");
  });

  it("treats a long gap as a stay rather than a connection", () => {
    // A week at the destination is not a missed connection.
    const returnLeg = segment({
      id: "seg-return",
      origin: FCO,
      destination: SJJ,
      departure: "2027-01-02T18:00+01:00",
      arrival: "2027-01-02T19:30+01:00",
    });
    const result = validateConnections([arrival, returnLeg]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected valid");
    expect(result.connections).toEqual([]);
  });

  it("accepts a single segment and an empty itinerary", () => {
    expect(validateConnections([arrival]).ok).toBe(true);
    expect(validateConnections([]).ok).toBe(true);
  });

  it("checks every consecutive pair, reporting each failure", () => {
    const second = onward("2026-12-27T10:00+01:00");
    const third = segment({
      id: "seg-third",
      origin: SAW,
      destination: SJJ,
      departure: "2026-12-27T23:30+03:00",
      arrival: "2026-12-28T01:00+01:00",
    });
    const result = validateConnections([arrival, second, third]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected issues");
    expect(result.issues).toHaveLength(2);
  });
});
