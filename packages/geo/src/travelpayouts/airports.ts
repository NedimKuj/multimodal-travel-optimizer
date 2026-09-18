import {
  locationSchema,
  type AirportRepository,
  type Location,
  type ReferenceDataIssue,
  type ReferenceDataProvenance,
} from "@travel-optimizer/domain";
import { z } from "zod";

/**
 * Travelpayouts published airport dataset (`/data/<locale>/airports.json`).
 *
 * Schema derived from the live file observed on 2026-09-18: 10,377 records,
 * every one carrying an IANA `time_zone` and coordinates. Unknown or new fields
 * are ignored; records we cannot use are reported as issues, never guessed at.
 *
 * This is the initial reference source, not a permanent dependency: consumers
 * use the `AirportRepository` port and never this schema
 * (docs/decisions/0007-airport-reference-data.md).
 */
export const travelpayoutsAirportRecordSchema = z.object({
  code: z.string(),
  name: z.string().nullable().optional(),
  name_translations: z.object({ en: z.string().min(1).optional() }).optional(),
  city_code: z.string().optional(),
  country_code: z.string(),
  time_zone: z.string(),
  iata_type: z.string(),
  coordinates: z.object({ lat: z.number().nullable(), lon: z.number().nullable() }),
  flightable: z.boolean().optional(),
});

export type TravelpayoutsAirportRecord = z.infer<typeof travelpayoutsAirportRecordSchema>;

/**
 * IATA place types we can represent. `harbour` has no domain equivalent, so
 * those records are skipped and counted rather than forced into a type.
 */
const LOCATION_TYPE_BY_IATA_TYPE: Readonly<Record<string, Location["type"]>> = {
  airport: "airport",
  heliport: "airport",
  railway: "station",
  bus: "station",
};

export type RecordConversion =
  | { readonly ok: true; readonly location: Location }
  | { readonly ok: false; readonly issue: ReferenceDataIssue };

function skip(code: string, reason: string, issueCode: string): RecordConversion {
  return { ok: false, issue: { code: issueCode, message: `${code}: ${reason}`, iata: code } };
}

/** Converts one dataset record into a domain Location, or explains why it cannot. */
export function toLocation(input: unknown): RecordConversion {
  const parsed = travelpayoutsAirportRecordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issue: {
        code: "MALFORMED_AIRPORT_RECORD",
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
      },
    };
  }
  const record = parsed.data;
  const type = LOCATION_TYPE_BY_IATA_TYPE[record.iata_type];
  if (type === undefined) {
    return skip(record.code, `unsupported iata_type ${record.iata_type}`, "UNSUPPORTED_PLACE_TYPE");
  }
  const name = record.name_translations?.en ?? record.name;
  if (name === undefined || name === null || name.trim() === "") {
    return skip(record.code, "no usable name", "MISSING_AIRPORT_NAME");
  }
  const { lat, lon } = record.coordinates;
  if (lat === null || lon === null) {
    return skip(record.code, "no coordinates", "MISSING_COORDINATES");
  }

  const location = locationSchema.safeParse({
    id: `${type}:${record.code}`,
    type,
    name,
    countryCode: record.country_code,
    latitude: lat,
    longitude: lon,
    timeZone: record.time_zone,
    iata: record.code,
  });
  if (!location.success) {
    // Non-IATA codes (the dataset contains a few Cyrillic ones) and any other
    // record the domain rejects land here.
    return skip(
      record.code,
      location.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; "),
      "AIRPORT_RECORD_REJECTED_BY_DOMAIN",
    );
  }
  return { ok: true, location: location.data };
}

export interface AirportRepositoryBuild {
  readonly repository: AirportRepository;
  /** Records that could not be used, one issue each. */
  readonly issues: readonly ReferenceDataIssue[];
  readonly accepted: number;
}

/**
 * Builds a repository from raw dataset records.
 *
 * `provenance.recordCount` is the number of usable airports, so a search can
 * record exactly how much reference data it had.
 */
export function buildAirportRepository(
  records: readonly unknown[],
  provenance: Omit<ReferenceDataProvenance, "recordCount">,
): AirportRepositoryBuild {
  const byIata = new Map<string, Location>();
  const issues: ReferenceDataIssue[] = [];

  for (const record of records) {
    const conversion = toLocation(record);
    if (!conversion.ok) {
      issues.push(conversion.issue);
      continue;
    }
    const { location } = conversion;
    if (location.iata === undefined) continue;
    const existing = byIata.get(location.iata);
    if (existing !== undefined) {
      issues.push({
        code: "DUPLICATE_IATA_CODE",
        message: `${location.iata} appears more than once; keeping ${existing.id}`,
        iata: location.iata,
      });
      continue;
    }
    byIata.set(location.iata, location);
  }

  return {
    repository: {
      provenance: { ...provenance, recordCount: byIata.size },
      findByIata: (iata) => byIata.get(iata),
    },
    issues,
    accepted: byIata.size,
  };
}
