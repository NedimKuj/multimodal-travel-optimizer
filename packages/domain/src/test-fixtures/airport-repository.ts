import type { Location } from "../location.js";
import type {
  AirportRepository,
  CityRepository,
  ReferenceDataProvenance,
} from "../ports/reference-data.js";
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

/**
 * In-memory city repository for tests. `airportToCity` maps an airport id to a
 * city code; airports missing from it have no known city.
 */
export function inMemoryCityRepository(
  cities: readonly Location[],
  airportToCity: Readonly<Record<string, string>> = {},
  provenance?: Partial<ReferenceDataProvenance>,
): CityRepository {
  const byCode = new Map(cities.map((city) => [city.id.replace(/^city:/, ""), city]));
  return {
    provenance: {
      source: "test-fixture",
      fetchedAt: parseUtcInstant("2026-09-17T12:00:00Z"),
      recordCount: byCode.size,
      ...provenance,
    },
    findByCode: (code) => byCode.get(code),
    findForAirport: (airport) => {
      const code = airportToCity[airport.id];
      return code === undefined ? undefined : byCode.get(code);
    },
  };
}
