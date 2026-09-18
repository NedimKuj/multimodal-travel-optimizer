import type { AviasalesPriceRecord } from "./dto.js";

/*
 * Synthetic responses shaped like the ones observed on 2026-09-18
 * (docs/phase-0-aviasales-findings.md).
 *
 * These are TEST INPUTS, not provider data: prices, flight numbers and times
 * are made up. Real captures stay in the gitignored .probe/ directory because
 * redistribution terms are unverified (docs/provider-compliance.md).
 */

export const ONE_WAY_RECORD: AviasalesPriceRecord = {
  origin: "SJJ",
  destination: "ROM",
  origin_airport: "SJJ",
  destination_airport: "FCO",
  departure_at: "2026-12-26T17:10:00+01:00",
  airline: "W4",
  flight_number: "6160",
  price: 26,
  gate: "Test Agency",
  duration: 85,
  duration_to: 85,
  duration_back: 0,
  transfers: 0,
  return_transfers: 0,
  link: "/search/SJJ2612ROM1?t=test-token-placeholder",
};

export const ROUND_TRIP_RECORD: AviasalesPriceRecord = {
  origin: "SJJ",
  destination: "IST",
  origin_airport: "SJJ",
  destination_airport: "SAW",
  departure_at: "2026-12-30T13:50:00+01:00",
  return_at: "2027-01-08T12:45:00+03:00",
  airline: "VF",
  flight_number: "98",
  price: 79,
  gate: "Test Agency",
  duration: 240,
  duration_to: 115,
  duration_back: 125,
  transfers: 0,
  return_transfers: 1,
  link: "/search/SJJ3012IST08011?t=test-token-placeholder",
};

export function pricesForDatesBody(records: readonly AviasalesPriceRecord[]): string {
  return JSON.stringify({ success: true, currency: "eur", data: records });
}
