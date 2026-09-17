import { describe, expect, it } from "vitest";

import { money } from "./money/money.js";
import { PRAHA_HLAVNI, PRG, SJJ, VIE, WIEN_HBF } from "./test-fixtures/locations.js";
import { offer, segment } from "./test-fixtures/transport.js";
import { zonedTimestampFromOffsetIso } from "./time/zoned-timestamp.js";
import {
  offerPriceForTravelers,
  transportOfferSchema,
  transportSegmentSchema,
  validateOfferSegments,
  type TransportSegmentInput,
} from "./transport.js";

const outbound = segment({
  id: "seg-sjj-vie",
  mode: "flight",
  origin: SJJ,
  destination: VIE,
  departure: "2026-12-26T10:00+01:00",
  arrival: "2026-12-26T11:15+01:00",
});

const inbound = segment({
  id: "seg-vie-sjj",
  mode: "flight",
  origin: VIE,
  destination: SJJ,
  departure: "2027-01-02T18:00+01:00",
  arrival: "2027-01-02T19:15+01:00",
});

function segmentInput(overrides: Partial<TransportSegmentInput>): TransportSegmentInput {
  return { ...outbound, ...overrides };
}

describe("transportSegmentSchema", () => {
  it("has no price field", () => {
    expect(Object.keys(outbound)).not.toContain("price");
  });

  it("accepts an overnight journey crossing midnight and zones", () => {
    const night = segment({
      id: "seg-night-train",
      mode: "train",
      origin: WIEN_HBF,
      destination: PRAHA_HLAVNI,
      departure: "2026-12-29T23:10+01:00",
      arrival: "2026-12-30T06:20+01:00",
    });
    expect(night.durationMinutes).toBe(430);
  });

  it("rejects arrival at or before departure", () => {
    expect(transportSegmentSchema.safeParse(segmentInput({ arrivalAt: outbound.departureAt })).success).toBe(false);
  });

  it("rejects identical origin and destination", () => {
    expect(transportSegmentSchema.safeParse(segmentInput({ destination: SJJ, arrivalAt: { ...outbound.arrivalAt, timeZone: SJJ.timeZone } })).success).toBe(false);
  });

  it("rejects a duration inconsistent with the timestamps", () => {
    expect(transportSegmentSchema.safeParse(segmentInput({ durationMinutes: 135 })).success).toBe(
      false,
    );
  });

  it("rejects timestamps observed in a zone other than the location's", () => {
    const istanbulDeparture = zonedTimestampFromOffsetIso("2026-12-26T12:00+03:00", "Europe/Istanbul");
    expect(transportSegmentSchema.safeParse(segmentInput({ departureAt: istanbulDeparture })).success).toBe(false);
  });

  it("rejects negative transfers and unknown modes", () => {
    expect(transportSegmentSchema.safeParse(segmentInput({ transfers: -1 })).success).toBe(false);
    expect(transportSegmentSchema.safeParse({ ...outbound, mode: "ferry" }).success).toBe(false);
  });
});

describe("transportOfferSchema", () => {
  it("represents a round-trip fare as one offer over two segments", () => {
    const roundTrip = offer({
      id: "offer-rt",
      segmentIds: [outbound.id, inbound.id],
      amountMinor: 15000,
    });
    expect(roundTrip.segmentIds).toHaveLength(2);
    expect(roundTrip.price).toEqual(money(15000, "EUR"));
  });

  it("requires at least one unique segment", () => {
    const valid = offer({ id: "offer-1", segmentIds: [outbound.id], amountMinor: 7500 });
    expect(transportOfferSchema.safeParse({ ...valid, segmentIds: [] }).success).toBe(false);
    expect(transportOfferSchema.safeParse({ ...valid, segmentIds: ["a", "a"] }).success).toBe(false);
  });

  it("requires provenance and a valid price", () => {
    const valid = offer({ id: "offer-1", segmentIds: [outbound.id], amountMinor: 7500 });
    const { provenance: _provenance, ...withoutProvenance } = valid;
    expect(transportOfferSchema.safeParse(withoutProvenance).success).toBe(false);
    expect(
      transportOfferSchema.safeParse({ ...valid, price: { amountMinor: 75.5, currency: "EUR" } })
        .success,
    ).toBe(false);
  });

  it("accepts only http(s) booking links", () => {
    const valid = offer({ id: "offer-1", segmentIds: [outbound.id], amountMinor: 7500 });
    expect(
      transportOfferSchema.safeParse({ ...valid, bookingUrl: "https://example.com/book" }).success,
    ).toBe(true);
    expect(
      transportOfferSchema.safeParse({ ...valid, bookingUrl: "javascript:alert(1)" }).success,
    ).toBe(false);
  });
});

describe("validateOfferSegments", () => {
  it("accepts chronological known segments", () => {
    const roundTrip = offer({ id: "rt", segmentIds: [outbound.id, inbound.id], amountMinor: 15000 });
    expect(validateOfferSegments(roundTrip, [outbound, inbound])).toEqual([]);
  });

  it("reports unknown segments", () => {
    const broken = offer({ id: "rt", segmentIds: [outbound.id, "missing"], amountMinor: 15000 });
    expect(validateOfferSegments(broken, [outbound]).map((issue) => issue.code)).toEqual([
      "OFFER_UNKNOWN_SEGMENT",
    ]);
  });

  it("reports segments out of chronological order", () => {
    const reversed = offer({ id: "rt", segmentIds: [inbound.id, outbound.id], amountMinor: 15000 });
    expect(validateOfferSegments(reversed, [outbound, inbound]).map((issue) => issue.code)).toEqual([
      "OFFER_SEGMENTS_NOT_CHRONOLOGICAL",
    ]);
  });
});

describe("offerPriceForTravelers", () => {
  it("multiplies per-traveler prices", () => {
    const perTraveler = offer({ id: "o", segmentIds: [outbound.id], amountMinor: 7500 });
    expect(offerPriceForTravelers(perTraveler, 2)).toEqual(money(15000, "EUR"));
  });

  it("uses total prices as-is for the quoted party size", () => {
    const total = offer({
      id: "o",
      segmentIds: [outbound.id],
      amountMinor: 16400,
      priceBasis: { kind: "total", travelers: 2 },
    });
    expect(offerPriceForTravelers(total, 2)).toEqual(money(16400, "EUR"));
  });

  it("never rescales a total price quoted for a different party size", () => {
    const total = offer({
      id: "o",
      segmentIds: [outbound.id],
      amountMinor: 8200,
      priceBasis: { kind: "total", travelers: 1 },
    });
    expect(() => offerPriceForTravelers(total, 2)).toThrow(/priced for 1 travelers/);
  });

  it("rejects invalid traveler counts", () => {
    const perTraveler = offer({ id: "o", segmentIds: [PRG.id], amountMinor: 7500 });
    expect(() => offerPriceForTravelers(perTraveler, 0)).toThrow(/traveler count/);
  });
});
