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

export type AirportLookup =
  | { readonly ok: true; readonly airport: Location }
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
