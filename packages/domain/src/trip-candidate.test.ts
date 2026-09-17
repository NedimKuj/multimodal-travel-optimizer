import { describe, expect, it } from "vitest";

import { compareMoney, money } from "./money/money.js";
import { stay } from "./test-fixtures/accommodation.js";
import {
  PRAGUE,
  PRAHA_HLAVNI,
  PRG,
  SJJ,
  VIE,
  VIENNA,
  WIEN_HBF,
} from "./test-fixtures/locations.js";
import { offer, segment } from "./test-fixtures/transport.js";
import {
  summarizeTrip,
  tripCandidateSchema,
  validateTripCandidate,
  type TripCandidate,
  type TripSummary,
} from "./trip-candidate.js";

// ── Fixtures (test inputs only, not real fares) ──────────────────────────────

const sjjToVie = segment({
  id: "seg-sjj-vie",
  mode: "flight",
  origin: SJJ,
  destination: VIE,
  departure: "2026-12-26T10:00+01:00",
  arrival: "2026-12-26T11:15+01:00",
});

const vieToSjj = segment({
  id: "seg-vie-sjj",
  mode: "flight",
  origin: VIE,
  destination: SJJ,
  departure: "2027-01-02T18:00+01:00",
  arrival: "2027-01-02T19:15+01:00",
});

const prgToSjj = segment({
  id: "seg-prg-sjj",
  mode: "flight",
  origin: PRG,
  destination: SJJ,
  departure: "2027-01-02T18:00+01:00",
  arrival: "2027-01-02T19:40+01:00",
});

const viennaToPragueTrain = segment({
  id: "seg-train-wien-praha",
  mode: "train",
  origin: WIEN_HBF,
  destination: PRAHA_HLAVNI,
  departure: "2026-12-29T10:00+01:00",
  arrival: "2026-12-29T14:00+01:00",
});

const viennaWeek = stay({
  id: "stay-vienna-week",
  city: VIENNA,
  checkIn: "2026-12-26",
  checkOut: "2027-01-02",
  amountMinor: 63000,
});

const viennaThreeNights = stay({
  id: "stay-vienna",
  city: VIENNA,
  checkIn: "2026-12-26",
  checkOut: "2026-12-29",
  amountMinor: 27000,
});

const pragueFourNights = stay({
  id: "stay-prague",
  city: PRAGUE,
  checkIn: "2026-12-29",
  checkOut: "2027-01-02",
  amountMinor: 32000,
});

function trip(fields: Omit<TripCandidate, "origin" | "travelers"> & Partial<TripCandidate>): TripCandidate {
  return tripCandidateSchema.parse({ origin: SJJ, travelers: 2, ...fields });
}

const roundTrip = trip({
  id: "round-trip",
  segments: [sjjToVie, vieToSjj],
  offers: [offer({ id: "offer-rt", segmentIds: [sjjToVie.id, vieToSjj.id], amountMinor: 15000 })],
  stays: [viennaWeek],
});

const openJaw = trip({
  id: "open-jaw",
  segments: [sjjToVie, prgToSjj],
  offers: [
    offer({ id: "offer-out", segmentIds: [sjjToVie.id], amountMinor: 7500 }),
    offer({ id: "offer-back", segmentIds: [prgToSjj.id], amountMinor: 9000 }),
  ],
  stays: [viennaThreeNights, pragueFourNights],
});

const multiCity = trip({
  id: "multi-city",
  segments: [sjjToVie, viennaToPragueTrain, prgToSjj],
  offers: [
    offer({ id: "offer-out", segmentIds: [sjjToVie.id], amountMinor: 7500 }),
    offer({ id: "offer-train", segmentIds: [viennaToPragueTrain.id], amountMinor: 2500 }),
    offer({ id: "offer-back", segmentIds: [prgToSjj.id], amountMinor: 9000 }),
  ],
  stays: [viennaThreeNights, pragueFourNights],
});

function summary(candidate: TripCandidate): TripSummary {
  const result = summarizeTrip(candidate);
  if (!result.ok) {
    throw new Error(result.issues.map((entry) => entry.code).join(", "));
  }
  return result.summary;
}

