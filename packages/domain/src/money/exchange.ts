import { z } from "zod";

import { DomainError } from "../errors.js";
import { priceProvenanceSchema } from "../provenance.js";
import { currencyCodeSchema, minorUnitDigits } from "./currency.js";
import { money, type Money } from "./money.js";

const RATE_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/**
 * A directional exchange rate: 1 unit of `from` = `rate` units of `to`.
 *
 * `rate` is a decimal string so it is never approximated by a float. Rates are
 * external data and carry provenance like any other price.
 */
export const exchangeRateSchema = z
  .object({
    from: currencyCodeSchema,
    to: currencyCodeSchema,
    rate: z
      .string()
      .regex(RATE_PATTERN, { message: "Expected a positive decimal rate string" })
      .refine((value) => /[1-9]/.test(value), { message: "Rate must be greater than zero" }),
    provenance: priceProvenanceSchema,
  })
  .refine((value) => value.from !== value.to, {
    message: "An exchange rate must convert between two different currencies",
  });

export type ExchangeRate = z.infer<typeof exchangeRateSchema>;

export interface Conversion {
  readonly original: Money;
  readonly converted: Money;
  readonly rate: ExchangeRate;
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** Integer division rounding half to even (banker's rounding). */
function divideHalfEven(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  const twiceRemainder = (absolute % denominator) * 2n;
  if (twiceRemainder > denominator || (twiceRemainder === denominator && quotient % 2n === 1n)) {
    quotient += 1n;
  }
  return negative ? -quotient : quotient;
}

/**
 * Converts Money with an explicit rate using exact integer arithmetic and
 * half-even rounding to the target currency's minor unit.
 *
 * Returns the original amount and rate alongside the result so the conversion
 * remains explainable.
 */
export function convertMoney(value: Money, rate: ExchangeRate): Conversion {
  if (value.currency !== rate.from) {
    throw new DomainError(
      "EXCHANGE_RATE_MISMATCH",
      `Cannot convert ${value.currency} with a ${rate.from}→${rate.to} rate`,
    );
  }
  const match = RATE_PATTERN.exec(rate.rate);
  if (match === null) {
    throw new DomainError("INVALID_EXCHANGE_RATE", `Invalid rate ${JSON.stringify(rate.rate)}`);
  }
  const [, whole = "", fraction = ""] = match;
  const rateNumerator = BigInt(whole + fraction);
  const rateDenominator = pow10(fraction.length);

  // amountMinor / 10^fromDigits × rate × 10^toDigits
  const numerator =
    BigInt(value.amountMinor) * rateNumerator * pow10(minorUnitDigits(rate.to));
  const denominator = rateDenominator * pow10(minorUnitDigits(rate.from));
  const result = divideHalfEven(numerator, denominator);

  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new DomainError("MONEY_OVERFLOW", "Converted amount is out of range");
  }
  return { original: value, converted: money(Number(result), rate.to), rate };
}
