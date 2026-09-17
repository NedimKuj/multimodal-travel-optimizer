import { z } from "zod";

import { DomainError, type DomainIssue } from "./errors.js";
import { locationSchema } from "./location.js";
import { moneySchema, multiplyMoney, type Money } from "./money/money.js";
import { priceProvenanceSchema } from "./provenance.js";
import {
  compareZonedTimestamps,
  minutesBetween,
  zonedTimestampSchema,
} from "./time/zoned-timestamp.js";

// See docs/decisions/0002-separate-transport-offers-from-segments.md.

export const TRANSPORT_MODES = ["flight", "train", "bus"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];
export const transportModeSchema = z.enum(TRANSPORT_MODES);

/**
 * A physical movement from one location to another. Carries no price.
 *
 * `transfers` counts intermediate changes inside this segment as reported by
 * the source (for example a flight with one stop that the provider does not
 * break down further).
 *
 * `provider`/`providerReference` identify the source that described the
 * movement (schedule or fare search), not a price.
 */
export const transportSegmentSchema = z
  .object({
    id: z.string().min(1),
    mode: transportModeSchema,
    origin: locationSchema,
    destination: locationSchema,
    departureAt: zonedTimestampSchema,
    arrivalAt: zonedTimestampSchema,
    durationMinutes: z.number().int().nonnegative(),
    transfers: z.number().int().nonnegative(),
    carrier: z.string().min(1).optional(),
    serviceNumber: z.string().min(1).optional(),
    provider: z.string().min(1),
    providerReference: z.string().min(1).optional(),
  })
  .superRefine((segment, context) => {
    if (segment.origin.id === segment.destination.id) {
      context.addIssue({
        code: "custom",
        message: "Origin and destination must differ",
        path: ["destination"],
      });
    }
    if (compareZonedTimestamps(segment.arrivalAt, segment.departureAt) <= 0) {
      context.addIssue({
        code: "custom",
        message: "Arrival must be after departure",
        path: ["arrivalAt"],
      });
    }
    if (segment.departureAt.timeZone !== segment.origin.timeZone) {
      context.addIssue({
        code: "custom",
        message: `Departure zone ${segment.departureAt.timeZone} differs from origin zone ${segment.origin.timeZone}`,
        path: ["departureAt", "timeZone"],
      });
    }
    if (segment.arrivalAt.timeZone !== segment.destination.timeZone) {
      context.addIssue({
        code: "custom",
        message: `Arrival zone ${segment.arrivalAt.timeZone} differs from destination zone ${segment.destination.timeZone}`,
        path: ["arrivalAt", "timeZone"],
      });
    }
    // A reported duration that disagrees with the timestamps indicates a
    // time zone or data error; reject rather than pick one.
    const elapsed = minutesBetween(segment.departureAt, segment.arrivalAt);
    if (Math.abs(elapsed - segment.durationMinutes) >= 1) {
      context.addIssue({
        code: "custom",
        message: `durationMinutes ${segment.durationMinutes} does not match elapsed time ${elapsed}`,
        path: ["durationMinutes"],
      });
    }
  });

export type TransportSegment = z.infer<typeof transportSegmentSchema>;
export type TransportSegmentInput = z.input<typeof transportSegmentSchema>;

/**
 * What a price covers in terms of travelers. Providers differ: some quote per
 * passenger, others the total for the searched party.
 */
export const priceBasisSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("perTraveler") }),
  z.object({ kind: z.literal("total"), travelers: z.number().int().positive() }),
]);

export type PriceBasis = z.infer<typeof priceBasisSchema>;

/**
 * A commercial fare covering one or more segments with exactly one price.
 * A multi-segment fare is never split into per-segment prices.
 */
export const transportOfferSchema = z.object({
  id: z.string().min(1),
  segmentIds: z
    .array(z.string().min(1))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "segmentIds must not contain duplicates",
    }),
  price: moneySchema,
  priceBasis: priceBasisSchema,
  provenance: priceProvenanceSchema,
  bookingUrl: z.url({ protocol: /^https?$/ }).optional(),
});

export type TransportOffer = z.infer<typeof transportOfferSchema>;
export type TransportOfferInput = z.input<typeof transportOfferSchema>;

/**
 * Checks an offer against the segments it references: every referenced
 * segment must exist, and the segments must be in chronological order without
 * overlapping.
 */
export function validateOfferSegments(
  offer: TransportOffer,
  segments: readonly TransportSegment[],
): DomainIssue[] {
  const issues: DomainIssue[] = [];
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  let previous: TransportSegment | undefined;
  for (const segmentId of offer.segmentIds) {
    const segment = byId.get(segmentId);
    if (segment === undefined) {
      issues.push({
        code: "OFFER_UNKNOWN_SEGMENT",
        message: `Offer ${offer.id} references unknown segment ${segmentId}`,
      });
      continue;
    }
    if (previous !== undefined && compareZonedTimestamps(segment.departureAt, previous.arrivalAt) < 0) {
      issues.push({
        code: "OFFER_SEGMENTS_NOT_CHRONOLOGICAL",
        message: `Offer ${offer.id}: segment ${segment.id} departs before segment ${previous.id} arrives`,
      });
    }
    previous = segment;
  }
  return issues;
}

/**
 * The offer's price for a party of `travelers`.
 *
 * A total price quoted for a different party size cannot be rescaled: fares
 * are not linear, so doing so would fabricate a price.
 */
export function offerPriceForTravelers(offer: TransportOffer, travelers: number): Money {
  if (!Number.isSafeInteger(travelers) || travelers < 1) {
    throw new DomainError("INVALID_TRAVELER_COUNT", `Invalid traveler count ${String(travelers)}`);
  }
  switch (offer.priceBasis.kind) {
    case "perTraveler":
      return multiplyMoney(offer.price, travelers);
    case "total":
      if (offer.priceBasis.travelers !== travelers) {
        throw new DomainError(
          "PRICE_BASIS_MISMATCH",
          `Offer ${offer.id} is priced for ${offer.priceBasis.travelers} travelers, not ${travelers}`,
        );
      }
      return offer.price;
  }
}
