import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { parseUtcInstant } from "@travel-optimizer/domain";

import {
  buildAirportRepository,
  defaultMetadataPath,
  defaultSnapshotPath,
  sha256,
  type SnapshotMetadata,
} from "../index.js";

/*
 * Fetches the Travelpayouts airport dataset into packages/geo/data/.
 *
 * The dataset stays out of version control while redistribution terms are
 * unverified (docs/provider-compliance.md); only the provenance sidecar is
 * committed. No credentials are involved: this file is public.
 */

const SOURCE_URL = "https://api.travelpayouts.com/data/en-GB/airports.json";

async function main(): Promise<void> {
  const snapshotPath = defaultSnapshotPath();
  const metadataPath = defaultMetadataPath();

  process.stdout.write(`Fetching ${SOURCE_URL}\n`);
  const response = await fetch(SOURCE_URL, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${SOURCE_URL} responded ${response.status} ${response.statusText}`);
  }
  const raw = await response.text();

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected the dataset to be a JSON array");
  }
  const fetchedAt = parseUtcInstant(new Date().toISOString());
  const { accepted, issues } = buildAirportRepository(parsed, {
    source: SOURCE_URL,
    fetchedAt,
  });

  const metadata: SnapshotMetadata = {
    source: SOURCE_URL,
    fetchedAt,
    recordCount: accepted,
    checksumSha256: sha256(raw),
    termsStatus:
      "Redistribution terms unverified as of 2026-09-18; snapshot not committed. See docs/provider-compliance.md.",
  };

  await mkdir(dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, raw, "utf8");
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  process.stdout.write(
    `Wrote ${snapshotPath}\n` +
      `  records in file: ${parsed.length}\n` +
      `  usable airports/stations: ${accepted}\n` +
      `  skipped records: ${issues.length}\n` +
      `  sha256: ${metadata.checksumSha256}\n`,
  );
}

await main();
