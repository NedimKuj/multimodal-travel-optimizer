import { describe, expect, it } from "vitest";

import type { CurrencyCode } from "./currency.js";
import { convertMoney, exchangeRateSchema, type ExchangeRate } from "./exchange.js";
import { money } from "./money.js";

// Test rates only; not real market data.
function rate(from: CurrencyCode, to: CurrencyCode, value: string): ExchangeRate {
  return exchangeRateSchema.parse({
    from,
    to,
    rate: value,
    provenance: {
      provider: "fixture-rates",
      sourceType: "cached",
      fetchedAt: "2026-09-17T12:00:00Z",
    },
  });
}

describe("exchangeRateSchema", () => {
  it("rejects non-positive, malformed and same-currency rates", () => {
    const base = {
      from: "EUR",
      to: "BAM",
      provenance: { provider: "fixture-rates", sourceType: "cached", fetchedAt: "2026-09-17T12:00:00Z" },
    };
    for (const value of ["0", "0.000", "-1.2", "1,95", "1e2", "", ".5"]) {
      expect(exchangeRateSchema.safeParse({ ...base, rate: value }).success, value).toBe(false);
    }
    expect(exchangeRateSchema.safeParse({ ...base, to: "EUR", rate: "1" }).success).toBe(false);
    expect(exchangeRateSchema.safeParse({ ...base, rate: 1.95583 }).success).toBe(false);
  });

  it("requires provenance", () => {
    expect(exchangeRateSchema.safeParse({ from: "EUR", to: "BAM", rate: "1.95583" }).success).toBe(
      false,
    );
  });
});

describe("convertMoney", () => {
  it("converts exactly with integer arithmetic", () => {
    const result = convertMoney(money(10000, "EUR"), rate("EUR", "BAM", "1.95583"));
    expect(result.converted).toEqual(money(19558, "BAM"));
    expect(result.original).toEqual(money(10000, "EUR"));
  });

  it("accounts for different minor-unit exponents", () => {
    expect(convertMoney(money(10000, "EUR"), rate("EUR", "JPY", "160.5")).converted).toEqual(
      money(16050, "JPY"),
    );
    expect(convertMoney(money(16050, "JPY"), rate("JPY", "EUR", "0.00623")).converted).toEqual(
      money(9999, "EUR"),
    );
    expect(convertMoney(money(10000, "EUR"), rate("EUR", "KWD", "0.3321")).converted).toEqual(
      money(33210, "KWD"),
    );
  });

  it("rounds half to even", () => {
    // 0.05 EUR × 0.5 = 0.025 → 0.02 (even)
    expect(convertMoney(money(5, "EUR"), rate("EUR", "USD", "0.5")).converted.amountMinor).toBe(2);
    // 0.07 EUR × 0.5 = 0.035 → 0.04 (even)
    expect(convertMoney(money(7, "EUR"), rate("EUR", "USD", "0.5")).converted.amountMinor).toBe(4);
    // 0.03 EUR × 0.5 = 0.015 → 0.02
    expect(convertMoney(money(3, "EUR"), rate("EUR", "USD", "0.5")).converted.amountMinor).toBe(2);
    // negatives are symmetric
    expect(convertMoney(money(-5, "EUR"), rate("EUR", "USD", "0.5")).converted.amountMinor).toBe(-2);
  });

  it("rejects a rate for another currency pair", () => {
    expect(() => convertMoney(money(100, "USD"), rate("EUR", "BAM", "1.95583"))).toThrow(
      /Cannot convert USD/,
    );
  });

  it("does not silently convert to the same currency", () => {
    expect(() => rate("EUR", "EUR", "1")).toThrow();
  });
});
