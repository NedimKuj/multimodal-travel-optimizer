import { describe, expect, it } from "vitest";

import { isCurrencyCode, minorUnitDigits, parseCurrencyCode } from "./currency.js";
import {
  addMoney,
  allocateEvenly,
  compareMoney,
  CurrencyMismatchError,
  money,
  moneyEquals,
  moneySchema,
  multiplyMoney,
  parseMoney,
  subtractMoney,
  sumMoney,
  toDecimalString,
} from "./money.js";

describe("currency registry", () => {
  it("knows ISO 4217 minor-unit exponents", () => {
    expect(minorUnitDigits("EUR")).toBe(2);
    expect(minorUnitDigits("BAM")).toBe(2);
    expect(minorUnitDigits("JPY")).toBe(0);
    expect(minorUnitDigits("KWD")).toBe(3);
  });

  it("rejects unknown currencies instead of guessing", () => {
    expect(isCurrencyCode("XYZ")).toBe(false);
    expect(isCurrencyCode("eur")).toBe(false);
    expect(() => parseCurrencyCode("XYZ")).toThrow(/Unsupported currency/);
  });
});

describe("money construction", () => {
  it("requires safe integer minor units", () => {
    expect(money(12345, "EUR")).toEqual({ amountMinor: 12345, currency: "EUR" });
    expect(() => money(123.45, "EUR")).toThrow(/safe integer/);
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, "EUR")).toThrow(/safe integer/);
    expect(() => money(Number.NaN, "EUR")).toThrow(/safe integer/);
  });

  it("validates external data with a schema", () => {
    expect(moneySchema.safeParse({ amountMinor: 100, currency: "EUR" }).success).toBe(true);
    expect(moneySchema.safeParse({ amountMinor: 1.5, currency: "EUR" }).success).toBe(false);
    expect(moneySchema.safeParse({ amountMinor: 100, currency: "XYZ" }).success).toBe(false);
    expect(moneySchema.safeParse({ amountMinor: "100", currency: "EUR" }).success).toBe(false);
  });
});

describe("parseMoney", () => {
  it("parses decimals into minor units per currency", () => {
    expect(parseMoney("123.45", "EUR").amountMinor).toBe(12345);
    expect(parseMoney("75", "EUR").amountMinor).toBe(7500);
    expect(parseMoney("0.5", "EUR").amountMinor).toBe(50);
    expect(parseMoney("-12.30", "EUR").amountMinor).toBe(-1230);
    expect(parseMoney("1500", "JPY").amountMinor).toBe(1500);
    expect(parseMoney("1.234", "KWD").amountMinor).toBe(1234);
  });

  it("avoids floating-point error", () => {
    // 0.1 + 0.2 style inputs must stay exact.
    expect(parseMoney("0.29", "EUR").amountMinor).toBe(29);
    expect(parseMoney("1.15", "EUR").amountMinor).toBe(115);
  });

  it("rejects more precision than the currency allows instead of rounding", () => {
    expect(() => parseMoney("12.345", "EUR")).toThrow(/fractional digits/);
    expect(() => parseMoney("1.5", "JPY")).toThrow(/fractional digits/);
  });

  it("rejects malformed input", () => {
    for (const input of ["", "abc", "1,50", "1.", ".5", "1e3", " 1", "+1"]) {
      expect(() => parseMoney(input, "EUR")).toThrow(/Not a decimal/);
    }
  });

  it("rejects amounts outside the safe integer range", () => {
    expect(() => parseMoney("90071992547409.92", "EUR")).toThrow(/out of range/);
  });
});