function issueCodes(candidate: TripCandidate): string[] {
  return validateTripCandidate(candidate).map((entry) => entry.code);
}

// ── Valid structures ─────────────────────────────────────────────────────────

describe("valid trip structures", () => {
  it("accepts a round trip priced by a single round-trip fare", () => {
    expect(issueCodes(roundTrip)).toEqual([]);
  });

  it("accepts an open-jaw trip (SJJ → VIE, PRG → SJJ)", () => {
    expect(issueCodes(openJaw)).toEqual([]);
  });

  it("accepts a multi-city trip (SJJ → VIE → PRG → SJJ)", () => {
    expect(issueCodes(multiCity)).toEqual([]);
  });

  it("derives departure and return dates from the itinerary", () => {
    expect(summary(openJaw)).toMatchObject({
      departureDate: "2026-12-26",
      returnDate: "2027-01-02",
    });
  });

  it("derives destinations in visiting order", () => {
    expect(summary(multiCity).destinations.map((city) => city.name)).toEqual(["Vienna", "Prague"]);
    expect(summary(roundTrip).destinations.map((city) => city.name)).toEqual(["Vienna"]);
  });
});

// ── Cost ─────────────────────────────────────────────────────────────────────

describe("trip cost", () => {
  it("counts a fare covering two segments once", () => {
    const { cost } = summary(roundTrip);
    expect(cost.transport).toEqual(money(30000, "EUR")); // 150.00 × 2 travelers, once
    expect(cost.accommodation).toEqual(money(63000, "EUR"));
    expect(cost.total).toEqual(money(93000, "EUR"));
    expect(cost.perPersonShares).toEqual([money(46500, "EUR"), money(46500, "EUR")]);
  });

  it("sums offers and stays for multi-city trips", () => {
    const { cost, nights } = summary(multiCity);
    expect(cost.transport).toEqual(money(38000, "EUR"));
    expect(cost.accommodation).toEqual(money(59000, "EUR"));
    expect(cost.total).toEqual(money(97000, "EUR"));
    expect(nights).toBe(7);
  });

  it("uses total-basis prices without multiplying them", () => {
    const candidate = trip({
      ...roundTrip,
      offers: [
        offer({
          id: "offer-rt-total",
          segmentIds: [sjjToVie.id, vieToSjj.id],
          amountMinor: 29000,
          priceBasis: { kind: "total", travelers: 2 },
        }),
      ],
    });
    expect(summary(candidate).cost.transport).toEqual(money(29000, "EUR"));
  });

  it("splits odd totals into per-person shares that sum to the total", () => {
    const candidate = trip({
      ...roundTrip,
      travelers: 3,
      offers: [
        offer({
          id: "offer-rt-total",
          segmentIds: [sjjToVie.id, vieToSjj.id],
          amountMinor: 1,
          priceBasis: { kind: "total", travelers: 3 },
        }),
      ],
      stays: [{ ...viennaWeek, guests: 3 }],
    });
    const { cost } = summary(candidate);
    expect(cost.total.amountMinor).toBe(63001);
    expect(cost.perPersonShares.map((share) => share.amountMinor)).toEqual([21001, 21000, 21000]);
  });

  it("ranks by complete-trip cost: cheaper transport with a pricier hotel loses", () => {
    // Transport €50 cheaper in total, accommodation €100 more expensive.
    const cheaperTicketTrip = trip({
      ...roundTrip,
      id: "cheaper-ticket",
      offers: [offer({ id: "o", segmentIds: [sjjToVie.id, vieToSjj.id], amountMinor: 12500 })],
      stays: [{ ...viennaWeek, price: money(73000, "EUR") }],
    });
    const cheaperTicket = summary(cheaperTicketTrip).cost;
    const genuinelyCheaper = summary(roundTrip).cost;
    expect(compareMoney(cheaperTicket.transport, genuinelyCheaper.transport)).toBe(-1);
    expect(compareMoney(genuinelyCheaper.total, cheaperTicket.total)).toBe(-1);
  });

  it("never produces a cost for an invalid trip", () => {
    const unpriced = trip({ ...openJaw, offers: openJaw.offers.slice(0, 1) });
    const result = summarizeTrip(unpriced);
    expect(result.ok).toBe(false);
    expect("summary" in result).toBe(false);
  });
});

