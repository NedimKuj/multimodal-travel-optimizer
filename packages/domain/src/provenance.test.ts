import { describe, expect, it } from "vitest";

import {
  priceFreshness,
  priceProvenanceSchema,
  weakestSourceType,
  type PriceProvenanceInput,
} from "./provenance.js";
import { parseUtcInstant } from "./time/zoned-timestamp.js";

const cachedFare: PriceProvenanceInput = {
  provider: "fixture-flights",
  providerReference: "fare-1",
  sourceType: "cached",
  fetchedAt: "2026-09-17T14:42:00Z",
  expiresAt: "2026-09-18T14:42:00+00:00",
};

describe("priceProvenanceSchema", () => {
  it("accepts complete provenance and normalizes instants", () => {
    const parsed = priceProvenanceSchema.parse(cachedFare);
    expect(parsed.fetchedAt).toBe("2026-09-17T14:42:00.000Z");
    expect(parsed.expiresAt).toBe("2026-09-18T14:42:00.000Z");
  });

  it("allows an unknown expiry", () => {
    const { expiresAt: _expiresAt, ...withoutExpiry } = cachedFare;
    expect(priceProvenanceSchema.safeParse(withoutExpiry).success).toBe(true);
  });

  it("rejects missing provider, unknown source types and naive timestamps", () => {
    expect(priceProvenanceSchema.safeParse({ ...cachedFare, provider: "" }).success).toBe(false);
    expect(priceProvenanceSchema.safeParse({ ...cachedFare, sourceType: "verified" }).success).toBe(
      false,
    );
    expect(
      priceProvenanceSchema.safeParse({ ...cachedFare, fetchedAt: "2026-09-17T14:42:00" }).success,
    ).toBe(false);
  });

  it("rejects expiry before fetch time", () => {
    expect(
      priceProvenanceSchema.safeParse({ ...cachedFare, expiresAt: "2026-09-17T14:41:00Z" }).success,
    ).toBe(false);
  });
});

describe("weakestSourceType", () => {
  it("returns the least trustworthy source", () => {
    expect(weakestSourceType(["live", "cached", "recent"])).toBe("cached");
    expect(weakestSourceType(["live", "estimated"])).toBe("estimated");
    expect(weakestSourceType(["live", "live"])).toBe("live");
  });

  it("returns undefined when there are no prices", () => {
    expect(weakestSourceType([])).toBeUndefined();
  });
});

describe("priceFreshness", () => {
  const provenance = priceProvenanceSchema.parse(cachedFare);

  it("reports fresh before expiry and expired at or after it", () => {
    expect(priceFreshness(provenance, parseUtcInstant("2026-09-18T14:41:59Z"))).toBe("fresh");
    expect(priceFreshness(provenance, parseUtcInstant("2026-09-18T14:42:00Z"))).toBe("expired");
  });

  it("reports unknown freshness without an expiry", () => {
    const { expiresAt: _expiresAt, ...withoutExpiry } = cachedFare;
    const noExpiry = priceProvenanceSchema.parse(withoutExpiry);
    expect(priceFreshness(noExpiry, parseUtcInstant("2030-01-01T00:00:00Z"))).toBe("unknown");
  });
});
