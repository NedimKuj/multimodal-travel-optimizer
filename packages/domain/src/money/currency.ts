import { z } from "zod";

import { DomainError } from "../errors.js";

/**
 * Currencies the domain knows how to represent.
 *
 * The minor-unit exponent comes from ISO 4217 and is listed explicitly rather
 * than read from `Intl`, so money parsing does not depend on the ICU build.
 * Unknown currencies are rejected, never guessed: add a currency here (with its
 * ISO 4217 exponent and a test) before a provider may use it.
 */
export const CURRENCY_CODES = [
  "ALL",
  "BAM",
  "CHF",
  "CZK",
  "DKK",
  "EUR",
  "GBP",
  "HUF",
  "ISK",
  "JPY",
  "KWD",
  "MKD",
  "NOK",
  "PLN",
  "RON",
  "RSD",
  "SEK",
  "TRY",
  "USD",
] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];

const MINOR_UNIT_DIGITS: Readonly<Record<CurrencyCode, number>> = {
  ALL: 2,
  BAM: 2,
  CHF: 2,
  CZK: 2,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  HUF: 2,
  ISK: 0,
  JPY: 0,
  KWD: 3,
  MKD: 2,
  NOK: 2,
  PLN: 2,
  RON: 2,
  RSD: 2,
  SEK: 2,
  TRY: 2,
  USD: 2,
};

export const currencyCodeSchema = z.enum(CURRENCY_CODES);

export function isCurrencyCode(value: string): value is CurrencyCode {
  return currencyCodeSchema.safeParse(value).success;
}

export function parseCurrencyCode(value: string): CurrencyCode {
  const result = currencyCodeSchema.safeParse(value);
  if (!result.success) {
    throw new DomainError(
      "UNSUPPORTED_CURRENCY",
      `Unsupported currency code: ${JSON.stringify(value)}`,
    );
  }
  return result.data;
}

/** Number of decimal digits in one major unit (EUR → 2, JPY → 0, KWD → 3). */
export function minorUnitDigits(currency: CurrencyCode): number {
  return MINOR_UNIT_DIGITS[currency];
}