// ── Time, transfers, provenance ──────────────────────────────────────────────

describe("time and transfers", () => {
  it("separates moving time from total duration", () => {
    const result = summary(multiCity);
    expect(result.travelTimeMinutes).toBe(75 + 240 + 100);
    expect(result.totalDurationMinutes).toBe(7 * 24 * 60 + 9 * 60 + 40);
  });

  it("counts changes without a stay in between, plus in-segment transfers", () => {
    const sameDayTrain = segment({
      id: "seg-same-day-train",
      mode: "train",
      origin: WIEN_HBF,
      destination: PRAHA_HLAVNI,
      departure: "2026-12-26T15:00+01:00",
      arrival: "2026-12-26T19:00+01:00",
    });
    const oneStopReturn = segment({
      id: "seg-prg-sjj-1stop",
      mode: "flight",
      origin: PRG,
      destination: SJJ,
      departure: "2027-01-02T08:00+01:00",
      arrival: "2027-01-02T14:30+01:00",
      transfers: 1,
    });
    const candidate = trip({
      id: "transfers",
      segments: [sjjToVie, sameDayTrain, oneStopReturn],
      offers: [
        offer({ id: "o1", segmentIds: [sjjToVie.id], amountMinor: 7500 }),
        offer({ id: "o2", segmentIds: [sameDayTrain.id], amountMinor: 2500 }),
        offer({ id: "o3", segmentIds: [oneStopReturn.id], amountMinor: 9000 }),
      ],
      stays: [stay({ id: "p", city: PRAGUE, checkIn: "2026-12-26", checkOut: "2027-01-02", amountMinor: 50000 })],
    });
    expect(summary(candidate).transfers).toBe(2);
  });

  it("reports no transfers when every change has a stay", () => {
    expect(summary(multiCity).transfers).toBe(0);
  });
});

describe("provenance", () => {
  it("is only as strong as the weakest price", () => {
    const candidate = trip({
      ...roundTrip,
      offers: [
        offer({ id: "live", segmentIds: [sjjToVie.id, vieToSjj.id], amountMinor: 15000, sourceType: "live" }),
      ],
      stays: [viennaWeek], // cached
    });
    expect(summary(candidate).sourceType).toBe("cached");
  });

  it("is live only when every price is live", () => {
    const candidate = trip({
      ...roundTrip,
      offers: [
        offer({ id: "live", segmentIds: [sjjToVie.id, vieToSjj.id], amountMinor: 15000, sourceType: "live" }),
      ],
      stays: [],
    });
    expect(summary(candidate)).toMatchObject({ sourceType: "live", sources: ["fixture"] });
  });
});

// ── Invalid structures ───────────────────────────────────────────────────────

