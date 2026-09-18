import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseUtcInstant, type ReferenceDataProvenance } from "@travel-optimizer/domain";
import { z } from "zod";

import { buildAirportGeography, type AirportGeographyBuild } from "./airport-geography.js";
import { buildAirportRepository, type AirportRepositoryBuild } from "./airports.js";
import { buildCityRepository, type CityRepositoryBuild } from "./cities.js";

/**
 * Provenance sidecar committed next to the (uncommitted) snapshot.
 *
 * The dataset itself is not stored in the repository while Travelpayouts'
 * redistribution terms are unverified (docs/provider-compliance.md); this file
 * records where it came from so a snapshot can be reproduced and audited.
 */
export const snapshotMetadataSchema = z.object({
  source: z.url(),
  fetchedAt: z.string(),
  recordCount: z.number().int().nonnegative(),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  termsStatus: z.string().min(1),
});

export type SnapshotMetadata = z.infer<typeof snapshotMetadataSchema>;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function defaultSnapshotPath(): string {
  return resolve(packageRoot, "data/airports.json");
}

export function defaultMetadataPath(): string {
  return resolve(packageRoot, "data/airports.meta.json");
}

export function defaultCitiesPath(): string {
  return resolve(packageRoot, "data/cities.json");
}

export function defaultCitiesMetadataPath(): string {
  return resolve(packageRoot, "data/cities.meta.json");
}

export function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export class SnapshotUnavailableError extends Error {
  constructor(path: string, cause: unknown) {
    super(`No reference data snapshot at ${path}. Run "pnpm geo:fetch" first.`);
    this.name = "SnapshotUnavailableError";
    this.cause = cause;
  }
}

export interface LoadedAirportSnapshot extends AirportRepositoryBuild {
  readonly metadata: SnapshotMetadata;
}

/**
 * Loads the snapshot and its provenance from disk.
 *
 * Fails loudly when the snapshot is missing or its checksum does not match the
 * recorded one: silently using unverified reference data would put invented
 * geography behind every itinerary.
 */
export async function loadAirportSnapshot(
  snapshotPath: string = defaultSnapshotPath(),
  metadataPath: string = defaultMetadataPath(),
): Promise<LoadedAirportSnapshot> {
  let raw: string;
  try {
    raw = await readFile(snapshotPath, "utf8");
  } catch (error) {
    throw new SnapshotUnavailableError(snapshotPath, error);
  }
  const metadata = snapshotMetadataSchema.parse(
    JSON.parse(await readFile(metadataPath, "utf8")),
  );

  const checksum = sha256(raw);
  if (checksum !== metadata.checksumSha256) {
    throw new Error(
      `Airport snapshot checksum ${checksum} does not match ${metadata.checksumSha256} recorded in ${metadataPath}`,
    );
  }

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Airport snapshot at ${snapshotPath} is not a JSON array`);
  }

  const provenance: Omit<ReferenceDataProvenance, "recordCount"> = {
    source: metadata.source,
    fetchedAt: parseUtcInstant(metadata.fetchedAt),
    checksum,
  };
  return { ...buildAirportRepository(parsed, provenance), metadata };
}

/** Reads a snapshot and verifies it against its provenance record. */
async function readVerifiedSnapshot(
  snapshotPath: string,
  metadataPath: string,
): Promise<{ records: unknown[]; metadata: SnapshotMetadata; checksum: string }> {
  let raw: string;
  try {
    raw = await readFile(snapshotPath, "utf8");
  } catch (error) {
    throw new SnapshotUnavailableError(snapshotPath, error);
  }
  const metadata = snapshotMetadataSchema.parse(JSON.parse(await readFile(metadataPath, "utf8")));
  const checksum = sha256(raw);
  if (checksum !== metadata.checksumSha256) {
    throw new Error(
      `Snapshot checksum ${checksum} does not match ${metadata.checksumSha256} recorded in ${metadataPath}`,
    );
  }
  const records: unknown = JSON.parse(raw);
  if (!Array.isArray(records)) {
    throw new Error(`Snapshot at ${snapshotPath} is not a JSON array`);
  }
  return { records, metadata, checksum };
}

export interface LoadedReferenceData {
  readonly airports: AirportRepositoryBuild;
  readonly geography: AirportGeographyBuild;
  readonly cities: CityRepositoryBuild;
  readonly airportsMetadata: SnapshotMetadata;
  readonly citiesMetadata: SnapshotMetadata;
}

/**
 * Loads both reference snapshots and builds the airport and city repositories,
 * including the airport → city index.
 */
export async function loadReferenceData(paths?: {
  airports?: string;
  airportsMetadata?: string;
  cities?: string;
  citiesMetadata?: string;
}): Promise<LoadedReferenceData> {
  const airportSnapshot = await readVerifiedSnapshot(
    paths?.airports ?? defaultSnapshotPath(),
    paths?.airportsMetadata ?? defaultMetadataPath(),
  );
  const citySnapshot = await readVerifiedSnapshot(
    paths?.cities ?? defaultCitiesPath(),
    paths?.citiesMetadata ?? defaultCitiesMetadataPath(),
  );

  const provenanceOf = (
    snapshot: typeof airportSnapshot,
  ): Omit<ReferenceDataProvenance, "recordCount"> => ({
    source: snapshot.metadata.source,
    fetchedAt: parseUtcInstant(snapshot.metadata.fetchedAt),
    checksum: snapshot.checksum,
  });

  return {
    airports: buildAirportRepository(airportSnapshot.records, provenanceOf(airportSnapshot)),
    geography: buildAirportGeography(airportSnapshot.records, provenanceOf(airportSnapshot)),
    cities: buildCityRepository(
      { cities: citySnapshot.records, airports: airportSnapshot.records },
      provenanceOf(citySnapshot),
    ),
    airportsMetadata: airportSnapshot.metadata,
    citiesMetadata: citySnapshot.metadata,
  };
}
