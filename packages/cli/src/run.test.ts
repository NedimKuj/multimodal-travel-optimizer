import { failedResult, type AirportRepository } from "@travel-optimizer/domain";
import {
  cityRepository,
  FCO,
  metrics,
  roundTrip,
  SJJ,
  searchResult,
  stubFlightProvider,
} from "@travel-optimizer/optimizer/test-fixtures";
import { describe, expect, it } from "vitest";

import { run, type CliIo, type RunOverrides } from "./run.js";

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
  referenceData: { airports, cities: cityRepository },
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
      referenceData: { airports, cities: cityRepository },
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
