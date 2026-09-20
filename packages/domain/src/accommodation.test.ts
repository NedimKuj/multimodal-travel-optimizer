import { describe, expect, it } from "vitest";

import {
  accommodationStaySchema,
  citiesOf,
  coverageOf,
  stayPrice,
  staySchema,
} from "./accommodation.js";
import { stay } from "./test-fixtures/accommodation.js";
import { PRAGUE, VIE, VIENNA } from "./test-fixtures/locations.js";

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

describe("accommodationStaySchema", () => {
  const interval = { checkIn: "2026-12-26", checkOut: "2026-12-29", nights: 3 };

  it("accepts a priced stay carrying its Stay", () => {
    const entry = accommodationStaySchema.parse({
      state: "priced",
      city: VIENNA,
      ...interval,
      stay: viennaStay,
    });
    expect(coverageOf(entry)).toEqual({ state: "priced" });
    expect(stayPrice(entry)).toEqual({ amountMinor: 27000, currency: "EUR" });
    expect(citiesOf(entry)).toEqual([VIENNA]);
  });

  it("accepts a stay no query was made for, with the reason why", () => {
    const entry = accommodationStaySchema.parse({
      state: "not_searched",
      reason: "no_provider",
      city: VIENNA,
      ...interval,
    });
    expect(coverageOf(entry)).toEqual({ state: "not_searched", reason: "no_provider" });
    expect(stayPrice(entry)).toBeUndefined();
  });

  it("keeps an empty answer and an unreachable provider apart", () => {
    const empty = accommodationStaySchema.parse({
      state: "unpriced",
      reason: "provider_no_results",
      city: VIENNA,
      ...interval,
    });
    const outage = accommodationStaySchema.parse({
      state: "unpriced",
      reason: "provider_unavailable",
      city: VIENNA,
      ...interval,
    });
    // Same state — we hold no price either way — different facts.
    expect(empty.state).toBe(outage.state);
    expect(coverageOf(empty).reason).not.toBe(coverageOf(outage).reason);
    expect(stayPrice(empty)).toBeUndefined();
    expect(stayPrice(outage)).toBeUndefined();
  });

  it("accepts an unresolved stay naming every city it spans", () => {
    const entry = accommodationStaySchema.parse({
      state: "unresolved",
      reason: "unresolved_open_jaw_split",
      cities: [VIENNA, PRAGUE],
      ...interval,
    });
    expect(citiesOf(entry)).toEqual([VIENNA, PRAGUE]);
    expect(stayPrice(entry)).toBeUndefined();
  });
});

describe("accommodationStaySchema — invariants the union enforces", () => {
  const interval = { checkIn: "2026-12-26", checkOut: "2026-12-29", nights: 3 };

  it("refuses an unresolved stay that names a single city", () => {
    // The whole point of `unresolved` is that we cannot say which city the
    // nights belong to, so the model must not be able to express a guess.
    expect(
      accommodationStaySchema.safeParse({
        state: "unresolved",
        reason: "unresolved_open_jaw_split",
        city: VIENNA,
        ...interval,
      }).success,
    ).toBe(false);
    expect(
      accommodationStaySchema.safeParse({
        state: "unresolved",
        reason: "unresolved_open_jaw_split",
        cities: [VIENNA],
        ...interval,
      }).success,
    ).toBe(false);
  });

  it("refuses a priced stay with no Stay to price it", () => {
    // An absent price must not be summable as zero.
    expect(
      accommodationStaySchema.safeParse({ state: "priced", city: VIENNA, ...interval }).success,
    ).toBe(false);
  });

  it("refuses a state it does not know", () => {
    expect(
      accommodationStaySchema.safeParse({ state: "estimated", city: VIENNA, ...interval }).success,
    ).toBe(false);
  });

  it("refuses nights that do not match the dates", () => {
    expect(
      accommodationStaySchema.safeParse({
        state: "not_searched",
        reason: "outside_shortlist",
        city: VIENNA,
        checkIn: "2026-12-26",
        checkOut: "2026-12-29",
        nights: 5,
      }).success,
    ).toBe(false);
  });

  it("refuses accommodation attached to an airport", () => {
    expect(
      accommodationStaySchema.safeParse({
        state: "not_searched",
        reason: "outside_shortlist",
        city: VIE,
        ...interval,
      }).success,
    ).toBe(false);
  });
});
