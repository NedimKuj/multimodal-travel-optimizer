import { parseArgs } from "node:util";

import {
  isCurrencyCode,
  localDateSchema,
  parseMoney,
  type Budget,
  type CurrencyCode,
  type DomainIssue,
  type LocalDate,
} from "@travel-optimizer/domain";

/*
 * Argument parsing for trip-search.
 *
 * Every default is explicit and printed in --help; nothing here widens what
 * the user asked for. A malformed value is an error, never a fallback.
 */

export interface CliOptions {
  readonly origin: string;
  readonly destination: string | null;
  readonly from: LocalDate;
  readonly to: LocalDate;
  readonly flexibilityDays: number;
  readonly nights?: { readonly min: number; readonly max: number };
  readonly travelers: number;
  readonly budget?: Budget;
  readonly currency: CurrencyCode;
  readonly alternativeAirports: boolean;
  readonly limit: number;
  readonly json: boolean;
}

export type ParseArgumentsResult =
  | { readonly ok: true; readonly options: CliOptions }
  | { readonly ok: false; readonly issues: readonly DomainIssue[] }
  | { readonly ok: false; readonly help: true };

export const HELP_TEXT = `trip-search — explore flights for a trip (Phase 1: flights only)

Usage:
  pnpm trip-search --origin SJJ --from 2026-12-26 --to 2027-01-03 \\
    --nights 5:7 --flex 2 --people 2 --budget 700

Required:
  --origin <IATA>        Origin airport, e.g. SJJ
  --from <YYYY-MM-DD>    Start of the travel window
  --to <YYYY-MM-DD>      End of the travel window

Optional:
  --destination <IATA>   Restrict to one destination (default: anywhere)
  --nights <min:max>     Nights on the ground, e.g. 5:7 or 6 for exactly six.
                         With --nights, --from/--to bound a travel window;
                         without it they are exact dates.
  --flex <days>          Days of tolerance on the dates (default: 0)
  --people <n>           Travelers (default: 1)
  --budget <amount>      Maximum spend, e.g. 700
  --budget-basis <b>     per-person (default) or total
  --currency <code>      Currency to search in (default: EUR)
  --alternative-airports Also search nearby origin airports (off by default;
                         each one costs provider calls, and the itinerary then
                         includes the estimated transfer to reach it)
  --limit <n>            Destinations to print (default: 10)
  --json                 Print the full search trace as JSON
  --help                 Show this message

Prices are cached fares for transport only: no accommodation, transfers or
extras. They are not guaranteed bookable.`;

function issue(code: string, message: string): DomainIssue {
  return { code, message };
}

function parseInteger(
  value: string | undefined,
  name: string,
  fallback: number,
  issues: DomainIssue[],
  { min = 1 }: { min?: number } = {},
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    issues.push(issue("INVALID_ARGUMENT", `--${name} must be an integer >= ${String(min)}`));
    return fallback;
  }
  return parsed;
}

function parseDate(
  value: string | undefined,
  name: string,
  issues: DomainIssue[],
): LocalDate | undefined {
  if (value === undefined) {
    issues.push(issue("MISSING_ARGUMENT", `--${name} is required (YYYY-MM-DD)`));
    return undefined;
  }
  const parsed = localDateSchema.safeParse(value);
  if (!parsed.success) {
    issues.push(issue("INVALID_ARGUMENT", `--${name} must be a date as YYYY-MM-DD, got "${value}"`));
    return undefined;
  }
  return parsed.data;
}

/** `5:7` is a range, `6` is exactly six nights. */
function parseNights(
  value: string | undefined,
  issues: DomainIssue[],
): { min: number; max: number } | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(":");
  const numbers = parts.map((part) => Number(part));
  if (
    parts.length > 2 ||
    numbers.some((entry) => !Number.isInteger(entry) || entry < 0) ||
    numbers.length === 0
  ) {
    issues.push(issue("INVALID_ARGUMENT", `--nights must be "min:max" or a single number, got "${value}"`));
    return undefined;
  }
  const [min = 0, max = numbers[0] ?? 0] = numbers;
  if (max < min) {
    issues.push(issue("INVALID_ARGUMENT", `--nights maximum ${String(max)} is below the minimum ${String(min)}`));
    return undefined;
  }
  return { min, max };
}