describe("invalid trips", () => {
  it("rejects a trip without segments", () => {
    expect(issueCodes(trip({ id: "empty", segments: [], offers: [], stays: [] }))).toEqual([
      "TRIP_WITHOUT_SEGMENTS",
    ]);
  });

  it("rejects a trip that does not start at the origin", () => {
    expect(issueCodes({ ...openJaw, origin: PRG })).toEqual(["TRIP_DOES_NOT_START_AT_ORIGIN"]);
  });

  it("rejects segments out of chronological order", () => {
    const candidate = { ...multiCity, segments: [sjjToVie, prgToSjj, viennaToPragueTrain] };
    expect(issueCodes(candidate)).toContain("SEGMENTS_NOT_CHRONOLOGICAL");
  });

  it("rejects a segment without an offer rather than treating it as free", () => {
    const candidate = { ...multiCity, offers: multiCity.offers.filter((o) => o.id !== "offer-train") };
    expect(issueCodes(candidate)).toEqual(["UNPRICED_SEGMENT"]);
  });

  it("rejects a segment priced by two offers", () => {
    const candidate = {
      ...roundTrip,
      offers: [
        ...roundTrip.offers,
        offer({ id: "offer-one-way", segmentIds: [sjjToVie.id], amountMinor: 7000 }),
      ],
    };
    expect(issueCodes(candidate)).toEqual(["SEGMENT_PRICED_MORE_THAN_ONCE"]);
  });

  it("rejects an offer for a segment outside the trip", () => {
    const candidate = {
      ...openJaw,
      offers: [...openJaw.offers, offer({ id: "stray", segmentIds: [vieToSjj.id], amountMinor: 1 })],
    };
    expect(issueCodes(candidate)).toEqual(["OFFER_UNKNOWN_SEGMENT"]);
  });

  it("rejects a total price quoted for a different party size", () => {
    const candidate = {
      ...roundTrip,
      offers: [
        offer({
          id: "for-one",
          segmentIds: [sjjToVie.id, vieToSjj.id],
          amountMinor: 15000,
          priceBasis: { kind: "total", travelers: 1 },
        }),
      ],
    };
    expect(issueCodes(candidate)).toEqual(["PRICE_BASIS_MISMATCH"]);
  });

  it("rejects overlapping stays", () => {
    const overlapping = stay({ id: "prague-early", city: PRAGUE, checkIn: "2026-12-28", checkOut: "2027-01-02", amountMinor: 40000 });
    expect(issueCodes({ ...openJaw, stays: [viennaThreeNights, overlapping] })).toEqual([
      "OVERLAPPING_STAYS",
    ]);
  });

  it("rejects accommodation booked after the traveler has departed", () => {
    const tooLong = stay({ id: "too-long", city: VIENNA, checkIn: "2026-12-26", checkOut: "2027-01-03", amountMinor: 72000 });
    expect(issueCodes({ ...roundTrip, stays: [tooLong] })).toEqual(["STAY_OUTSIDE_GROUND_TIME"]);
  });

  it("rejects accommodation starting before arrival", () => {
    const early = stay({ id: "early", city: VIENNA, checkIn: "2026-12-25", checkOut: "2027-01-02", amountMinor: 72000 });
    expect(issueCodes({ ...roundTrip, stays: [early] })).toEqual(["STAY_OUTSIDE_GROUND_TIME"]);
  });

  it("uses the local arrival date across midnight for stay alignment", () => {
    // Departs 22:30 on 26 Dec, lands 00:40 on 27 Dec local time.
    const lateFlight = segment({
      id: "seg-late",
      mode: "flight",
      origin: SJJ,
      destination: VIE,
      departure: "2026-12-26T22:30+01:00",
      arrival: "2026-12-27T00:40+01:00",
    });
    const candidate = trip({
      id: "late",
      segments: [lateFlight, vieToSjj],
      offers: [offer({ id: "rt", segmentIds: [lateFlight.id, vieToSjj.id], amountMinor: 15000 })],
      stays: [viennaWeek],
    });
    expect(issueCodes(candidate)).toEqual(["STAY_OUTSIDE_GROUND_TIME"]);
  });

  it("rejects stays for a different party size", () => {
    expect(issueCodes({ ...roundTrip, stays: [{ ...viennaWeek, guests: 1 }] })).toEqual([
      "STAY_GUEST_COUNT_MISMATCH",
    ]);
  });

  it("rejects mixed currencies instead of adding them", () => {
    const bamStay = { ...viennaWeek, price: money(123000, "BAM") };
    expect(issueCodes({ ...roundTrip, stays: [bamStay] })).toEqual(["MIXED_CURRENCIES"]);
    expect(summarizeTrip({ ...roundTrip, stays: [bamStay] }).ok).toBe(false);
  });

  it("rejects duplicate ids", () => {
    const duplicateStay = { ...pragueFourNights, id: viennaThreeNights.id };
    expect(issueCodes({ ...openJaw, stays: [viennaThreeNights, duplicateStay] })).toEqual([
      "DUPLICATE_STAY_ID",
    ]);
  });

  it("reports every issue at once", () => {
    const candidate = {
      ...multiCity,
      offers: multiCity.offers.filter((o) => o.id !== "offer-train"),
      stays: [{ ...viennaThreeNights, guests: 1 }, pragueFourNights],
    };
    expect(issueCodes(candidate)).toEqual(["UNPRICED_SEGMENT", "STAY_GUEST_COUNT_MISMATCH"]);
  });
});
