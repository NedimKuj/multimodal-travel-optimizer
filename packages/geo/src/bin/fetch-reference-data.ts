import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { parseUtcInstant } from "@travel-optimizer/domain";

import {
  buildAirportRepository,
  buildCityRepository,
  defaultCitiesMetadataPath,
  defaultCitiesPath,
  defaultMetadataPath,
  defaultSnapshotPath,
  sha256,
  type SnapshotMetadata,
} from "../index.js";

/*
 * Fetches the Travelpayouts reference datasets into packages/geo/data/.
 *
 * The datasets stay out of version control while redistribution terms are
 * unverified (docs/provider-compliance.md); only the provenance sidecars are
 * committed. No credentials are involved: these files are public.
 */

const AIRPORTS_URL = "https://api.travelpayouts.com/data/en-GB/airports.json";
const CITIES_URL = "https://api.travelpayouts.com/data/en-GB/cities.json";

const TERMS_STATUS =
  "Redistribution terms unverified as of 2026-09-18; snapshot not committed. See docs/provider-compliance.md.";

async function fetchRecords(url: string): Promise<{ raw: string; records: unknown[] }> {
  process.stdout.write(`Fetching ${url}\n`);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status} ${response.statusText}`);
  }
  const raw = await response.text();
  const records: unknown = JSON.parse(raw);
  if (!Array.isArray(records)) {
    throw new Error(`Expected ${url} to return a JSON array`);
  }
  return { raw, records };
}

async function writeSnapshot(
  raw: string,
  snapshotPath: string,
  metadataPath: string,
  metadata: SnapshotMetadata,
): Promise<void> {
  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, raw, "utf8");
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const airports = await fetchRecords(AIRPORTS_URL);
  const cities = await fetchRecords(CITIES_URL);
  const fetchedAt = parseUtcInstant(new Date().toISOString());

  const airportBuild = buildAirportRepository(airports.records, {
    source: AIRPORTS_URL,
    fetchedAt,
  });
  const cityBuild = buildCityRepository(
    { cities: cities.records, airports: airports.records },
    { source: CITIES_URL, fetchedAt },
  );

  await writeSnapshot(airports.raw, defaultSnapshotPath(), defaultMetadataPath(), {
    source: AIRPORTS_URL,
    fetchedAt,
    recordCount: airportBuild.accepted,
    checksumSha256: sha256(airports.raw),
    termsStatus: TERMS_STATUS,
  });
  await writeSnapshot(cities.raw, defaultCitiesPath(), defaultCitiesMetadataPath(), {
    source: CITIES_URL,
    fetchedAt,
    recordCount: cityBuild.accepted,
    checksumSha256: sha256(cities.raw),
    termsStatus: TERMS_STATUS,
  });

  process.stdout.write(
    `Wrote ${defaultSnapshotPath()}\n` +
      `  records in file: ${airports.records.length}\n` +
      `  usable airports/stations: ${airportBuild.accepted}\n` +
      `  skipped records: ${airportBuild.issues.length}\n` +
      `Wrote ${defaultCitiesPath()}\n` +
      `  records in file: ${cities.records.length}\n` +
      `  usable cities: ${cityBuild.accepted}\n` +
      `  skipped records: ${cityBuild.issues.length}\n` +
      `  airports without a city: ${cityBuild.unmappedAirports}\n`,
  );
}

await main();
