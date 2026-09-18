import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseUtcInstant, type ReferenceDataProvenance } from "@travel-optimizer/domain";
import { z } from "zod";

import { buildAirportRepository, type AirportRepositoryBuild } from "./airports.js";

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

export function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export class SnapshotUnavailableError extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `No airport snapshot at ${path}. Run "pnpm --filter @travel-optimizer/geo fetch:airports" first.`,
    );
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
