import type { ProviderFailure } from "@travel-optimizer/domain";
import { z } from "zod";

/*
 * Aviasales Flights Data API response schemas.
 *
 * Derived from responses observed on 2026-09-18, recorded in
 * docs/phase-0-aviasales-findings.md. Unknown fields are ignored so a new
 * provider field does not break parsing, but every field we rely on must be
 * present and of the right type: a response we do not recognise is an
 * `invalid_response` failure, never a partially-guessed record.
 */

/** A price record from `aviasales/v3/prices_for_dates` or `grouped_prices`. */
export const aviasalesPriceRecordSchema = z.object({
  /** City codes (e.g. ROM); not used for segments. */
  origin: z.string().min(1),
  destination: z.string().min(1),
  /** Airport codes (e.g. FCO); these build the segments. */
  origin_airport: z.string().min(1),
  destination_airport: z.string().min(1),
  /** Local time with UTC offset at the origin airport. */
  departure_at: z.string().min(1),
  /** Present only for round-trip queries; local at the destination. */
  return_at: z.string().min(1).optional(),
  airline: z.string().min(1),
  /** v3 returns a string, v1 a number. */
  flight_number: z.union([z.string(), z.number()]).optional(),
  price: z.number(),
  /** Booking agency that quoted the fare (Kiwi.com, Clickavia, …). */
  gate: z.string().min(1).optional(),
  /** Minutes. `duration` is the total across both directions. */
  duration: z.number().optional(),
  duration_to: z.number().optional(),
  duration_back: z.number().optional(),
  transfers: z.number().int().nonnegative().optional(),
  return_transfers: z.number().int().nonnegative().optional(),
  /** Relative Aviasales search path. */
  link: z.string().min(1).optional(),
  /** Only the v1 endpoints supply this. */
  expires_at: z.string().min(1).optional(),
});

export type AviasalesPriceRecord = z.infer<typeof aviasalesPriceRecordSchema>;

export const aviasalesPricesForDatesResponseSchema = z.object({
  success: z.boolean(),
  currency: z.string().min(1).optional(),
  data: z.array(aviasalesPriceRecordSchema),
  error: z.string().nullable().optional(),
});

export type AviasalesPricesForDatesResponse = z.infer<
  typeof aviasalesPricesForDatesResponseSchema
>;

/** `grouped_prices` returns an object keyed by date instead of an array. */
export const aviasalesGroupedPricesResponseSchema = z.object({
  success: z.boolean(),
  currency: z.string().min(1).optional(),
  data: z.record(z.string(), aviasalesPriceRecordSchema),
  error: z.string().nullable().optional(),
});

export type ParsedResponse<T> =
  | { readonly ok: true; readonly response: T }
  | { readonly ok: false; readonly failure: ProviderFailure };

function invalidResponse(message: string): ProviderFailure {
  return { kind: "invalid_response", message, retryable: false };
}

/**
 * Parses a response body against a schema.
 *
 * `success: false` is a provider-reported error, not a parse problem, and is
 * reported as such.
 */
interface ProviderEnvelope {
  readonly success: boolean;
  readonly error?: string | null | undefined;
}

export function parseResponse<S extends z.ZodType<ProviderEnvelope>>(
  body: string,
  schema: S,
): ParsedResponse<z.infer<S>> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, failure: invalidResponse(`Response was not JSON: ${body.slice(0, 120)}`) };
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      failure: invalidResponse(
        `Unexpected response shape: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.map(String).join(".")} ${issue.message}`)
          .join("; ")}`,
      ),
    };
  }
  if (!parsed.data.success) {
    return {
      ok: false,
      failure: {
        kind: "unsupported_query",
        message: `Provider reported failure: ${parsed.data.error ?? "no reason given"}`,
        retryable: false,
      },
    };
  }
  return { ok: true, response: parsed.data };
}
