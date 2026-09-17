import { z } from "zod";

import { DomainError } from "../errors.js";
import { currencyCodeSchema, minorUnitDigits, type CurrencyCode } from "./currency.js";

/**
 * An exact amount of money in integer minor units (EUR 123.45 → 12345).
 *
 * Never construct Money from a floating-point major amount.
 */
export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: CurrencyCode, actual: CurrencyCode) {
    super(
      "CURRENCY_MISMATCH",
      `Cannot combine ${expected} with ${actual} without explicit conversion`,
    );
  }
}

export const moneySchema = z.object({
  amountMinor: z.number().refine(Number.isSafeInteger, {
    message: "amountMinor must be a safe integer",
  }),
  currency: currencyCodeSchema,
});

function checkedAmount(amountMinor: number): number {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new DomainError(
      "INVALID_MONEY_AMOUNT",
      `Money amount must be a safe integer of minor units, got ${String(amountMinor)}`,
    );
  }
  return amountMinor;
}

export function money(amountMinor: number, currency: CurrencyCode): Money {
  return { amountMinor: checkedAmount(amountMinor), currency };
}

export function zeroMoney(currency: CurrencyCode): Money {
  return money(0, currency);
}

const DECIMAL_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;

/**
 * Parses a decimal string ("123.45") into Money without floating point.
 *
 * Rejects more fractional digits than the currency's minor unit allows rather
 * than rounding: silently rounding a provider price would alter it.
 */
export function parseMoney(decimal: string, currency: CurrencyCode): Money {
  const match = DECIMAL_PATTERN.exec(decimal);
  if (match === null) {
    throw new DomainError(
      "INVALID_MONEY_DECIMAL",
      `Not a decimal amount: ${JSON.stringify(decimal)}`,
    );
  }
  const [, sign, whole = "", fraction = ""] = match;
  const digits = minorUnitDigits(currency);
  if (fraction.length > digits) {
    throw new DomainError(
      "MONEY_PRECISION_EXCEEDED",
      `${currency} allows ${digits} fractional digits, got ${JSON.stringify(decimal)}`,
    );
  }
  const minor = BigInt(whole + fraction.padEnd(digits, "0"));
  const signed = sign === "-" ? -minor : minor;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new DomainError("MONEY_OVERFLOW", `Amount out of range: ${decimal}`);
  }
  return money(Number(signed), currency);
}

/** Formats Money as a plain decimal string ("123.45"), without currency. */
export function toDecimalString(value: Money): string {
  const digits = minorUnitDigits(value.currency);
  const negative = value.amountMinor < 0;
  const absolute = Math.abs(value.amountMinor).toString();
  if (digits === 0) {
    return (negative ? "-" : "") + absolute;
  }
  const padded = absolute.padStart(digits + 1, "0");
  const whole = padded.slice(0, -digits);
  const fraction = padded.slice(-digits);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

/** Multiplies by an integer factor (e.g. a per-traveler price × travelers). */
export function multiplyMoney(value: Money, factor: number): Money {
  if (!Number.isSafeInteger(factor)) {
    throw new DomainError(
      "INVALID_MONEY_FACTOR",
      `Money can only be multiplied by an integer, got ${String(factor)}`,
    );
  }
  return money(value.amountMinor * factor, value.currency);
}

/** Sums amounts that must all be in `currency`. An empty list sums to zero. */
export function sumMoney(values: readonly Money[], currency: CurrencyCode): Money {
  let total = zeroMoney(currency);
  for (const value of values) {
    total = addMoney(total, value);
  }
  return total;
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor === b.amountMinor) return 0;
  return a.amountMinor < b.amountMinor ? -1 : 1;
}

export function moneyEquals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

/**
 * Splits an amount into `parts` shares that differ by at most one minor unit
 * and always sum exactly to the original amount.
 *
 * Deterministic: the leftover minor units go to the earliest shares
 * (EUR 10.01 / 3 → 3.34, 3.34, 3.33).
 */
export function allocateEvenly(value: Money, parts: number): Money[] {
  if (!Number.isSafeInteger(parts) || parts < 1) {
    throw new DomainError(
      "INVALID_ALLOCATION",
      `Allocation requires a positive integer number of parts, got ${String(parts)}`,
    );
  }
  const sign = value.amountMinor < 0 ? -1 : 1;
  const absolute = Math.abs(value.amountMinor);
  const base = Math.floor(absolute / parts);
  const remainder = absolute - base * parts;
  return Array.from({ length: parts }, (_, index) =>
    money(sign * (base + (index < remainder ? 1 : 0)), value.currency),
  );
}
