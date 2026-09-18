import { describe, expect, it } from "vitest";

import {
  aviasalesGroupedPricesResponseSchema,
  aviasalesPricesForDatesResponseSchema,
  parseResponse,
} from "./dto.js";
import { ONE_WAY_RECORD, pricesForDatesBody, ROUND_TRIP_RECORD } from "./test-fixtures.js";

describe("parseResponse", () => {
  it("parses a prices_for_dates body", () => {
    const result = parseResponse(
      pricesForDatesBody([ONE_WAY_RECORD, ROUND_TRIP_RECORD]),
      aviasalesPricesForDatesResponseSchema,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a response");
    expect(result.response.data).toHaveLength(2);
    expect(result.response.data[1]?.return_at).toBe("2027-01-08T12:45:00+03:00");
  });

  it("keeps unknown fields from breaking parsing", () => {
    const body = JSON.stringify({
      success: true,
      currency: "eur",
      data: [{ ...ONE_WAY_RECORD, some_new_field: "later" }],
      unexpected_top_level: 1,
    });
    expect(parseResponse(body, aviasalesPricesForDatesResponseSchema).ok).toBe(true);
  });

  it("accepts a numeric flight_number, as the v1 endpoints return", () => {
    const body = pricesForDatesBody([{ ...ONE_WAY_RECORD, flight_number: 98 }]);
    expect(parseResponse(body, aviasalesPricesForDatesResponseSchema).ok).toBe(true);
  });

  it("reports a provider-reported failure separately from a parse failure", () => {
    const body = JSON.stringify({ success: false, error: "bad origin", data: [] });
    const result = parseResponse(body, aviasalesPricesForDatesResponseSchema);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.failure).toMatchObject({ kind: "unsupported_query" });
    expect(result.failure.message).toContain("bad origin");
  });

  it("rejects a body that is not JSON", () => {
    const result = parseResponse("<html>502</html>", aviasalesPricesForDatesResponseSchema);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.failure.kind).toBe("invalid_response");
  });

  it("rejects records missing fields we depend on", () => {
    for (const missing of ["origin_airport", "destination_airport", "departure_at", "price"]) {
      const record = Object.fromEntries(
        Object.entries(ONE_WAY_RECORD).filter(([key]) => key !== missing),
      );
      const result = parseResponse(
        JSON.stringify({ success: true, data: [record] }),
        aviasalesPricesForDatesResponseSchema,
      );
      expect(result.ok, missing).toBe(false);
    }
  });

  it("rejects a price that is not a number", () => {
    const result = parseResponse(
      JSON.stringify({ success: true, data: [{ ...ONE_WAY_RECORD, price: "26" }] }),
      aviasalesPricesForDatesResponseSchema,
    );
    expect(result.ok).toBe(false);
  });

  it("parses grouped_prices, which is keyed by date", () => {
    const body = JSON.stringify({
      success: true,
      currency: "eur",
      data: { "2026-12-26": ONE_WAY_RECORD, "2026-12-27": ROUND_TRIP_RECORD },
    });
    const result = parseResponse(body, aviasalesGroupedPricesResponseSchema);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a response");
    expect(Object.keys(result.response.data)).toEqual(["2026-12-26", "2026-12-27"]);
  });
});
