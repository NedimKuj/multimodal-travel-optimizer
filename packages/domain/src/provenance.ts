import { z } from "zod";

import { compareInstants, utcInstantSchema, type UtcInstant } from "./time/zoned-timestamp.js";

/**
 * How trustworthy a price is, ordered from weakest to strongest.
 *
 * - estimated: computed or approximated by us, never an exact bookable price
 * - cached:    a provider's cached/observed fare, not guaranteed bookable
 * - recent:    fetched from a live source, but not verified for this search
 * - live:      verified against a live source for this search
 *
 * The spec does not yet define an age threshold separating `recent` from
 * `live`; that must be decided before live verification is implemented.
 *
 * The adapter that produced a price decides its source type from the
 * provider's documented semantics. It must never upgrade a price.
 */
export const SOURCE_TYPES = ["estimated", "cached", "recent", "live"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const sourceTypeSchema = z.enum(SOURCE_TYPES);

/** Where a price came from and how fresh it is. */
export const priceProvenanceSchema = z
  .object({
    provider: z.string().min(1),
    providerReference: z.string().min(1).optional(),
    sourceType: sourceTypeSchema,
    fetchedAt: utcInstantSchema,
    expiresAt: utcInstantSchema.optional(),
  })
  .refine(
    (value) =>
      value.expiresAt === undefined || compareInstants(value.expiresAt, value.fetchedAt) >= 0,
    { message: "expiresAt must not be before fetchedAt", path: ["expiresAt"] },
  );

export type PriceProvenance = z.infer<typeof priceProvenanceSchema>;
export type PriceProvenanceInput = z.input<typeof priceProvenanceSchema>;

/**
 * The weakest source type among several prices (a trip is only as verified as
 * its least verified price). Returns `undefined` for an empty list, since
 * "no prices" has no confidence at all.
 */
export function weakestSourceType(types: readonly SourceType[]): SourceType | undefined {
  let weakest: SourceType | undefined;
  for (const type of types) {
    if (weakest === undefined || SOURCE_TYPES.indexOf(type) < SOURCE_TYPES.indexOf(weakest)) {
      weakest = type;
    }
  }
  return weakest;
}

export type Freshness = "fresh" | "expired" | "unknown";

/**
 * Whether a price is still within its provider-declared validity at `now`.
 * Without an `expiresAt`, freshness is unknown, not assumed fresh.
 */
export function priceFreshness(provenance: PriceProvenance, now: UtcInstant): Freshness {
  if (provenance.expiresAt === undefined) return "unknown";
  return compareInstants(now, provenance.expiresAt) < 0 ? "fresh" : "expired";
}
