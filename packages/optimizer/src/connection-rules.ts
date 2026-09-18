import {
  minutesBetween,
  type DomainIssue,
  type Location,
  type TransportSegment,
} from "@travel-optimizer/domain";

/*
 * Minimum connection times (ADR 0012, spec §12).
 *
 * Our segments are separately sold journeys, so a connection is the traveler
 * changing between them: deplaning, bags, a new check-in. Times are compared as
 * absolute instants, never local clocks, so a connection across a time-zone or
 * DST boundary is judged correctly.
 */

export interface ConnectionRules {
  readonly airportToAirportMinutes: number;
  readonly airportToStationMinutes: number;
  readonly sameStationMinutes: number;
  readonly stationToStationMinutes: number;
  /**
   * A gap longer than this is a stay, not a connection, and is governed by
   * nights and accommodation instead.
   */
  readonly maxConnectionGapMinutes: number;
}

/** Spec §12's initial values. Configurable, not immutable. */
export const DEFAULT_CONNECTION_RULES: ConnectionRules = {
  airportToAirportMinutes: 120,
  airportToStationMinutes: 150,
  sameStationMinutes: 15,
  stationToStationMinutes: 30,
  maxConnectionGapMinutes: 12 * 60,
};

/** Cities are treated as stations: they only appear as transfer endpoints. */
function nodeClass(location: Location): "airport" | "station" {
  return location.type === "airport" ? "airport" : "station";
}

export type RequiredConnection =
  | { readonly ok: true; readonly minutes: number }
  | { readonly ok: false; readonly reason: string };

/** Minimum minutes a traveler needs between arriving at `from` and leaving `to`. */
export function requiredConnectionMinutes(
  from: Location,
  to: Location,
  rules: ConnectionRules = DEFAULT_CONNECTION_RULES,
): RequiredConnection {
  const fromClass = nodeClass(from);
  const toClass = nodeClass(to);

  if (fromClass === "airport" && toClass === "airport") {
    return { ok: true, minutes: rules.airportToAirportMinutes };
  }
  if (fromClass !== toClass) {
    return { ok: true, minutes: rules.airportToStationMinutes };
  }
  if (fromClass === "station" && toClass === "station") {
    return {
      ok: true,
      minutes: from.id === to.id ? rules.sameStationMinutes : rules.stationToStationMinutes,
    };
  }
  // Unreachable with today's location types; rejected rather than defaulted.
  return { ok: false, reason: `No connection rule for ${from.type} → ${to.type}` };
}

export interface ConnectionCheck {
  readonly fromSegmentId: string;
  readonly toSegmentId: string;
  readonly availableMinutes: number;
  readonly requiredMinutes: number;
}

export type ConnectionValidation =
  | { readonly ok: true; readonly connections: readonly ConnectionCheck[] }
  | { readonly ok: false; readonly issues: readonly DomainIssue[] };

/**
 * Checks every consecutive pair of segments a traveler connects between.
 *
 * A gap longer than `maxConnectionGapMinutes` is treated as time on the
 * ground, not a connection, and is left to the nights and accommodation rules.
 */
export function validateConnections(
  segments: readonly TransportSegment[],
  rules: ConnectionRules = DEFAULT_CONNECTION_RULES,
): ConnectionValidation {
  const issues: DomainIssue[] = [];
  const connections: ConnectionCheck[] = [];

  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1];
    const next = segments[index];
    if (previous === undefined || next === undefined) continue;

    const availableMinutes = minutesBetween(previous.arrivalAt, next.departureAt);
    if (availableMinutes > rules.maxConnectionGapMinutes) continue;

    const required = requiredConnectionMinutes(previous.destination, next.origin, rules);
    if (!required.ok) {
      issues.push({
        code: "UNCLASSIFIED_CONNECTION",
        message: `${previous.id} → ${next.id}: ${required.reason}`,
      });
      continue;
    }

    connections.push({
      fromSegmentId: previous.id,
      toSegmentId: next.id,
      availableMinutes,
      requiredMinutes: required.minutes,
    });

    if (availableMinutes < required.minutes) {
      issues.push({
        code: "CONNECTION_TOO_SHORT",
        message:
          `${previous.id} → ${next.id}: ${String(Math.round(availableMinutes))} minutes available at ` +
          `${next.origin.iata ?? next.origin.id}, ${String(required.minutes)} required`,
      });
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, connections };
}
