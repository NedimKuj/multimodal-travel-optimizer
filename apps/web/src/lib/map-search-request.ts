import { z } from "zod";

import {
  isCurrencyCode,
  parseMoney,
  SELECTABLE_TRANSPORT_MODES,
  toDecimalString,
  type Budget,
  type CurrencyCode,
  type DomainIssue,
  type SearchRequestInput,
  type SelectableTransportMode,
} from "@travel-optimizer/domain";

/**
 * Trip Explorer form state — UI-facing, mapped into SearchRequestInput.
 *
 * `destinationAnywhere` is explicit so "Anywhere" is never a fake IATA code.
 * `tripShape` chooses returnDate vs endDate rather than inventing a return leg.
 */
export type TripShape = "round_trip" | "one_way";

export interface SearchFormState {
  readonly origin: string;
  readonly destinationAnywhere: boolean;
  readonly destination: string;
  readonly tripShape: TripShape;
  readonly departureDate: string;
  readonly returnDate: string;
  readonly endDate: string;
  readonly flexibilityDays: number;
  readonly minNights: string;
  readonly maxNights: string;
  readonly travelers: number;
  readonly budgetAmount: string;
  readonly budgetKind: "perPerson" | "total";
  readonly currency: string;
  readonly transportModes: readonly SelectableTransportMode[];
  readonly allowOpenJaw: boolean;
  readonly allowMultiCity: boolean;
  readonly alternativeAirports: boolean;
  /**
   * Build from one-way fares. Forced on when open-jaw, multi-city or one-way
   * requires composition; optional otherwise (CLI `--compose`).
   */
  readonly compose: boolean;
}

export const DEFAULT_SEARCH_FORM: SearchFormState = {
  origin: "SJJ",
  destinationAnywhere: true,
  destination: "",
  tripShape: "round_trip",
  departureDate: "2026-12-26",
  returnDate: "2027-01-03",
  endDate: "2027-01-03",
  flexibilityDays: 2,
  minNights: "5",
  maxNights: "7",
  travelers: 2,
  budgetAmount: "700",
  budgetKind: "perPerson",
  currency: "EUR",
  transportModes: ["flight"],
  allowOpenJaw: false,
  allowMultiCity: false,
  alternativeAirports: false,
  compose: false,
};

export interface MappedSearchRequest {
  readonly input: SearchRequestInput;
  readonly currency: CurrencyCode;
  readonly compose: boolean;
}

export type MapSearchFormResult =
  | { readonly ok: true; readonly mapped: MappedSearchRequest }
  | { readonly ok: false; readonly issues: readonly DomainIssue[] };

function issue(code: string, message: string): DomainIssue {
  return { code, message };
}

function parseOptionalNights(
  value: string,
  field: string,
  issues: DomainIssue[],
): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    issues.push(issue("INVALID_NIGHTS", `${field} must be a positive integer`));
    return undefined;
  }
  return parsed;
}