describe("toDecimalString", () => {
  it("formats according to the currency exponent", () => {
    expect(toDecimalString(money(12345, "EUR"))).toBe("123.45");
    expect(toDecimalString(money(5, "EUR"))).toBe("0.05");
    expect(toDecimalString(money(-5, "EUR"))).toBe("-0.05");
    expect(toDecimalString(money(1500, "JPY"))).toBe("1500");
    expect(toDecimalString(money(1234, "KWD"))).toBe("1.234");
  });

  it("round-trips with parseMoney", () => {
    for (const input of ["0.00", "123.45", "-99.99", "700.00"]) {
      expect(toDecimalString(parseMoney(input, "EUR"))).toBe(input);
    }
  });
});

describe("arithmetic", () => {
  it("adds, subtracts and multiplies in the same currency", () => {
    expect(addMoney(money(7500, "EUR"), money(2500, "EUR"))).toEqual(money(10000, "EUR"));
    expect(subtractMoney(money(7500, "EUR"), money(2500, "EUR"))).toEqual(money(5000, "EUR"));
    expect(multiplyMoney(money(70000, "EUR"), 2)).toEqual(money(140000, "EUR"));
  });

  it("never combines different currencies implicitly", () => {
    expect(() => addMoney(money(100, "EUR"), money(100, "BAM"))).toThrow(CurrencyMismatchError);
    expect(() => subtractMoney(money(100, "EUR"), money(100, "USD"))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => compareMoney(money(100, "EUR"), money(100, "USD"))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => sumMoney([money(100, "BAM")], "EUR")).toThrow(CurrencyMismatchError);
  });

  it("rejects non-integer multiplication factors", () => {
    expect(() => multiplyMoney(money(100, "EUR"), 1.5)).toThrow(/integer/);
  });

  it("detects overflow", () => {
    expect(() => addMoney(money(Number.MAX_SAFE_INTEGER, "EUR"), money(1, "EUR"))).toThrow(
      /safe integer/,
    );
  });

  it("sums lists, with an empty list summing to zero", () => {
    expect(sumMoney([], "EUR")).toEqual(money(0, "EUR"));
    expect(sumMoney([money(18000, "EUR"), money(5500, "EUR"), money(31000, "EUR")], "EUR")).toEqual(
      money(54500, "EUR"),
    );
  });

  it("compares and checks equality", () => {
    expect(compareMoney(money(1, "EUR"), money(2, "EUR"))).toBe(-1);
    expect(compareMoney(money(2, "EUR"), money(2, "EUR"))).toBe(0);
    expect(compareMoney(money(3, "EUR"), money(2, "EUR"))).toBe(1);
    expect(moneyEquals(money(2, "EUR"), money(2, "EUR"))).toBe(true);
    expect(moneyEquals(money(2, "EUR"), money(2, "BAM"))).toBe(false);
  });
});

describe("allocateEvenly", () => {
  it("splits divisible totals exactly", () => {
    expect(allocateEvenly(parseMoney("575.00", "EUR"), 2).map(toDecimalString)).toEqual([
      "287.50",
      "287.50",
    ]);
  });

  it("distributes remainders deterministically and preserves the total", () => {
    const total = money(1001, "EUR");
    const shares = allocateEvenly(total, 3);
    expect(shares.map((share) => share.amountMinor)).toEqual([334, 334, 333]);
    expect(sumMoney(shares, "EUR")).toEqual(total);
    expect(allocateEvenly(total, 3)).toEqual(shares);
  });

  it("handles negative amounts symmetrically", () => {
    const shares = allocateEvenly(money(-1001, "EUR"), 3);
    expect(shares.map((share) => share.amountMinor)).toEqual([-334, -334, -333]);
  });

  it("preserves the total for many part counts", () => {
    for (let parts = 1; parts <= 9; parts += 1) {
      const total = money(99_999, "EUR");
      expect(sumMoney(allocateEvenly(total, parts), "EUR")).toEqual(total);
    }
  });

  it("rejects invalid part counts", () => {
    expect(() => allocateEvenly(money(100, "EUR"), 0)).toThrow(/positive integer/);
    expect(() => allocateEvenly(money(100, "EUR"), 1.5)).toThrow(/positive integer/);
  });
});
