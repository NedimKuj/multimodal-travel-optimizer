import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { failedResult, type AirportRepository } from "@travel-optimizer/domain";
import {
  cityRepository,
  FCO,
  fixtureGeography,
  metrics,
  roundTrip,
  SJJ,
  searchResult,
  stubFlightProvider,
} from "@travel-optimizer/optimizer/test-fixtures";
import { AVIASALES_MAX_RETENTION_MS, aviasalesRetentionTtl } from "@travel-optimizer/providers";
import { describe, expect, it, vi } from "vitest";

import { CACHE_TTL_MS, run, type CliIo, type RunOverrides } from "./run.js";

/**
 * Every TTL run.ts hands to the retention guard, in order.
 *
 * The wrapper delegates to the real guard, so behaviour is unchanged; it only
 * records that the call happened. Without this, removing the guard from the
 * cache construction in run.ts would leave the suite green.
 */
const retentionCalls = vi.hoisted((): number[] => []);

vi.mock("@travel-optimizer/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@travel-optimizer/providers")>();
  return {
    ...actual,
    aviasalesRetentionTtl: (ttlMs: number): number => {
      retentionCalls.push(ttlMs);
      return actual.aviasalesRetentionTtl(ttlMs);
    },
  };
});

const TOKEN = "secret-token-value";

const airports: AirportRepository = {
  provenance: cityRepository.provenance,
  findByIata: (iata) => (iata === "SJJ" ? SJJ : iata === "FCO" ? FCO : undefined),
};

const romeTrip = roundTrip({
  id: "rome",
  destination: FCO,
  outbound: ["2026-12-27T10:00+01:00", "2026-12-27T11:30+01:00"],
  inbound: ["2027-01-02T18:00+01:00", "2027-01-02T19:30+01:00"],
  amountMinor: 12000,
});

function io(env: Record<string, string> = { AVIASALES_API_TOKEN: TOKEN }): CliIo & {
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env,
    cwd: "/tmp/does-not-matter",
  };
}

const workingProvider: RunOverrides = {
  referenceData: { airports, cities: cityRepository, geography: fixtureGeography },
  flightProvider: stubFlightProvider(searchResult([romeTrip])),
};

const args = [
  "--origin",
  "SJJ",
  "--from",
  "2026-12-26",
  "--to",
  "2027-01-03",
  "--nights",
  "5:7",
  "--people",
  "2",
];

describe("run — exit codes", () => {
  it("returns 0 and prints results for a successful search", async () => {
    const console_ = io();
    const code = await run(args, console_, workingProvider);
    expect(code).toBe(0);
    expect(console_.out.join("")).toContain("Rome (IT) — FCO");
    expect(console_.err).toEqual([]);
  });

  it("returns 0 with help", async () => {
    const console_ = io();
    expect(await run(["--help"], console_)).toBe(0);
    expect(console_.out.join("")).toContain("trip-search — explore flights");
  });

  it("returns 1 for invalid arguments, without a stack trace", async () => {
    const console_ = io();
    const code = await run(["--origin", "SJJ", "--from", "nope"], console_, workingProvider);
    expect(code).toBe(1);
    const stderr = console_.err.join("");
    expect(stderr).toContain("--from must be a date");
    expect(stderr).toContain("Run with --help");
    expect(stderr).not.toContain("at ");
  });

  it("returns 1 with an actionable message when the token is missing", async () => {
    const console_ = io({});
    const code = await run(args, console_, workingProvider);
    expect(code).toBe(1);
    const stderr = console_.err.join("");
    expect(stderr).toContain("AVIASALES_API_TOKEN is not set");
    expect(stderr).toContain(".env.example");
  });

  it("returns 2 when the provider fails outright", async () => {
    const console_ = io();
    const code = await run(args, console_, {
      referenceData: { airports, cities: cityRepository, geography: fixtureGeography },
      flightProvider: stubFlightProvider(
        failedResult(
          "fixture-flights",
          [{ kind: "unauthorized", message: "token rejected", retryable: false }],
          metrics,
        ),
      ),
    });
    expect(code).toBe(2);
    expect(console_.out.join("")).toContain("Search failed.");
    expect(console_.out.join("")).toContain("provider unauthorized: token rejected");
  });

  it("returns 0 when nothing matched, because that is a real answer", async () => {
    const console_ = io();
    const code = await run([...args, "--nights", "1:2"], console_, workingProvider);
    expect(code).toBe(0);
    expect(console_.out.join("")).toContain("No trips matched");
  });
});

describe("run — output safety", () => {
  it("never prints the API token, in text or JSON", async () => {
    for (const extra of [[], ["--json"]]) {
      const console_ = io();
      await run([...args, ...extra], console_, workingProvider);
      const everything = console_.out.join("") + console_.err.join("");
      expect(everything).not.toContain(TOKEN);
    }
  });

  it("emits a JSON trace with the reproducibility record", async () => {
    const console_ = io();
    await run([...args, "--json"], console_, workingProvider);
    const parsed: unknown = JSON.parse(console_.out.join(""));
    expect(parsed).toMatchObject({
      status: "ok",
      currency: "EUR",
      request: { origin: "SJJ", travelers: 2 },
      provider: { descriptor: { id: "fixture-flights" } },
    });
  });

  it("passes the requested currency and budget basis through", async () => {
    const console_ = io();
    await run(
      [...args, "--budget", "700", "--budget-basis", "total", "--json"],
      console_,
      workingProvider,
    );
    const parsed: unknown = JSON.parse(console_.out.join(""));
    expect(parsed).toMatchObject({
      request: { budget: { kind: "total", amount: { amountMinor: 70000, currency: "EUR" } } },
    });
  });
});

describe("response cache retention", () => {
  it("configures a TTL the Aviasales retention limit permits", () => {
    // The CLI builds its cache through `aviasalesRetentionTtl`, which throws
    // above 24h. Pinning the configured value here fails at test time rather
    // than when someone runs a search with a raised TTL.
    expect(() => aviasalesRetentionTtl(CACHE_TTL_MS)).not.toThrow();
    expect(CACHE_TTL_MS).toBeLessThanOrEqual(AVIASALES_MAX_RETENTION_MS);
  });

  it("keeps the configured TTL well inside the limit rather than at it", () => {
    // Sitting exactly on the ceiling would leave no room for the clock skew
    // between storing a response and deriving an expiry from it.
    expect(CACHE_TTL_MS).toBeLessThan(AVIASALES_MAX_RETENTION_MS);
  });

  it("builds its response cache through the retention guard", async () => {
    // The assertions above would still pass if run.ts stopped calling the
    // guard, so this exercises the real construction path: no flightProvider
    // override, which is the only way the cache is actually built.
    retentionCalls.length = 0;
    const cacheRoot = mkdtempSync(join(tmpdir(), "trip-search-cache-"));
    // The adapter would otherwise reach the network once it is constructed.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ success: true, currency: "eur", data: [] }))),
      ),
    );
    try {
      const cli = { ...io(), cwd: cacheRoot };
      const code = await run(args, cli, {
        referenceData: { airports, cities: cityRepository, geography: fixtureGeography },
      });

      expect(code).toBe(0);
      expect(retentionCalls).toEqual([CACHE_TTL_MS]);
    } finally {
      vi.unstubAllGlobals();
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});
