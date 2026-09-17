import { describe, expect, it } from "vitest";

import { money } from "./money/money.js";
import {
  budgetTotal,
  normalizeSearchRequest,
  type SearchRequest,
  type SearchRequestInput,
} from "./search-request.js";

/** The reference scenario from the kickoff brief. */
const sarajevoNewYear: SearchRequestInput = {
  origin: "SJJ",
  destination: null,
  departureDate: "2026-12-26",
  returnDate: "2027-01-03",
  flexibilityDays: 2,
  minNights: 5,
  maxNights: 7,
  travelers: 2,
  budget: { kind: "perPerson", amount: { amountMinor: 70000, currency: "EUR" } },
  transportModes: ["flight", "train", "bus"],
  allowOpenJaw: true,
  allowMultiCity: true,
};

function normalized(input: unknown): SearchRequest {
  const result = normalizeSearchRequest(input);
  if (!result.ok) {
    throw new Error(result.issues.map((issue) => issue.message).join("; "));
  }
  return result.request;
}

function issueCodes(input: unknown): string[] {
  const result = normalizeSearchRequest(input);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe("normalizeSearchRequest", () => {
  it("normalizes the Sarajevo New Year scenario", () => {
    const request = normalized(sarajevoNewYear);
    expect(request).toEqual({
      origin: "SJJ",
      destination: null,
      departureDate: "2026-12-26",
      returnDate: "2027-01-03",
      flexibilityDays: 2,
      minNights: 5,
      maxNights: 7,
      travelers: 2,
      budget: { kind: "perPerson", amount: money(70000, "EUR") },
      transportModes: ["flight", "train", "bus"],
      allowOpenJaw: true,
      allowMultiCity: true,
      alternativeAirports: false,
    });
  });

  it("applies only non-widening defaults", () => {
    const request = normalized({
      origin: " SJJ ",
      travelers: 1,
      transportModes: ["flight"],
      allowOpenJaw: false,
      allowMultiCity: false,
    });
    expect(request.origin).toBe("SJJ");
    expect(request.destination).toBeNull();
    expect(request.flexibilityDays).toBe(0);
    expect(request.alternativeAirports).toBe(false);
    expect(request.budget).toBeUndefined();
    expect("minNights" in request).toBe(false);
  });

  it("canonicalizes transport modes deterministically", () => {
    const request = normalized({ ...sarajevoNewYear, transportModes: ["bus", "flight", "bus"] });
    expect(request.transportModes).toEqual(["flight", "bus"]);
  });

  it("rejects an empty or unknown transport mode list", () => {
    expect(issueCodes({ ...sarajevoNewYear, transportModes: [] })).toEqual([
      "INVALID_SEARCH_REQUEST",
    ]);
    expect(issueCodes({ ...sarajevoNewYear, transportModes: ["ferry"] })).toEqual([
      "INVALID_SEARCH_REQUEST",
    ]);
  });

  it("rejects reversed dates", () => {
    expect(
      issueCodes({ ...sarajevoNewYear, departureDate: "2027-01-03", returnDate: "2026-12-26" }),
    ).toEqual(["DEPARTURE_AFTER_RETURN"]);
  });

  it("rejects min nights above max nights", () => {
    expect(issueCodes({ ...sarajevoNewYear, minNights: 8, maxNights: 7 })).toEqual([
      "MIN_NIGHTS_EXCEEDS_MAX",
    ]);
  });

  it("rejects flexibility without any dates", () => {
    const { departureDate: _d, returnDate: _r, ...withoutDates } = sarajevoNewYear;
    expect(issueCodes(withoutDates)).toEqual(["FLEXIBILITY_WITHOUT_DATES"]);
  });

  it("rejects invalid travelers, dates and budgets", () => {
    expect(issueCodes({ ...sarajevoNewYear, travelers: 0 })).toEqual(["INVALID_SEARCH_REQUEST"]);
    expect(issueCodes({ ...sarajevoNewYear, departureDate: "2026-12-32" })).toEqual([
      "INVALID_SEARCH_REQUEST",
    ]);
    expect(
      issueCodes({
        ...sarajevoNewYear,
        budget: { kind: "perPerson", amount: { amountMinor: 0, currency: "EUR" } },
      }),
    ).toEqual(["NON_POSITIVE_BUDGET"]);
  });

  it("does not accept an untagged budget or a float amount", () => {
    expect(issueCodes({ ...sarajevoNewYear, budget: 700 })).toEqual(["INVALID_SEARCH_REQUEST"]);
    expect(
      issueCodes({ ...sarajevoNewYear, budget: { amount: { amountMinor: 70000, currency: "EUR" } } }),
    ).toEqual(["INVALID_SEARCH_REQUEST"]);
    expect(
      issueCodes({
        ...sarajevoNewYear,
        budget: { kind: "total", amount: { amountMinor: 700.5, currency: "EUR" } },
      }),
    ).toEqual(["INVALID_SEARCH_REQUEST"]);
  });

  it("reports every structural issue together", () => {
    expect(
      issueCodes({
        ...sarajevoNewYear,
        departureDate: "2027-01-03",
        returnDate: "2026-12-26",
        minNights: 9,
      }),
    ).toEqual(["DEPARTURE_AFTER_RETURN", "MIN_NIGHTS_EXCEEDS_MAX"]);
  });
});

describe("budgetTotal", () => {
  it("multiplies a per-person budget by travelers", () => {
    expect(budgetTotal({ kind: "perPerson", amount: money(70000, "EUR") }, 2)).toEqual(
      money(140000, "EUR"),
    );
  });

  it("never multiplies a total budget", () => {
    expect(budgetTotal({ kind: "total", amount: money(70000, "EUR") }, 2)).toEqual(
      money(70000, "EUR"),
    );
  });
});
