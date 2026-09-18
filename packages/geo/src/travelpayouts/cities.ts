import {
  locationSchema,
  type CityRepository,
  type Location,
  type ReferenceDataIssue,
  type ReferenceDataProvenance,
} from "@travel-optimizer/domain";
import { z } from "zod";

import { travelpayoutsAirportRecordSchema } from "./airports.js";

/**
 * Travelpayouts published city dataset (`/data/<locale>/cities.json`).
 *
 * Schema derived from the live file observed on 2026-09-18: 9,652 records, all
 * carrying an IANA `time_zone` and coordinates, and every airport in the
 * airports file resolves to one of them through `city_code`.
 *
 * Cities are what a traveler picks as a destination; itineraries are still
 * built from airports (docs/decisions/0010-city-destinations.md).
 */
export const travelpayoutsCityRecordSchema = z.object({
  code: z.string(),
  name: z.string().nullable().optional(),
  name_translations: z.object({ en: z.string().min(1).optional() }).optional(),
  country_code: z.string(),
  time_zone: z.string(),
  coordinates: z.object({ lat: z.number().nullable(), lon: z.number().nullable() }),
  has_flightable_airport: z.boolean().optional(),
});

export type TravelpayoutsCityRecord = z.infer<typeof travelpayoutsCityRecordSchema>;

export type CityConversion =
  | { readonly ok: true; readonly city: Location }
  | { readonly ok: false; readonly issue: ReferenceDataIssue };

function skip(code: string, reason: string, issueCode: string): CityConversion {
  return { ok: false, issue: { code: issueCode, message: `${code}: ${reason}`, iata: code } };
}

/** Converts one city record into a domain Location, or explains why it cannot. */
export function toCity(input: unknown): CityConversion {
  const parsed = travelpayoutsCityRecordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issue: {
        code: "MALFORMED_CITY_RECORD",
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
      },
    };
  }
  const record = parsed.data;
  const name = record.name_translations?.en ?? record.name;
  if (name === undefined || name === null || name.trim() === "") {
    return skip(record.code, "no usable name", "MISSING_CITY_NAME");
  }
  const { lat, lon } = record.coordinates;
  if (lat === null || lon === null) {
    return skip(record.code, "no coordinates", "MISSING_COORDINATES");
  }

  const city = locationSchema.safeParse({
    id: `city:${record.code}`,
    type: "city",
    name,
    countryCode: record.country_code,
    latitude: lat,
    longitude: lon,
    timeZone: record.time_zone,
    // City codes in this dataset are IATA metropolitan codes (ROM, NYC).
    iata: record.code,
  });
  if (!city.success) {
    return skip(
      record.code,
      city.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; "),
      "CITY_RECORD_REJECTED_BY_DOMAIN",
    );
  }
  return { ok: true, city: city.data };
}

export interface CityRepositoryBuild {
  readonly repository: CityRepository;
  readonly issues: readonly ReferenceDataIssue[];
  readonly accepted: number;
  /** Airports that could not be mapped to a city. */
  readonly unmappedAirports: number;
}

export interface CityRepositoryInput {
  readonly cities: readonly unknown[];
  /** Raw airport records, used only for the airport → city index. */
  readonly airports: readonly unknown[];
}

/**
 * Builds a city repository plus the airport → city index.
 *
 * The index is keyed by airport IATA code rather than by our location id, so it
 * does not depend on how airport ids are spelled.
 */
export function buildCityRepository(
  input: CityRepositoryInput,
  provenance: Omit<ReferenceDataProvenance, "recordCount">,
): CityRepositoryBuild {
  const byCode = new Map<string, Location>();
  const issues: ReferenceDataIssue[] = [];

  for (const record of input.cities) {
    const conversion = toCity(record);
    if (!conversion.ok) {
      issues.push(conversion.issue);
      continue;
    }
    const code = conversion.city.iata;
    if (code === undefined) continue;
    if (byCode.has(code)) {
      issues.push({
        code: "DUPLICATE_CITY_CODE",
        message: `${code} appears more than once`,
        iata: code,
      });
      continue;
    }
    byCode.set(code, conversion.city);
  }

  const cityCodeByAirport = new Map<string, string>();
  let unmappedAirports = 0;
  for (const record of input.airports) {
    const parsed = travelpayoutsAirportRecordSchema.safeParse(record);
    if (!parsed.success) continue;
    const { code, city_code: cityCode } = parsed.data;
    if (cityCode === undefined || !byCode.has(cityCode)) {
      unmappedAirports += 1;
      continue;
    }
    cityCodeByAirport.set(code, cityCode);
  }

  return {
    repository: {
      provenance: { ...provenance, recordCount: byCode.size },
      findByCode: (code) => byCode.get(code),
      findForAirport: (airport) => {
        if (airport.iata === undefined) return undefined;
        const cityCode = cityCodeByAirport.get(airport.iata);
        return cityCode === undefined ? undefined : byCode.get(cityCode);
      },
    },
    issues,
    accepted: byCode.size,
    unmappedAirports,
  };
}
