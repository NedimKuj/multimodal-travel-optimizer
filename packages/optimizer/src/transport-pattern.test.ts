import { describe, expect, it } from "vitest";

import { request } from "./test-fixtures.js";
import {
  enabledPatterns,
  transportPattern,
  TRANSPORT_PATTERNS,
  type PatternInput,
  type TransportPattern,
} from "./transport-pattern.js";

/*
 * A candidate has exactly one pattern. That exclusivity is what the
 * accommodation shortlist relies on to reserve one slot per pattern without
 * deduplicating (ADR 0016 §5).
 */

/** The two facts the classification depends on, and nothing else. */
function shaped(stays: number, gaps: number): PatternInput {
  return {
    nightsByStay: Array.from({ length: stays }, () => 1),
    summary: { unpricedGaps: Array.from({ length: gaps }, () => ({})) },
  };
}

describe("transportPattern", () => {
  it("classifies each shape", () => {
    expect(transportPattern(shaped(1, 0))).toBe("round_trip");
    expect(transportPattern(shaped(1, 1))).toBe("open_jaw");
    expect(transportPattern(shaped(2, 0))).toBe("multi_city");
    expect(transportPattern(shaped(2, 1))).toBe("multi_city_open_jaw");
  });

  it("gives every shape exactly one pattern", () => {
    // Four inputs, four outputs, no overlap: what makes the reserved set of
    // the accommodation shortlist duplicate-free by construction.
    const seen = new Set<TransportPattern>();
    for (const stays of [1, 2, 3]) {
      for (const gaps of [0, 1, 2]) {
        seen.add(transportPattern(shaped(stays, gaps)));
      }
    }
    expect([...seen].sort()).toEqual([...TRANSPORT_PATTERNS].sort());
  });

  it("does not change with the number of stays or gaps beyond the first", () => {
    expect(transportPattern(shaped(3, 0))).toBe(transportPattern(shaped(2, 0)));
    expect(transportPattern(shaped(2, 2))).toBe(transportPattern(shaped(2, 1)));
  });
});

describe("enabledPatterns", () => {
  it("allows only round trips by default", () => {
    expect(enabledPatterns(request())).toEqual(["round_trip"]);
  });

  it("adds an open jaw when one is permitted", () => {
    expect(enabledPatterns(request({ allowOpenJaw: true }))).toEqual(["round_trip", "open_jaw"]);
  });

  it("adds multi-city when one is permitted", () => {
    expect(enabledPatterns(request({ allowMultiCity: true }))).toEqual([
      "round_trip",
      "multi_city",
    ]);
  });

  it("allows every shape when both are permitted", () => {
    expect(enabledPatterns(request({ allowOpenJaw: true, allowMultiCity: true }))).toEqual([
      ...TRANSPORT_PATTERNS,
    ]);
  });
});
