import { parseUtcInstant, zonedTimestampFromOffsetIso } from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import {
  buildGroundTransferLeg,
  DEFAULT_GROUND_TRANSFER_CONFIG,
  estimateGroundTransfer,
  needsAccessTransfer,
  type GroundTransferConfig,
} from "./ground-transfer.js";
import { FCO, ROME, SJJ } from "./test-fixtures.js";

const fetchedAt = parseUtcInstant("2026-09-18T09:00:00Z");

describe("estimateGroundTransfer", () => {
  it("scales time and cost with distance", () => {
    // Distances are straight-line; the model adds a road detour factor.
    const short = estimateGroundTransfer(FCO, ROME, 30);
    const long = estimateGroundTransfer(FCO, ROME, 110);
    expect(short).toMatchObject({ roadDistanceKm: 39, durationMinutes: 67, price: { amountMinor: 1080 } });
    expect(long).toMatchObject({ durationMinutes: 192, price: { amountMinor: 3160 } });
  });

  it("never returns a zero-minute transfer", () => {
    expect(estimateGroundTransfer(FCO, ROME, 0).durationMinutes).toBeGreaterThan(0);
  });

  it("uses an override for a pair we know better, in either direction", () => {
    const config: GroundTransferConfig = {
      ...DEFAULT_GROUND_TRANSFER_CONFIG,
      overrides: [
        { fromLocationId: FCO.id, toLocationId: ROME.id, durationMinutes: 32, costMinor: 1400 },
      ],
    };
    expect(estimateGroundTransfer(FCO, ROME, 30, config)).toMatchObject({
      durationMinutes: 32,
      price: { amountMinor: 1400 },
      overridden: true,
    });
    // The same override applies coming back.
    expect(estimateGroundTransfer(ROME, FCO, 30, config).durationMinutes).toBe(32);
  });

  it("uses the configured currency", () => {
    const config: GroundTransferConfig = { ...DEFAULT_GROUND_TRANSFER_CONFIG, currency: "BAM" };
    expect(estimateGroundTransfer(SJJ, ROME, 10, config).price.currency).toBe("BAM");
  });
});

describe("needsAccessTransfer", () => {
  it("attaches a transfer only beyond the threshold", () => {
    const config = DEFAULT_GROUND_TRANSFER_CONFIG;
    // Compared on road distance: 20 km of road, so about 15 km straight-line.
    expect(needsAccessTransfer(10, config)).toBe(false); // in town
    expect(needsAccessTransfer(15, config)).toBe(false); // Ciampino-like, 19.5 km road
    expect(needsAccessTransfer(16, config)).toBe(true); // 20.8 km road
    expect(needsAccessTransfer(23, config)).toBe(true); // Fiumicino-like, 30 km road
    expect(needsAccessTransfer(110, config)).toBe(true); // Memmingen-like
  });
});

describe("buildGroundTransferLeg", () => {
  const flightDeparture = zonedTimestampFromOffsetIso("2026-12-27T10:00+01:00", SJJ.timeZone);

  it("schedules a transfer to arrive before the transport it serves", () => {
    const { segment, estimate } = buildGroundTransferLeg({
      id: "transfer-1",
      from: ROME,
      to: FCO,
      distanceKm: 30,
      travelers: 2,
      anchor: flightDeparture,
      anchorRole: "arrive_before",
      fetchedAt,
    });
    // 30 minute buffer before the flight, 67 minutes of travel before that.
    expect(segment.arrivalAt.instant).toBe("2026-12-27T08:30:00.000Z");
    expect(segment.departureAt.instant).toBe("2026-12-27T07:23:00.000Z");
    expect(segment.durationMinutes).toBe(estimate.durationMinutes);
    expect(segment.mode).toBe("ground_transfer");
  });

  it("schedules a transfer to depart after the transport it serves", () => {
    const { segment } = buildGroundTransferLeg({
      id: "transfer-2",
      from: FCO,
      to: ROME,
      distanceKm: 30,
      travelers: 2,
      anchor: flightDeparture,
      anchorRole: "depart_after",
      fetchedAt,
    });
    expect(segment.departureAt.instant).toBe("2026-12-27T09:30:00.000Z");
    expect(segment.arrivalAt.instant).toBe("2026-12-27T10:37:00.000Z");
  });

  it("labels the price estimated and attributes it to the model, not a provider", () => {
    const { offer } = buildGroundTransferLeg({
      id: "transfer-3",
      from: ROME,
      to: FCO,
      distanceKm: 30,
      travelers: 2,
      anchor: flightDeparture,
      anchorRole: "arrive_before",
      fetchedAt,
    });
    expect(offer.provenance).toMatchObject({
      provider: "internal-estimate",
      sourceType: "estimated",
      fetchedAt: "2026-09-18T09:00:00.000Z",
    });
    expect(offer.provenance.expiresAt).toBeUndefined();
    expect(offer.bookingUrl).toBeUndefined();
  });

  it("prices per traveler by default", () => {
    const { offer } = buildGroundTransferLeg({
      id: "transfer-4",
      from: ROME,
      to: FCO,
      distanceKm: 30,
      travelers: 2,
      anchor: flightDeparture,
      anchorRole: "arrive_before",
      fetchedAt,
    });
    expect(offer.priceBasis).toEqual({ kind: "perTraveler" });
    expect(offer.price).toEqual({ amountMinor: 1080, currency: "EUR" });
  });

  it("can price for the whole party when configured that way", () => {
    const { offer } = buildGroundTransferLeg({
      id: "transfer-5",
      from: ROME,
      to: FCO,
      distanceKm: 30,
      travelers: 3,
      anchor: flightDeparture,
      anchorRole: "arrive_before",
      fetchedAt,
      config: { ...DEFAULT_GROUND_TRANSFER_CONFIG, perTraveler: false },
    });
    expect(offer.priceBasis).toEqual({ kind: "total", travelers: 3 });
  });

  it("is deterministic for the same input", () => {
    const build = () =>
      buildGroundTransferLeg({
        id: "transfer-6",
        from: ROME,
        to: FCO,
        distanceKm: 30,
        travelers: 2,
        anchor: flightDeparture,
        anchorRole: "arrive_before",
        fetchedAt,
      });
    expect(build().segment).toEqual(build().segment);
    expect(build().offer).toEqual(build().offer);
  });
});
