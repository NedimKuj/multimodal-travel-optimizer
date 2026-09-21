import type { SearchTrace } from "@travel-optimizer/optimizer";
import {
  cityRepository,
  FCO,
  fixtureAirports,
  fixtureGeography,
  roundTrip,
  searchResult,
  stubFlightProvider,
} from "@travel-optimizer/optimizer/test-fixtures";
import { describe, expect, it } from "vitest";

import {
  formatCostBreakdown,
  formatOfferProvenance,
} from "./format.js";
import {
  DEFAULT_SEARCH_FORM,
  mapSearchFormToRequest,
  mappedToApiBody,
} from "./map-search-request.js";
import { runTripSearch } from "../server/run-search.js";

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 21, 12, 0, tick++));
}

const romeTrip = roundTrip({
  id: "rome",
  destination: FCO,
  outbound: ["2026-12-27T10:00+01:00", "2026-12-27T11:30+01:00"],
  inbound: ["2027-01-02T18:00+01:00", "2027-01-02T19:30+01:00"],
  amountMinor: 12000,
});

describe("Trip Explorer end-to-end (form → search → render)", () => {
  it("runs Sarajevo → Anywhere Dec 26–Jan 3 ±2 · 5–7 nights · 2 travelers · €700", async () => {
    const mapped = mapSearchFormToRequest(DEFAULT_SEARCH_FORM);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;

    const body = mappedToApiBody(mapped.mapped);
    expect(body).toMatchObject({
      origin: "SJJ",
      destination: null,
      departureDate: "2026-12-26",
      returnDate: "2027-01-03",
      flexibilityDays: 2,
      minNights: 5,
      maxNights: 7,
      travelers: 2,
      currency: "EUR",
      budget: { kind: "perPerson", amount: "700.00", currency: "EUR" },
    });

    const result = await runTripSearch(mapped.mapped, {
      flightProvider: stubFlightProvider(searchResult([romeTrip])),
      referenceData: {
        airports: fixtureAirports,
        cities: cityRepository,
        geography: fixtureGeography,
      },
      now: fixedClock(),
      newSearchId: () => "ui-search-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const trace: SearchTrace = result.trace;
    expect(trace.searchId).toBe("ui-search-1");
    expect(trace.request.origin).toBe("SJJ");
    expect(trace.request.destination).toBeNull();
    expect(trace.request.travelers).toBe(2);
    expect(trace.destinations.length).toBeGreaterThan(0);

    const [destination] = trace.destinations;
    const [candidate] = destination?.candidates ?? [];
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;

    const costLine = formatCostBreakdown(candidate.summary);
    expect(costLine).toMatch(/Fares|Known cost|Total/);
    expect(costLine.toLowerCase()).not.toContain("expires");

    for (const entry of candidate.summary.accommodation) {
      expect(entry.state).not.toBe("priced");
    }

    const fareOffer = candidate.candidate.offers.find(
      (entry) => entry.provenance.sourceType !== "estimated",
    );
    expect(fareOffer).toBeDefined();
    if (fareOffer === undefined) return;
    const provenance = formatOfferProvenance(fareOffer.provenance);
    expect(provenance).toMatch(/usable until|freshness unknown/);
    expect(provenance.toLowerCase()).not.toContain("guaranteed");
    expect(provenance.toLowerCase()).not.toMatch(/\bexpires\b/);
  });

  it("maps open-jaw / multi-city / one-way onto compose + request flags", () => {
    const openJaw = mapSearchFormToRequest({
      ...DEFAULT_SEARCH_FORM,
      allowOpenJaw: true,
    });
    expect(openJaw.ok).toBe(true);
    if (openJaw.ok) {
      expect(openJaw.mapped.compose).toBe(true);
      expect(openJaw.mapped.input.allowOpenJaw).toBe(true);
    }

    const multi = mapSearchFormToRequest({
      ...DEFAULT_SEARCH_FORM,
      allowMultiCity: true,
    });
    expect(multi.ok).toBe(true);
    if (multi.ok) {
      expect(multi.mapped.compose).toBe(true);
      expect(multi.mapped.input.allowMultiCity).toBe(true);
    }

    const oneWay = mapSearchFormToRequest({
      ...DEFAULT_SEARCH_FORM,
      tripShape: "one_way",
      endDate: "2027-01-03",
    });
    expect(oneWay.ok).toBe(true);
    if (oneWay.ok) {
      expect(oneWay.mapped.compose).toBe(true);
      expect(oneWay.mapped.input.endDate).toBe("2027-01-03");
      expect(oneWay.mapped.input.returnDate).toBeUndefined();
    }
  });
});
