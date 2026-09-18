import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadAirportSnapshot,
  sha256,
  SnapshotUnavailableError,
  snapshotMetadataSchema,
  type SnapshotMetadata,
} from "./snapshot.js";

const airports = [
  {
    name_translations: { en: "Sarajevo Test Airport" },
    city_code: "SJJ",
    country_code: "BA",
    time_zone: "Europe/Sarajevo",
    code: "SJJ",
    iata_type: "airport",
    name: null,
    coordinates: { lat: 43.826687, lon: 18.336065 },
    flightable: true,
  },
];

const directories: string[] = [];

async function writeSnapshot(
  overrides: Partial<SnapshotMetadata> = {},
  contents = JSON.stringify(airports),
): Promise<{ snapshotPath: string; metadataPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "geo-snapshot-"));
  directories.push(directory);
  const snapshotPath = join(directory, "airports.json");
  const metadataPath = join(directory, "airports.meta.json");
  const metadata: SnapshotMetadata = {
    source: "https://example.test/airports.json",
    fetchedAt: "2026-09-18T08:00:00.000Z",
    recordCount: airports.length,
    checksumSha256: sha256(contents),
    termsStatus: "test fixture",
    ...overrides,
  };
  await writeFile(snapshotPath, contents, "utf8");
  await writeFile(metadataPath, JSON.stringify(metadata), "utf8");
  return { snapshotPath, metadataPath };
}

afterEach(() => {
  directories.length = 0;
});

describe("loadAirportSnapshot", () => {
  it("loads a snapshot whose checksum matches its provenance record", async () => {
    const { snapshotPath, metadataPath } = await writeSnapshot();
    const snapshot = await loadAirportSnapshot(snapshotPath, metadataPath);
    expect(snapshot.accepted).toBe(1);
    expect(snapshot.repository.findByIata("SJJ")?.timeZone).toBe("Europe/Sarajevo");
    expect(snapshot.repository.provenance).toMatchObject({
      source: "https://example.test/airports.json",
      fetchedAt: "2026-09-18T08:00:00.000Z",
      recordCount: 1,
    });
  });

  it("refuses a snapshot that does not match its recorded checksum", async () => {
    const { snapshotPath, metadataPath } = await writeSnapshot({
      checksumSha256: "0".repeat(64),
    });
    await expect(loadAirportSnapshot(snapshotPath, metadataPath)).rejects.toThrow(
      /checksum .* does not match/,
    );
  });

  it("explains how to fetch a missing snapshot", async () => {
    const { metadataPath } = await writeSnapshot();
    await expect(loadAirportSnapshot("/nonexistent/airports.json", metadataPath)).rejects.toThrow(
      SnapshotUnavailableError,
    );
  });

  it("rejects a snapshot that is not an array", async () => {
    const { snapshotPath, metadataPath } = await writeSnapshot({}, JSON.stringify({ code: "SJJ" }));
    await expect(loadAirportSnapshot(snapshotPath, metadataPath)).rejects.toThrow(
      /not a JSON array/,
    );
  });

  it("requires complete provenance metadata", () => {
    expect(
      snapshotMetadataSchema.safeParse({
        source: "not-a-url",
        fetchedAt: "2026-09-18T08:00:00.000Z",
        recordCount: 1,
        checksumSha256: "0".repeat(64),
        termsStatus: "x",
      }).success,
    ).toBe(false);
    expect(
      snapshotMetadataSchema.safeParse({
        source: "https://example.test/a.json",
        fetchedAt: "2026-09-18T08:00:00.000Z",
        recordCount: 1,
        checksumSha256: "nope",
        termsStatus: "x",
      }).success,
    ).toBe(false);
  });
});