function parseBudget(
  amount: string,
  kind: "perPerson" | "total",
  currency: CurrencyCode,
  issues: DomainIssue[],
): Budget | undefined {
  const trimmed = amount.trim();
  if (trimmed === "") return undefined;
  try {
    const money = parseMoney(trimmed, currency);
    if (money.amountMinor <= 0) {
      issues.push(issue("NON_POSITIVE_BUDGET", "budget must be greater than zero"));
      return undefined;
    }
    return kind === "total"
      ? { kind: "total", amount: money }
      : { kind: "perPerson", amount: money };
  } catch {
    issues.push(issue("INVALID_BUDGET", `budget must be an amount in ${currency}`));
    return undefined;
  }
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Maps Trip Explorer form state to the domain search request input.
 *
 * Does not reinterpret optimizer semantics: budget kind, open-jaw, multi-city,
 * one-way (`endDate`), and Anywhere (`destination: null`) are passed through.
 */
export function mapSearchFormToRequest(form: SearchFormState): MapSearchFormResult {
  const issues: DomainIssue[] = [];

  const origin = form.origin.trim().toUpperCase();
  if (origin === "") {
    issues.push(issue("MISSING_ORIGIN", "origin is required"));
  }

  let destination: string | null = null;
  if (!form.destinationAnywhere) {
    const code = form.destination.trim().toUpperCase();
    if (code === "") {
      issues.push(issue("MISSING_DESTINATION", "destination is required when Anywhere is off"));
    } else if (code === "ANYWHERE") {
      issues.push(
        issue(
          "FAKE_ANYWHERE_CODE",
          'Do not use "Anywhere" as a destination code; enable Anywhere instead',
        ),
      );
    } else {
      destination = code;
    }
  }

  if (!dateSchema.safeParse(form.departureDate).success) {
    issues.push(issue("INVALID_DEPARTURE", "departureDate must be YYYY-MM-DD"));
  }

  if (form.tripShape === "round_trip") {
    if (!dateSchema.safeParse(form.returnDate).success) {
      issues.push(issue("INVALID_RETURN", "returnDate must be YYYY-MM-DD"));
    }
  } else if (!dateSchema.safeParse(form.endDate).success) {
    issues.push(issue("INVALID_END", "endDate must be YYYY-MM-DD"));
  }

  if (!Number.isInteger(form.flexibilityDays) || form.flexibilityDays < 0) {
    issues.push(issue("INVALID_FLEX", "flexibilityDays must be a non-negative integer"));
  }

  if (!Number.isInteger(form.travelers) || form.travelers < 1) {
    issues.push(issue("INVALID_TRAVELERS", "travelers must be a positive integer"));
  }

  const currencyRaw = form.currency.trim().toUpperCase();
  if (!isCurrencyCode(currencyRaw)) {
    issues.push(issue("INVALID_CURRENCY", `unsupported currency ${form.currency}`));
  }

  const modes = SELECTABLE_TRANSPORT_MODES.filter((mode) => form.transportModes.includes(mode));
  if (modes.length === 0) {
    issues.push(issue("MISSING_TRANSPORT", "select at least one transport mode"));
  }

  const minNights = parseOptionalNights(form.minNights, "minNights", issues);
  const maxNights = parseOptionalNights(form.maxNights, "maxNights", issues);
  if (
    minNights !== undefined &&
    maxNights !== undefined &&
    minNights > maxNights
  ) {
    issues.push(issue("MIN_NIGHTS_EXCEEDS_MAX", "minNights exceeds maxNights"));
  }

  const currency = isCurrencyCode(currencyRaw) ? currencyRaw : undefined;
  const budget =
    currency === undefined
      ? undefined
      : parseBudget(form.budgetAmount, form.budgetKind, currency, issues);

  if (issues.length > 0 || currency === undefined || origin === "") {
    return { ok: false, issues };
  }

  // One-way, open-jaw and multi-city require composed one-way fares.
  const composeRequired =
    form.tripShape === "one_way" || form.allowOpenJaw || form.allowMultiCity;

  const input: SearchRequestInput = {
    origin,
    destination,
    departureDate: form.departureDate,
    ...(form.tripShape === "round_trip"
      ? { returnDate: form.returnDate }
      : { endDate: form.endDate }),
    flexibilityDays: form.flexibilityDays,
    ...(minNights !== undefined && { minNights }),
    ...(maxNights !== undefined && { maxNights }),
    travelers: form.travelers,
    ...(budget !== undefined && { budget }),
    transportModes: modes,
    allowOpenJaw: form.allowOpenJaw,
    allowMultiCity: form.allowMultiCity,
    alternativeAirports: form.alternativeAirports,
  };

  return {
    ok: true,
    mapped: {
      input,
      currency,
      compose: composeRequired || form.compose,
    },
  };
}

/** API body schema — mirrors MappedSearchRequest after form mapping. */
export const searchApiBodySchema = z.object({
  origin: z.string().trim().min(1),
  destination: z.string().trim().min(1).nullable(),
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  flexibilityDays: z.number().int().nonnegative(),
  minNights: z.number().int().positive().optional(),
  maxNights: z.number().int().positive().optional(),
  travelers: z.number().int().positive(),
  budget: z
    .object({
      kind: z.enum(["total", "perPerson"]),
      amount: z.string().min(1),
      currency: z.string().min(1),
    })
    .optional(),
  transportModes: z.array(z.enum(SELECTABLE_TRANSPORT_MODES)).min(1),
  allowOpenJaw: z.boolean(),
  allowMultiCity: z.boolean(),
  alternativeAirports: z.boolean(),
  currency: z.string().min(1),
  compose: z.boolean(),
});

export type SearchApiBody = z.infer<typeof searchApiBodySchema>;

export function mappedToApiBody(mapped: MappedSearchRequest): SearchApiBody {
  const { input, currency, compose } = mapped;
  return {
    origin: input.origin,
    destination: input.destination ?? null,
    departureDate: input.departureDate ?? "",
    ...(input.returnDate !== undefined && { returnDate: input.returnDate }),
    ...(input.endDate !== undefined && { endDate: input.endDate }),
    flexibilityDays: input.flexibilityDays ?? 0,
    ...(input.minNights !== undefined && { minNights: input.minNights }),
    ...(input.maxNights !== undefined && { maxNights: input.maxNights }),
    travelers: input.travelers,
    ...(input.budget !== undefined && {
      budget: {
        kind: input.budget.kind,
        amount: toDecimalString(input.budget.amount),
        currency: input.budget.amount.currency,
      },
    }),
    transportModes: [...input.transportModes],
    allowOpenJaw: input.allowOpenJaw,
    allowMultiCity: input.allowMultiCity,
    alternativeAirports: input.alternativeAirports ?? false,
    currency,
    compose,
  };
}

/**
 * Converts an API body into SearchRequestInput + currency + compose flag.
 * Budget amount is a decimal string; currency must match the search currency.
 */
export function apiBodyToSearchInput(body: SearchApiBody): MapSearchFormResult {
  const issues: DomainIssue[] = [];
  if (!isCurrencyCode(body.currency)) {
    issues.push(issue("INVALID_CURRENCY", `unsupported currency ${body.currency}`));
    return { ok: false, issues };
  }
  const currency = body.currency;

  let budget: Budget | undefined;
  if (body.budget !== undefined) {
    if (body.budget.currency !== currency) {
      issues.push(
        issue(
          "BUDGET_CURRENCY_MISMATCH",
          `budget currency ${body.budget.currency} differs from search currency ${currency}`,
        ),
      );
    } else {
      try {
        const money = parseMoney(body.budget.amount, currency);
        if (money.amountMinor <= 0) {
          issues.push(issue("NON_POSITIVE_BUDGET", "budget must be greater than zero"));
        } else {
          budget =
            body.budget.kind === "total"
              ? { kind: "total", amount: money }
              : { kind: "perPerson", amount: money };
        }
      } catch {
        issues.push(issue("INVALID_BUDGET", `budget must be an amount in ${currency}`));
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    mapped: {
      input: {
        origin: body.origin.trim().toUpperCase(),
        destination: body.destination === null ? null : body.destination.trim().toUpperCase(),
        departureDate: body.departureDate,
        ...(body.returnDate !== undefined && { returnDate: body.returnDate }),
        ...(body.endDate !== undefined && { endDate: body.endDate }),
        flexibilityDays: body.flexibilityDays,
        ...(body.minNights !== undefined && { minNights: body.minNights }),
        ...(body.maxNights !== undefined && { maxNights: body.maxNights }),
        travelers: body.travelers,
        ...(budget !== undefined && { budget }),
        transportModes: body.transportModes,
        allowOpenJaw: body.allowOpenJaw,
        allowMultiCity: body.allowMultiCity,
        alternativeAirports: body.alternativeAirports,
      },
      currency,
      compose: body.compose,
    },
  };
}
