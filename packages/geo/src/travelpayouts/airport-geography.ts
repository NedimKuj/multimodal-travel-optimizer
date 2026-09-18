import type {
  AirportGeography,
  Location,
  NearbyAirport,
  ReferenceDataIssue,
  ReferenceDataProvenance,
} from "@travel-optimizer/domain";

import { distanceKm } from "../distance.js";
import { toLocation, travelpayoutsAirportRecordSchema } from "./airports.js";

/**
 * Spatial index over the airport snapshot.
 *
 * Only airports the dataset marks `flightable` are offered as neighbours: an
 * airport with no scheduled service is not an alternative, whatever its
 * distance. The flag is read here rather than carried on `Location`, because it
 * is a property of the dataset, not of the place.
 */

export interface AirportGeographyBuild {
  readonly geography: AirportGeography;
  readonly issues: readonly ReferenceDataIssue[];
  /** Airports usable as neighbours (flightable and representable). */
  readonly flightable: number;
}

export function buildAirportGeography(
  records: readonly unknown[],
  provenance: Omit<ReferenceDataProvenance, "recordCount">,
): AirportGeographyBuild {
  const flightable: Location[] = [];
  const issues: ReferenceDataIssue[] = [];

  for (const record of records) {
    const parsed = travelpayoutsAirportRecordSchema.safeParse(record);
    if (!parsed.success) continue;
    // `flightable: false` means no scheduled service; absent means unknown, and
    // an unknown airport is not offered as an alternative either.
    if (parsed.data.flightable !== true) continue;

    const conversion = toLocation(record);
    if (!conversion.ok) {
      issues.push(conversion.issue);
      continue;
    }
    if (conversion.location.type !== "airport") continue;
    flightable.push(conversion.location);
  }

  return {
    geography: {
      provenance: { ...provenance, recordCount: flightable.length },
      distanceBetween: (from, to) => distanceKm(from, to),
      findNearby: (center, radiusKm) => {
        const nearby: NearbyAirport[] = [];
        for (const airport of flightable) {
          if (airport.id === center.id) continue;
          const distance = distanceKm(center, airport);
          if (distance <= radiusKm) nearby.push({ airport, distanceKm: distance });
        }
        // Nearest first, then IATA: a stable order makes searches reproducible.
        return nearby.sort(
          (a, b) =>
            a.distanceKm - b.distanceKm ||
            (a.airport.iata ?? a.airport.id).localeCompare(b.airport.iata ?? b.airport.id),
        );
      },
    },
    issues,
    flightable: flightable.length,
  };
}
