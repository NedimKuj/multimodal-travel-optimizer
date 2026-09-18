import type { Location } from "../location.js";
import type { AirportGeography, NearbyAirport } from "../ports/reference-data.js";
import { parseUtcInstant } from "../time/zoned-timestamp.js";

/**
 * In-memory geography for tests.
 *
 * Distances are supplied explicitly rather than computed, so a test states the
 * geography it means instead of depending on real coordinates.
 */
export function inMemoryAirportGeography(
  /** Distances in kilometres, keyed `fromLocationId -> toLocationId`. */
  distances: Readonly<Record<string, Readonly<Record<string, number>>>>,
  airportsById: Readonly<Record<string, Location>>,
): AirportGeography {
  const distanceBetween = (from: Location, to: Location): number =>
    distances[from.id]?.[to.id] ?? distances[to.id]?.[from.id] ?? Number.POSITIVE_INFINITY;

  return {
    provenance: {
      source: "test-fixture",
      fetchedAt: parseUtcInstant("2026-09-18T08:00:00Z"),
      recordCount: Object.keys(airportsById).length,
    },
    distanceBetween,
    findNearby: (center, radiusKm) => {
      const nearby: NearbyAirport[] = [];
      for (const airport of Object.values(airportsById)) {
        if (airport.id === center.id) continue;
        const distanceKm = distanceBetween(center, airport);
        if (distanceKm <= radiusKm) nearby.push({ airport, distanceKm });
      }
      return nearby.sort(
        (a, b) =>
          a.distanceKm - b.distanceKm ||
          (a.airport.iata ?? a.airport.id).localeCompare(b.airport.iata ?? b.airport.id),
      );
    },
  };
}