function parseBudget(
  amount: string | undefined,
  basis: string | undefined,
  currency: CurrencyCode,
  issues: DomainIssue[],
): Budget | undefined {
  if (amount === undefined) {
    if (basis !== undefined) {
      issues.push(issue("INVALID_ARGUMENT", "--budget-basis requires --budget"));
    }
    return undefined;
  }
  const kind = basis ?? "per-person";
  if (kind !== "per-person" && kind !== "total") {
    issues.push(issue("INVALID_ARGUMENT", `--budget-basis must be per-person or total, got "${kind}"`));
    return undefined;
  }
  try {
    const money = parseMoney(amount, currency);
    if (money.amountMinor <= 0) {
      issues.push(issue("INVALID_ARGUMENT", "--budget must be greater than zero"));
      return undefined;
    }
    return kind === "total"
      ? { kind: "total", amount: money }
      : { kind: "perPerson", amount: money };
  } catch {
    issues.push(
      issue("INVALID_ARGUMENT", `--budget must be an amount in ${currency}, got "${amount}"`),
    );
    return undefined;
  }
}

export function parseArguments(argv: readonly string[]): ParseArgumentsResult {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        origin: { type: "string" },
        destination: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        nights: { type: "string" },
        flex: { type: "string" },
        people: { type: "string" },
        budget: { type: "string" },
        "budget-basis": { type: "string" },
        currency: { type: "string" },
        "alternative-airports": { type: "boolean", default: false },
        limit: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
  } catch (error) {
    return {
      ok: false,
      issues: [issue("INVALID_ARGUMENT", error instanceof Error ? error.message : String(error))],
    };
  }

  const values = parsed.values;
  if (values.help) return { ok: false, help: true };

  const issues: DomainIssue[] = [];

  const currencyRaw = values.currency ?? "EUR";
  const currency = currencyRaw.toUpperCase();
  if (!isCurrencyCode(currency)) {
    issues.push(issue("INVALID_ARGUMENT", `--currency ${currencyRaw} is not a supported currency`));
  }
  const resolvedCurrency: CurrencyCode = isCurrencyCode(currency) ? currency : "EUR";

  const origin = values.origin?.trim();
  if (origin === undefined || origin === "") {
    issues.push(issue("MISSING_ARGUMENT", "--origin is required (an IATA airport code, e.g. SJJ)"));
  }

  const from = parseDate(values.from, "from", issues);
  const to = parseDate(values.to, "to", issues);
  const nights = parseNights(values.nights, issues);
  const flexibilityDays = parseInteger(values.flex, "flex", 0, issues, { min: 0 });
  const travelers = parseInteger(values.people, "people", 1, issues);
  const limit = parseInteger(values.limit, "limit", 10, issues);
  const budget = parseBudget(values.budget, values["budget-basis"], resolvedCurrency, issues);

  if (from !== undefined && to !== undefined && from > to) {
    issues.push(issue("INVALID_ARGUMENT", `--from ${from} is after --to ${to}`));
  }

  if (issues.length > 0 || origin === undefined || from === undefined || to === undefined) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    options: {
      origin: origin.toUpperCase(),
      destination: values.destination?.trim().toUpperCase() ?? null,
      from,
      to,
      flexibilityDays,
      ...(nights !== undefined && { nights }),
      travelers,
      ...(budget !== undefined && { budget }),
      currency: resolvedCurrency,
      alternativeAirports: values["alternative-airports"],
      limit,
      json: values.json,
    },
  };
}
