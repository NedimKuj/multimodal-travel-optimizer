import { z } from "zod";

import type { DomainIssue } from "./errors.js";
import { moneySchema, multiplyMoney, type Money } from "./money/money.js";
import { compareLocalDates, localDateSchema, type LocalDate } from "./time/local-date.js";
import {
  SELECTABLE_TRANSPORT_MODES,
  selectableTransportModeSchema,
  type SelectableTransportMode,
} from "./transport.js";

// See docs/optimizer-spec.md §7–§8, §18 and
// docs/decisions/0004-trip-candidate-and-budget-shape.md.

export const budgetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("total"), amount: moneySchema }),
  z.object({ kind: z.literal("perPerson"), amount: moneySchema }),
]);

export type Budget = z.infer<typeof budgetSchema>;

/** Raw search input as received from a CLI, API or test. */
export const searchRequestInputSchema = z.object({
  /** A location reference (IATA code or location id); resolved by geography later. */
  origin: z.string().trim().min(1),
  /** `null` or absent means "anywhere". */
  destination: z.string().trim().min(1).nullable().optional(),
  departureDate: localDateSchema.optional(),
  returnDate: localDateSchema.optional(),
  flexibilityDays: z.number().int().nonnegative().optional(),
  minNights: z.number().int().positive().optional(),
  maxNights: z.number().int().positive().optional(),
  travelers: z.number().int().positive(),
  budget: budgetSchema.optional(),
  transportModes: z.array(selectableTransportModeSchema).min(1),
  allowOpenJaw: z.boolean(),
  allowMultiCity: z.boolean(),
  alternativeAirports: z.boolean().optional(),
});

export type SearchRequestInput = z.input<typeof searchRequestInputSchema>;

/**
 * A validated, canonical search request.
 *
 * Normalization applies only these explicit defaults, none of which widen the
 * user's constraints:
 * - absent `destination` → `null` (anywhere)
 * - absent `flexibilityDays` → `0` (exact dates)
 * - absent `alternativeAirports` → `false` (not permitted)
 * - `transportModes` → de-duplicated, in canonical order
 */
export interface SearchRequest {
  readonly origin: string;
  readonly destination: string | null;
  readonly departureDate?: LocalDate;
  readonly returnDate?: LocalDate;
  readonly flexibilityDays: number;
  readonly minNights?: number;
  readonly maxNights?: number;
  readonly travelers: number;
  readonly budget?: Budget;
  readonly transportModes: readonly SelectableTransportMode[];
  readonly allowOpenJaw: boolean;
  readonly allowMultiCity: boolean;
  readonly alternativeAirports: boolean;
}

export type NormalizeSearchRequestResult =
  | { readonly ok: true; readonly request: SearchRequest }
  | { readonly ok: false; readonly issues: readonly DomainIssue[] };

export function normalizeSearchRequest(input: unknown): NormalizeSearchRequestResult {
  const parsed = searchRequestInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "INVALID_SEARCH_REQUEST",
        message: `${issue.path.map(String).join(".") || "request"}: ${issue.message}`,
      })),
    };
  }
  const raw = parsed.data;
  const issues: DomainIssue[] = [];

  if (
    raw.departureDate !== undefined &&
    raw.returnDate !== undefined &&
    compareLocalDates(raw.departureDate, raw.returnDate) > 0
  ) {
    issues.push({
      code: "DEPARTURE_AFTER_RETURN",
      message: `departureDate ${raw.departureDate} is after returnDate ${raw.returnDate}`,
    });
  }
  if (
    raw.flexibilityDays !== undefined &&
    raw.flexibilityDays > 0 &&
    raw.departureDate === undefined &&
    raw.returnDate === undefined
  ) {
    issues.push({
      code: "FLEXIBILITY_WITHOUT_DATES",
      message: "flexibilityDays requires departureDate or returnDate",
    });
  }
  if (raw.minNights !== undefined && raw.maxNights !== undefined && raw.minNights > raw.maxNights) {
    issues.push({
      code: "MIN_NIGHTS_EXCEEDS_MAX",
      message: `minNights ${raw.minNights} exceeds maxNights ${raw.maxNights}`,
    });
  }
  if (raw.budget !== undefined && raw.budget.amount.amountMinor <= 0) {
    issues.push({ code: "NON_POSITIVE_BUDGET", message: "budget amount must be positive" });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const modes = new Set(raw.transportModes);
  return {
    ok: true,
    request: {
      origin: raw.origin,
      destination: raw.destination ?? null,
      ...(raw.departureDate !== undefined && { departureDate: raw.departureDate }),
      ...(raw.returnDate !== undefined && { returnDate: raw.returnDate }),
      flexibilityDays: raw.flexibilityDays ?? 0,
      ...(raw.minNights !== undefined && { minNights: raw.minNights }),
      ...(raw.maxNights !== undefined && { maxNights: raw.maxNights }),
      travelers: raw.travelers,
      ...(raw.budget !== undefined && { budget: raw.budget }),
      transportModes: SELECTABLE_TRANSPORT_MODES.filter((mode) => modes.has(mode)),
      allowOpenJaw: raw.allowOpenJaw,
      allowMultiCity: raw.allowMultiCity,
      alternativeAirports: raw.alternativeAirports ?? false,
    },
  };
}

/**
 * The maximum total trip cost for all travelers.
 * A per-person budget is multiplied explicitly; a total budget is unchanged.
 */
export function budgetTotal(budget: Budget, travelers: number): Money {
  switch (budget.kind) {
    case "total":
      return budget.amount;
    case "perPerson":
      return multiplyMoney(budget.amount, travelers);
  }
}
