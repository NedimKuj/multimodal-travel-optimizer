import { describe, expect, it } from "vitest";

import { parseArguments, type CliOptions } from "./args.js";

const base = [
  "--origin",
  "SJJ",
  "--from",
  "2026-12-26",
  "--to",
  "2027-01-03",
];

function parsed(args: readonly string[]): CliOptions {
  const result = parseArguments(args);
  if (!result.ok) {
    throw new Error("help" in result ? "help" : result.issues.map((i) => i.message).join("; "));
  }
  return result.options;
}

function issues(args: readonly string[]): string[] {
  const result = parseArguments(args);
  if (result.ok || "help" in result) return [];
  return result.issues.map((issue) => issue.message);
}

describe("parseArguments", () => {
  it("parses the reference scenario", () => {
    const options = parsed([
      ...base,
      "--nights",
      "5:7",
      "--flex",
      "2",
      "--people",
      "2",
      "--budget",
      "700",
    ]);
    expect(options).toEqual({
      origin: "SJJ",
      destination: null,
      from: "2026-12-26",
      to: "2027-01-03",
      flexibilityDays: 2,
      nights: { min: 5, max: 7 },
      travelers: 2,
      budget: { kind: "perPerson", amount: { amountMinor: 70000, currency: "EUR" } },
      currency: "EUR",
      alternativeAirports: false,
      openJaw: false,
      compose: false,
      multiCity: false,
      limit: 10,
      json: false,
    });
  });

  it("keeps open jaw off unless asked", () => {
    expect(parsed(base).openJaw).toBe(false);
    expect(parsed([...base, "--open-jaw"]).openJaw).toBe(true);
  });

  it("composes from one-way fares on request, and always for an open jaw", () => {
    expect(parsed(base).compose).toBe(false);
    expect(parsed([...base, "--compose"]).compose).toBe(true);
    // An open jaw can only be built from one-way fares.
    expect(parsed([...base, "--open-jaw"]).compose).toBe(true);
    expect(parsed([...base, "--compose"]).openJaw).toBe(false);
  });

  it("allows a second city on request, always composing from one-way fares", () => {
    expect(parsed(base).multiCity).toBe(false);
    expect(parsed([...base, "--multi-city"]).multiCity).toBe(true);
    // A second city can only be reached by composing one-way fares.
    expect(parsed([...base, "--multi-city"]).compose).toBe(true);
    // And it is a separate choice from flying home from somewhere else.
    expect(parsed([...base, "--multi-city"]).openJaw).toBe(false);
  });

  it("keeps alternative airports off unless asked", () => {
    expect(parsed(base).alternativeAirports).toBe(false);
    expect(parsed([...base, "--alternative-airports"]).alternativeAirports).toBe(true);
  });

  it("applies only the documented defaults", () => {
    const options = parsed(base);
    expect(options).toMatchObject({
      destination: null,
      flexibilityDays: 0,
      travelers: 1,
      currency: "EUR",
      alternativeAirports: false,
      openJaw: false,
      compose: false,
      multiCity: false,
      limit: 10,
      json: false,
    });
    expect(options.nights).toBeUndefined();
    expect(options.budget).toBeUndefined();
  });

  it("normalizes codes to upper case", () => {
    const options = parsed(["--origin", "sjj", "--destination", "ist", "--from", "2026-12-26", "--to", "2027-01-03"]);
    expect(options.origin).toBe("SJJ");
    expect(options.destination).toBe("IST");
  });

  it("reads a single --nights value as an exact stay", () => {
    expect(parsed([...base, "--nights", "6"]).nights).toEqual({ min: 6, max: 6 });
  });

  it("honours --budget-basis total without multiplying it", () => {
    const options = parsed([...base, "--budget", "1400", "--budget-basis", "total"]);
    expect(options.budget).toEqual({
      kind: "total",
      amount: { amountMinor: 140000, currency: "EUR" },
    });
  });

  it("parses a budget in another currency", () => {
    const options = parsed([...base, "--budget", "1370", "--currency", "bam"]);
    expect(options.currency).toBe("BAM");
    expect(options.budget).toEqual({
      kind: "perPerson",
      amount: { amountMinor: 137000, currency: "BAM" },
    });
  });

  it("requires origin and both dates", () => {
    expect(issues(["--from", "2026-12-26", "--to", "2027-01-03"])).toEqual([
      expect.stringContaining("--origin is required"),
    ]);
    expect(issues(["--origin", "SJJ"]).length).toBe(2);
  });

  it("rejects malformed values instead of falling back", () => {
    expect(issues([...base, "--nights", "seven"])[0]).toContain("--nights");
    expect(issues([...base, "--nights", "7:5"])[0]).toContain("below the minimum");
    expect(issues([...base, "--people", "0"])[0]).toContain("--people");
    expect(issues([...base, "--people", "1.5"])[0]).toContain("--people");
    expect(issues([...base, "--flex", "-1"])[0]).toContain("--flex");
    expect(issues([...base, "--budget", "seven hundred"])[0]).toContain("--budget");
    expect(issues([...base, "--budget", "0"])[0]).toContain("greater than zero");
    expect(issues([...base, "--currency", "XYZ"])[0]).toContain("not a supported currency");
    expect(issues(["--origin", "SJJ", "--from", "not-a-date", "--to", "2027-01-03"])[0]).toContain(
      "YYYY-MM-DD",
    );
  });

  it("rejects a budget amount with impossible precision for its currency", () => {
    expect(issues([...base, "--budget", "700.005"])[0]).toContain("--budget");
  });

  it("rejects --budget-basis without --budget", () => {
    expect(issues([...base, "--budget-basis", "total"])[0]).toContain("requires --budget");
  });

  it("rejects an unknown budget basis", () => {
    expect(issues([...base, "--budget", "700", "--budget-basis", "per-trip"])[0]).toContain(
      "per-person or total",
    );
  });

  it("rejects reversed dates", () => {
    expect(issues(["--origin", "SJJ", "--from", "2027-01-03", "--to", "2026-12-26"])[0]).toContain(
      "is after",
    );
  });

  it("rejects unknown flags rather than ignoring them", () => {
    expect(issues([...base, "--hotels"])[0]).toBeDefined();
  });

  it("reports help", () => {
    const result = parseArguments(["--help"]);
    expect(result).toEqual({ ok: false, help: true });
  });
});

