import {
  money,
  parseLocalDate,
  parseUtcInstant,
  type AccommodationStay,
  type ItineraryGap,
  type Money,
  type PriceProvenance,
  type TripSummary,
} from "@travel-optimizer/domain";
import type { RankedCandidate } from "@travel-optimizer/optimizer";
import { FCO, ROME, SJJ } from "@travel-optimizer/optimizer/test-fixtures";
import { describe, expect, it } from "vitest";

import {
  formatAccommodationState,
  formatCostBreakdown,
  formatGap,
  formatMoney,
  formatOfferProvenance,
  itineraryPatternLabel,
} from "./format.js";
import {
  apiBodyToSearchInput,
  DEFAULT_SEARCH_FORM,
  mapSearchFormToRequest,
  mappedToApiBody,
  type SearchFormState,
} from "./map-search-request.js";

function form(overrides: Partial<SearchFormState> = {}): SearchFormState {
  return { ...DEFAULT_SEARCH_FORM, ...overrides };
}

describe("mapSearchFormToRequest", () => {
  it("maps the default Sarajevo → Anywhere scenario", () => {
    const result = mapSearchFormToRequest(form());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.mapped.input).toMatchObject({
      origin: "SJJ",
      destination: null,
      departureDate: "2026-12-26",
      returnDate: "2027-01-03",
      flexibilityDays: 2,
      minNights: 5,
      maxNights: 7,
      travelers: 2,
      allowOpenJaw: false,
      allowMultiCity: false,
      alternativeAirports: false,
      transportModes: ["flight"],
    });
    expect(result.mapped.input.budget).toEqual({
      kind: "perPerson",
      amount: money(70000, "EUR"),
    });
    expect(result.mapped.currency).toBe("EUR");
    expect(result.mapped.compose).toBe(false);
  });

  it("maps a specific destination and rejects Anywhere as a fake code", () => {
    const specific = mapSearchFormToRequest(
      form({ destinationAnywhere: false, destination: "vie" }),
    );
    expect(specific.ok).toBe(true);
    if (specific.ok) expect(specific.mapped.input.destination).toBe("VIE");

    const fake = mapSearchFormToRequest(
      form({ destinationAnywhere: false, destination: "ANYWHERE" }),
    );
    expect(fake.ok).toBe(false);
  });

  it("maps one-way to endDate without returnDate", () => {
    const result = mapSearchFormToRequest(
      form({ tripShape: "one_way", endDate: "2027-01-03" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mapped.input.returnDate).toBeUndefined();
    expect(result.mapped.input.endDate).toBe("2027-01-03");
    expect(result.mapped.compose).toBe(true);
  });

  it("forces compose for open-jaw and multi-city", () => {
    const openJaw = mapSearchFormToRequest(form({ allowOpenJaw: true, compose: false }));
    expect(openJaw.ok).toBe(true);
    if (openJaw.ok) expect(openJaw.mapped.compose).toBe(true);

    const multi = mapSearchFormToRequest(form({ allowMultiCity: true, compose: false }));
    expect(multi.ok).toBe(true);
    if (multi.ok) expect(multi.mapped.compose).toBe(true);
  });

  it("maps total budget, transport modes and alternative airports", () => {
    const result = mapSearchFormToRequest(
      form({
        budgetKind: "total",
        budgetAmount: "1400",
        transportModes: ["flight", "train", "bus"],
        alternativeAirports: true,
        compose: true,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mapped.input.budget?.kind).toBe("total");
    expect(result.mapped.input.transportModes).toEqual(["flight", "train", "bus"]);
    expect(result.mapped.input.alternativeAirports).toBe(true);
    expect(result.mapped.compose).toBe(true);
  });

  it("round-trips through the API body without losing semantics", () => {
    const mapped = mapSearchFormToRequest(form({ allowOpenJaw: true, budgetAmount: "700.50" }));
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;

    const body = mappedToApiBody(mapped.mapped);
    expect(body.destination).toBeNull();
    expect(body.budget?.amount).toBe("700.50");
    expect(body.compose).toBe(true);

    const again = apiBodyToSearchInput(body);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.mapped.input.budget).toEqual(mapped.mapped.input.budget);
    expect(again.mapped.compose).toBe(true);
  });
});

describe("cost and provenance rendering", () => {
  it("formats money with currency and never invents zero for gaps", () => {
    expect(formatMoney(money(30600, "EUR"))).toBe("306.00 EUR");
    const gap: ItineraryGap = {
      id: "gap-1",
      from: FCO,
      to: SJJ,
      distanceKm: 250,
      status: "unpriced",
      reason: "no_licensed_source",
    };
    const withDistance = formatGap(gap);
    expect(withDistance).toContain("transport price unavailable");
    expect(withDistance).not.toMatch(/0\.00|€0|\b0 EUR\b/);
  });

  it("labels accommodation not_searched distinctly from unpriced", () => {
    const notSearched: AccommodationStay = {
      state: "not_searched",
      city: ROME,
      checkIn: parseLocalDate("2026-12-26"),
      checkOut: parseLocalDate("2027-01-01"),
      nights: 6,
      reason: "no_provider",
    };
    const unpriced: AccommodationStay = {
      state: "unpriced",
      city: ROME,
      checkIn: parseLocalDate("2026-12-26"),
      checkOut: parseLocalDate("2027-01-01"),
      nights: 6,
      reason: "provider_no_results",
    };
    expect(formatAccommodationState(notSearched)).toContain("not searched");
    expect(formatAccommodationState(unpriced)).toContain("unpriced");
  });

  it("uses usable until wording, never fare guaranteed / expires", () => {
    const provenance: PriceProvenance = {
      provider: "aviasales",
      sourceType: "cached",
      fetchedAt: parseUtcInstant("2026-09-21T12:00:00Z"),
      expiresAt: parseUtcInstant("2026-09-22T12:00:00Z"),
    };
    const text = formatOfferProvenance(provenance);
    expect(text).toContain("cached price");
    expect(text).toContain("checked 2026-09-21 12:00Z");
    expect(text).toContain("usable until 2026-09-22 12:00");
    expect(text.toLowerCase()).not.toContain("expires");
    expect(text.toLowerCase()).not.toContain("guaranteed");
  });

  it("keeps estimated transfers visible in the cost breakdown", () => {
    const zero = money(0, "EUR");
    const fares: Money = money(30600, "EUR");
    const transfer: Money = money(1800, "EUR");
    const total: Money = money(32400, "EUR");
    const summary: TripSummary = {
      departureDate: parseLocalDate("2026-12-26"),
      returnDate: parseLocalDate("2027-01-03"),
      tripEndDate: parseLocalDate("2027-01-03"),
      destinations: [],
      nights: 6,
      uncoveredNights: [
        parseLocalDate("2026-12-26"),
        parseLocalDate("2026-12-27"),
        parseLocalDate("2026-12-28"),
        parseLocalDate("2026-12-29"),
        parseLocalDate("2026-12-30"),
        parseLocalDate("2026-12-31"),
      ],
      cost: {
        transport: total,
        fares,
        groundTransfer: transfer,
        accommodation: zero,
        estimated: transfer,
        total,
        scope: "transport_and_partial_accommodation",
        exclusions: ["accommodation"],
        perPersonShares: [money(16200, "EUR"), money(16200, "EUR")],
      },
      travelTimeMinutes: 240,
      totalJourneyDurationMinutes: 400,
      legs: 4,
      stops: 0,
      connections: 0,
      provenance: {
        fareSourceType: "cached",
        fareSources: ["aviasales"],
        estimatedComponents: ["access_transfer"],
        estimateSources: ["distance_model"],
        partiallyEstimated: true,
      },
      unpricedGaps: [],
      accommodation: [],
    };
    const text = formatCostBreakdown(summary);
    expect(text).toContain("Fares 306.00 EUR (cached)");
    expect(text).toContain("Transfers 18.00 EUR estimated");
    expect(text).toContain("Known cost 324.00 EUR");
  });
});

describe("itineraryPatternLabel", () => {
  it("labels one-way from endsAt rather than as round trip", () => {
    const candidate = {
      nights: 5,
      nightsByStay: [5],
      stayIntervals: [],
      candidate: {
        id: "ow",
        origin: SJJ,
        travelers: 1,
        segments: [],
        offers: [],
        stays: [],
        gaps: [],
        accommodation: [],
        endsAt: parseLocalDate("2027-01-03"),
      },
      summary: {
        departureDate: parseLocalDate("2026-12-26"),
        tripEndDate: parseLocalDate("2027-01-03"),
        destinations: [],
        nights: 5,
        uncoveredNights: [],
        cost: {
          transport: money(10000, "EUR"),
          fares: money(10000, "EUR"),
          groundTransfer: money(0, "EUR"),
          accommodation: money(0, "EUR"),
          estimated: money(0, "EUR"),
          total: money(10000, "EUR"),
          scope: "transport_and_partial_accommodation" as const,
          exclusions: ["accommodation" as const],
          perPersonShares: [money(10000, "EUR")],
        },
        travelTimeMinutes: 100,
        totalJourneyDurationMinutes: 100,
        legs: 1,
        stops: 0,
        connections: 0,
        provenance: {
          fareSourceType: "cached" as const,
          fareSources: ["aviasales"],
          estimatedComponents: [],
          estimateSources: [],
          partiallyEstimated: false,
        },
        unpricedGaps: [],
        accommodation: [],
      },
    } satisfies RankedCandidate;
    expect(itineraryPatternLabel(candidate)).toBe("one-way");
  });
});
