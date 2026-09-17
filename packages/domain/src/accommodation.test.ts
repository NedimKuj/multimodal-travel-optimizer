import { describe, expect, it } from "vitest";

import { staySchema } from "./accommodation.js";
import { stay } from "./test-fixtures/accommodation.js";
import { VIE, VIENNA } from "./test-fixtures/locations.js";

const viennaStay = stay({
  id: "stay-vienna",
  city: VIENNA,
  checkIn: "2026-12-26",
  checkOut: "2026-12-29",
  amountMinor: 27000,
});

describe("staySchema", () => {
  it("accepts a stay whose nights match its dates", () => {
    expect(viennaStay.nights).toBe(3);
  });

  it("counts nights across the year boundary", () => {
    const newYear = stay({
      id: "stay-ny",
      city: VIENNA,
      checkIn: "2026-12-30",
      checkOut: "2027-01-02",
      amountMinor: 30000,
    });
    expect(newYear.nights).toBe(3);
  });

  it("rejects nights inconsistent with the dates", () => {
    expect(staySchema.safeParse({ ...viennaStay, nights: 2 }).success).toBe(false);
  });

  it("rejects zero-night and reversed stays", () => {
    expect(
      staySchema.safeParse({ ...viennaStay, checkOut: viennaStay.checkIn, nights: 1 }).success,
    ).toBe(false);
    expect(
      staySchema.safeParse({ ...viennaStay, checkIn: "2026-12-29", checkOut: "2026-12-26" }).success,
    ).toBe(false);
  });

  it("must be attached to a city, not an airport", () => {
    expect(staySchema.safeParse({ ...viennaStay, city: VIE }).success).toBe(false);
  });

  it("requires provenance, guests and rooms", () => {
    const { provenance: _provenance, ...withoutProvenance } = viennaStay;
    expect(staySchema.safeParse(withoutProvenance).success).toBe(false);
    expect(staySchema.safeParse({ ...viennaStay, guests: 0 }).success).toBe(false);
    expect(staySchema.safeParse({ ...viennaStay, rooms: 0 }).success).toBe(false);
  });

  it("rejects invalid dates", () => {
    expect(staySchema.safeParse({ ...viennaStay, checkIn: "2026-12-32" }).success).toBe(false);
  });
});
