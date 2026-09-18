import type { Location } from "../location.js";
import type { AirportRepository, ReferenceDataProvenance } from "../ports/reference-data.js";
import { parseUtcInstant } from "../time/zoned-timestamp.js";

/**
 * In-memory airport repository for tests. Not a dataset: callers pass exactly
 * the airports their test needs.
 */
export function inMemoryAirportRepository(
  airports: readonly Location[],
  provenance?: Partial<ReferenceDataProvenance>,
): AirportRepository {
  const byIata = new Map<string, Location>();
  for (const airport of airports) {
    if (airport.iata !== undefined) byIata.set(airport.iata, airport);
  }
  return {
    provenance: {
      source: "test-fixture",
      fetchedAt: parseUtcInstant("2026-09-17T12:00:00Z"),
      recordCount: byIata.size,
      ...provenance,
    },
    findByIata: (iata) => byIata.get(iata),
  };
}
