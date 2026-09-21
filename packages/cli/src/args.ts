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
  /** The return date of a round trip; absent for a one-way. */
  readonly to?: LocalDate;
  /** The end of a one-way trip; absent for a round trip. */
  readonly endDate?: LocalDate;
  readonly flexibilityDays: number;
  readonly nights?: { readonly min: number; readonly max: number };
  readonly travelers: number;
  readonly budget?: Budget;
  readonly currency: CurrencyCode;
  readonly alternativeAirports: boolean;
  readonly openJaw: boolean;
  /** Compose itineraries from one-way fares instead of round-trip fares. */
  readonly compose: boolean;
  /** Allow a second city between the outbound and the way home. */
  readonly multiCity: boolean;
  readonly limit: number;
  readonly json: boolean;
}

export type ParseArgumentsResult =
  | { readonly ok: true; readonly options: CliOptions }
  | { readonly ok: false; readonly issues: readonly DomainIssue[] }
  | { readonly ok: false; readonly help: true };

export const HELP_TEXT = `trip-search — explore flights for a trip (flights only; no trains, buses or accommodation)

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
  --compose              Build trips from one-way fares instead of the
                         provider's round-trip fares. Reaches far more
                         destinations, but spends more of the call budget.
  --open-jaw             Allow flying home from a different city (implies
                         --compose). The sector between the two cities is left
                         unpriced: its cost is excluded and the output says so.
  --one-way <date>       A trip that does not come back, ending on this date
                         (YYYY-MM-DD). Use instead of --to. The date is the
                         checkout boundary and is never widened by --flex.
  --multi-city           Allow a second city on the way (implies --compose).
                         Each destination asked where it can go on to next
                         costs provider calls from the same budget as the ways
                         home, so fewer destinations are checked for one.
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
  options: { readonly required?: boolean } = {},
): LocalDate | undefined {
  if (value === undefined) {
    if (options.required !== false) {
      issues.push(issue("MISSING_ARGUMENT", `--${name} is required (YYYY-MM-DD)`));
    }
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
        "open-jaw": { type: "boolean", default: false },
        compose: { type: "boolean", default: false },
        "multi-city": { type: "boolean", default: false },
        "one-way": { type: "string" },
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
  const oneWayEnd = parseDate(values["one-way"], "one-way", issues, { required: false });
  // A trip comes back or it does not. Asking for both leaves two answers to
  // when it ends, so it is refused rather than one silently winning.
  if (values.to !== undefined && values["one-way"] !== undefined) {
    issues.push(
      issue("INVALID_ARGUMENT", "--to and --one-way cannot both be given: a trip returns or it ends"),
    );
  }
  const to = parseDate(values.to, "to", issues, { required: oneWayEnd === undefined });
  const nights = parseNights(values.nights, issues);
  const flexibilityDays = parseInteger(values.flex, "flex", 0, issues, { min: 0 });
  const travelers = parseInteger(values.people, "people", 1, issues);
  const limit = parseInteger(values.limit, "limit", 10, issues);
  const budget = parseBudget(values.budget, values["budget-basis"], resolvedCurrency, issues);

  if (from !== undefined && to !== undefined && from > to) {
    issues.push(issue("INVALID_ARGUMENT", `--from ${from} is after --to ${to}`));
  }
  if (from !== undefined && oneWayEnd !== undefined && from > oneWayEnd) {
    issues.push(issue("INVALID_ARGUMENT", `--from ${from} is after --one-way ${oneWayEnd}`));
  }

  if (
    issues.length > 0 ||
    origin === undefined ||
    from === undefined ||
    (to === undefined && oneWayEnd === undefined)
  ) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    options: {
      origin: origin.toUpperCase(),
      destination: values.destination?.trim().toUpperCase() ?? null,
      from,
      ...(to !== undefined && { to }),
      ...(oneWayEnd !== undefined && { endDate: oneWayEnd }),
      flexibilityDays,
      ...(nights !== undefined && { nights }),
      travelers,
      ...(budget !== undefined && { budget }),
      currency: resolvedCurrency,
      alternativeAirports: values["alternative-airports"],
      openJaw: values["open-jaw"],
      // Neither an open jaw nor a second city can be built from round-trip
      // fares, so both imply composition from one-way fares.
      compose: values.compose || values["open-jaw"] || values["multi-city"],
      multiCity: values["multi-city"],
      limit,
      json: values.json,
    },
  };
}
