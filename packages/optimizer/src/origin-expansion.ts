import {
  lookupAirport,
  type AirportGeography,
  type AirportRepository,
  type DomainIssue,
  type Location,
  type SearchRequest,
} from "@travel-optimizer/domain";

/*
 * Alternative origin expansion (ADR 0013).
 *
 * Off unless the request asks for it, capped, deterministic, and bounded by the
 * provider call budget. Alternatives that do not fit are recorded as skipped
 * rather than dropped quietly, so a budget-limited search says so.
 */

export interface OriginExpansionConfig {
  readonly maxAlternativeOrigins: number;
  readonly alternativeOriginRadiusKm: number;
}

export const DEFAULT_ORIGIN_EXPANSION_CONFIG: OriginExpansionConfig = {
  maxAlternativeOrigins: 2,
  alternativeOriginRadiusKm: 150,
};

export interface SelectedOrigin {
  readonly airport: Location;
  /** Distance from the requested origin; 0 for the origin itself. */
  readonly distanceKm: number;
  readonly isPrimary: boolean;
}

export type SkipReason = "call_budget" | "cap";

export interface SkippedOrigin {
  readonly airport: Location;
  readonly distanceKm: number;
  readonly reason: SkipReason;
}

/** Alias used by the search trace, so a reader sees what it records. */
export type OriginExpansionRecord = OriginExpansion;

export interface OriginExpansion {
  readonly origins: readonly SelectedOrigin[];
  readonly skipped: readonly SkippedOrigin[];
  readonly issues: readonly DomainIssue[];
  /** Provider calls this selection is expected to cost. */
  readonly plannedCalls: number;
}

export interface ExpandOriginsInput {
  readonly request: SearchRequest;
  readonly airports: AirportRepository;
  readonly geography: AirportGeography;
  /** Calls one origin costs, from the date window. */
  readonly callsPerOrigin: number;
  /** Hard ceiling for the whole search. */
  readonly callBudget: number;
  readonly config?: OriginExpansionConfig;
}

/** Chooses which origin airports a search will query. */
export function expandOrigins(input: ExpandOriginsInput): OriginExpansion {
  const config = input.config ?? DEFAULT_ORIGIN_EXPANSION_CONFIG;

  const primaryLookup = lookupAirport(input.airports, input.request.origin);
  if (!primaryLookup.ok) {
    return { origins: [], skipped: [], issues: [primaryLookup.issue], plannedCalls: 0 };
  }
  const primary: SelectedOrigin = {
    airport: primaryLookup.airport,
    distanceKm: 0,
    isPrimary: true,
  };

  if (!input.request.alternativeAirports) {
    return { origins: [primary], skipped: [], issues: [], plannedCalls: input.callsPerOrigin };
  }

  // Already ordered by distance, then IATA, by the geography port's contract.
  const nearby = input.geography.findNearby(
    primaryLookup.airport,
    config.alternativeOriginRadiusKm,
  );
  const shortlist = nearby.slice(0, config.maxAlternativeOrigins);
  const beyondCap = nearby.slice(config.maxAlternativeOrigins);

  const origins: SelectedOrigin[] = [primary];
  const skipped: SkippedOrigin[] = beyondCap.map((entry) => ({
    airport: entry.airport,
    distanceKm: entry.distanceKm,
    reason: "cap",
  }));

  let spend = input.callsPerOrigin;
  for (const entry of shortlist) {
    if (spend + input.callsPerOrigin <= input.callBudget) {
      origins.push({ airport: entry.airport, distanceKm: entry.distanceKm, isPrimary: false });
      spend += input.callsPerOrigin;
    } else {
      skipped.push({ airport: entry.airport, distanceKm: entry.distanceKm, reason: "call_budget" });
    }
  }

  return { origins, skipped, issues: [], plannedCalls: spend };
}

/** IATA codes to query, primary first. */
export function originCodes(expansion: OriginExpansion): string[] {
  return expansion.origins.map((origin) => origin.airport.iata ?? origin.airport.id);
}
