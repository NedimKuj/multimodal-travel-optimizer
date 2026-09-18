import { existsSync } from "node:fs";

import { parseLocalDate, type FlightSearchQuery } from "@travel-optimizer/domain";
import { defaultSnapshotPath, loadAirportSnapshot } from "@travel-optimizer/geo";
import { describe, expect, it } from "vitest";

import { loadAviasalesConfig } from "./config.js";
import { createAviasalesFlightProvider } from "./provider.js";

/*
 * Live contract test: does the real API still match our committed schemas?
 *
 * Skipped unless BOTH `AVIASALES_API_TOKEN` and `PROVIDER_LIVE=1` are set, and
 * an airport snapshot exists. Skipped means skipped — it never passes silently
 * without having checked anything.
 *
 * Run with: pnpm test:live
 */

const enabled =
  process.env["PROVIDER_LIVE"] === "1" &&
  (process.env["AVIASALES_API_TOKEN"] ?? "").trim() !== "" &&
  existsSync(defaultSnapshotPath());

describe.skipIf(!enabled)("Aviasales live contract", () => {
  it("still returns records our schema and mapper accept", async () => {
    const configResult = loadAviasalesConfig();
    if (!configResult.ok) throw new Error("expected config");
    const snapshot = await loadAirportSnapshot();

    const provider = createAviasalesFlightProvider({
      config: configResult.config,
      airports: snapshot.repository,
    });

    // One month, one origin: a single call.
    const query: FlightSearchQuery = {
      origins: ["SJJ"],
      destinations: "anywhere",
      departureDates: { from: parseLocalDate("2026-12-01"), to: parseLocalDate("2026-12-31") },
      travelers: 1,
      currency: "EUR",
    };

    const result = await provider.search(query);
    expect(result.metrics.requestCount).toBe(1);
    expect(result.status, JSON.stringify(result.failures)).not.toBe("failed");
    if (result.status === "failed") return;

    // Coverage is thin by nature; the contract is that what comes back is usable.
    expect(result.data.offers.length).toBeGreaterThan(0);
    for (const offer of result.data.offers) {
      expect(offer.price.currency).toBe("EUR");
      expect(offer.price.amountMinor).toBeGreaterThan(0);
      expect(offer.provenance.sourceType).toBe("cached");
      expect(offer.provenance.provider).toBe("aviasales");
      expect(offer.segmentIds.length).toBeGreaterThanOrEqual(1);
    }
    for (const segment of result.data.segments) {
      expect(segment.mode).toBe("flight");
      expect(segment.departureAt.instant).toMatch(/Z$/);
      expect(segment.durationMinutes).toBeGreaterThan(0);
    }

    // Any drops are reported, and should stay a small minority.
    const dropped = result.failures.find((failure) => failure.message.includes("dropped"));
    if (dropped !== undefined) {
      process.stdout.write(`live contract: ${dropped.message}\n`);
    }
  }, 30_000);
});
