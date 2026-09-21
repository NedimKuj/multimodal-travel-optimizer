import { parseUtcInstant } from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import {
  AVIASALES_MAX_RETENTION_MS,
  aviasalesExpiryFor,
  aviasalesRetentionTtl,
} from "./retention.js";

describe("AVIASALES_MAX_RETENTION_MS", () => {
  it("is exactly 24 hours", () => {
    expect(AVIASALES_MAX_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("aviasalesRetentionTtl", () => {
  it("passes a TTL inside the provider's ceiling through unchanged", () => {
    expect(aviasalesRetentionTtl(60 * 60 * 1000)).toBe(60 * 60 * 1000);
    expect(aviasalesRetentionTtl(AVIASALES_MAX_RETENTION_MS)).toBe(AVIASALES_MAX_RETENTION_MS);
  });

  it("refuses a TTL past 24 hours, by a single millisecond", () => {
    expect(() => aviasalesRetentionTtl(AVIASALES_MAX_RETENTION_MS + 1)).toThrow(
      /retention limit/,
    );
  });

  it("refuses rather than clamping, so a mistake cannot ship quietly", () => {
    // A clamping implementation would return 24h here and keep working.
    expect(() => aviasalesRetentionTtl(48 * 60 * 60 * 1000)).toThrow(
      /AVIASALES_RETENTION_EXCEEDED|retention limit/,
    );
  });

  it("refuses a nonsensical TTL", () => {
    expect(() => aviasalesRetentionTtl(0)).toThrow();
    expect(() => aviasalesRetentionTtl(-1)).toThrow();
    expect(() => aviasalesRetentionTtl(Number.NaN)).toThrow();
    expect(() => aviasalesRetentionTtl(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("aviasalesExpiryFor", () => {
  it("is exactly 24 hours after the fetch, with no cache TTL added", () => {
    expect(aviasalesExpiryFor(parseUtcInstant("2026-09-18T09:00:00Z"))).toBe(
      "2026-09-19T09:00:00.000Z",
    );
  });

  it("crosses a day boundary without drifting", () => {
    expect(aviasalesExpiryFor(parseUtcInstant("2026-12-31T23:30:00Z"))).toBe(
      "2027-01-01T23:30:00.000Z",
    );
  });
});