describe("one-way", () => {
  const oneWay = ["--origin", "SJJ", "--from", "2026-12-26", "--one-way", "2027-01-03"];

  it("accepts a departure and an end instead of a return", () => {
    const options = parsed(oneWay);
    expect(options.endDate).toBe("2027-01-03");
    expect(options.to).toBeUndefined();
  });

  it("refuses a return and an end together", () => {
    expect(issues([...base, "--one-way", "2027-01-05"])[0]).toContain("a trip returns or it ends");
  });

  it("still requires one of the two", () => {
    expect(issues(["--origin", "SJJ", "--from", "2026-12-26"])[0]).toContain("--to is required");
  });

  it("rejects an end before the departure", () => {
    expect(
      issues(["--origin", "SJJ", "--from", "2027-01-03", "--one-way", "2026-12-26"])[0],
    ).toContain("is after");
  });

  it("rejects a malformed end rather than falling back", () => {
    expect(issues(["--origin", "SJJ", "--from", "2026-12-26", "--one-way", "soon"])[0]).toContain(
      "--one-way",
    );
  });

  it("composes from one-way fares, which is all a one-way can be", () => {
    expect(parsed(oneWay).compose).toBe(true);
    // Still not an open jaw or a multi-city trip: those are separate choices.
    expect(parsed(oneWay).openJaw).toBe(false);
    expect(parsed(oneWay).multiCity).toBe(false);
  });

  it("leaves round trips exactly as they were", () => {
    const options = parsed(base);
    expect(options.to).toBe("2027-01-03");
    expect(options.endDate).toBeUndefined();
    expect(options.compose).toBe(false);
  });
});
