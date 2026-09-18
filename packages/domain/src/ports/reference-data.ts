import type { DomainIssue } from "../errors.js";
import type { Location } from "../location.js";
import type { UtcInstant } from "../time/zoned-timestamp.js";

/*
 * Reference-data ports.
 *
 * Geography is reference data, not provider data: the optimizer resolves an
 * IATA code through this port and never learns which dataset supplied it. The
 * dataset behind an implementation is replaceable.
 */

/** Where a reference dataset came from and when, for reproducibility. */
export interface ReferenceDataProvenance {
  /** Dataset source, e.g. a URL or a licensed dataset name. */
  readonly source: string;
  readonly fetchedAt: UtcInstant;
  readonly recordCount: number;
  /** Checksum of the snapshot, so a search can be tied to exact input data. */
  readonly checksum?: string;
}

/** A record that could not be used, kept as a counted issue rather than dropped. */
export interface ReferenceDataIssue extends DomainIssue {
  readonly iata?: string;
}

/**
 * Resolves airport IATA codes to normalized locations.
 *
 * Lookups are synchronous: an implementation loads its dataset once and then
 * answers from memory, so mapping a provider response never does I/O.
 */
export interface AirportRepository {
  readonly provenance: ReferenceDataProvenance;
  /** The airport for an exact, uppercase IATA code, or undefined if unknown. */
  findByIata(iata: string): Location | undefined;
}

/**
 * Resolves cities, and the city an airport belongs to.
 *
 * Destinations shown to a traveler are cities, while itineraries are built from
 * airports (docs/decisions/0010-city-destinations.md). Several airports can
 * belong to one city, so this mapping is many-to-one.
 */
export interface CityRepository {
  readonly provenance: ReferenceDataProvenance;
  /** The city for an exact, uppercase city code (e.g. `ROM`). */
  findByCode(code: string): Location | undefined;
  /** The city an airport belongs to, if the reference data knows it. */
  findForAirport(airport: Location): Location | undefined;
}

export interface NearbyAirport {
  readonly airport: Location;
  /** Great-circle distance from the point searched around, in kilometres. */
  readonly distanceKm: number;
}

/**
 * Spatial queries over the airport reference data.
 *
 * Kept separate from `AirportRepository` because it answers a different
 * question — "what else is near here?" — and because proximity alone never
 * makes two airports interchangeable: the transfer between them is part of the
 * itinerary (docs/decisions/0013-alternative-origin-expansion.md).
 */
export interface AirportGeography {
  readonly provenance: ReferenceDataProvenance;
  /**
   * Airports within `radiusKm` of `center`, excluding `center` itself.
   *
   * Ordered nearest first, then by IATA code, so a search built on this is
   * reproducible. Implementations return only airports that can actually be
   * flown from.
   */
  findNearby(center: Location, radiusKm: number): readonly NearbyAirport[];
  /** Great-circle distance between two locations, in kilometres. */
  distanceBetween(from: Location, to: Location): number;
}

export type AirportLookup =
  | { readonly ok: true; readonly airport: Location }
  | { readonly ok: false; readonly issue: ReferenceDataIssue };

export type CityLookup =
  | { readonly ok: true; readonly city: Location }
  | { readonly ok: false; readonly issue: ReferenceDataIssue };

const IATA_PATTERN = /^[A-Z]{3}$/;

/**
 * Looks up an airport, normalizing case and whitespace.
 *
 * An unknown or malformed code is a data-quality failure that the caller must
 * report. Coordinates, time zones and countries are never inferred for a code
 * the dataset does not contain.
 */
export function lookupAirport(repository: AirportRepository, iata: string): AirportLookup {
  const code = iata.trim().toUpperCase();
  if (!IATA_PATTERN.test(code)) {
    return {
      ok: false,
      issue: {
        code: "INVALID_IATA_CODE",
        message: `Not an IATA airport code: ${JSON.stringify(iata)}`,
        iata: code,
      },
    };
  }
  const airport = repository.findByIata(code);
  if (airport === undefined) {
    return {
      ok: false,
      issue: {
        code: "UNKNOWN_IATA_CODE",
        message: `No airport in the reference dataset for ${code}`,
        iata: code,
      },
    };
  }
  return { ok: true, airport };
}

/**
 * Finds the city an airport belongs to.
 *
 * An unknown mapping is a data-quality failure the caller reports and counts.
 * The candidate still stands on its airport identity: no city is invented, and
 * nothing about cost or feasibility depends on this lookup.
 */
export function lookupCityForAirport(
  repository: CityRepository,
  airport: Location,
): CityLookup {
  const city = repository.findForAirport(airport);
  if (city === undefined) {
    return {
      ok: false,
      issue: {
        code: "UNKNOWN_CITY_FOR_AIRPORT",
        message: `No city in the reference dataset for airport ${airport.id}`,
        ...(airport.iata !== undefined && { iata: airport.iata }),
      },
    };
  }
  return { ok: true, city };
}
