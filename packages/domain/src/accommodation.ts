import { z } from "zod";

import { locationSchema, type Location } from "./location.js";
import { moneySchema, type Money } from "./money/money.js";
import { priceProvenanceSchema } from "./provenance.js";
import { daysBetween, localDateSchema } from "./time/local-date.js";

/**
 * A priced accommodation stay in a destination city.
 *
 * `price` is the total for the whole stay for `guests` in `rooms`, as quoted by
 * the provider. Nights are local calendar nights from check-in to check-out.
 */
export const staySchema = z
  .object({
    id: z.string().min(1),
    propertyId: z.string().min(1),
    propertyName: z.string().min(1).optional(),
    city: locationSchema,
    checkIn: localDateSchema,
    checkOut: localDateSchema,
    nights: z.number().int().positive(),
    guests: z.number().int().positive(),
    rooms: z.number().int().positive(),
    price: moneySchema,
    roomDescription: z.string().min(1).optional(),
    cancellationPolicy: z.string().min(1).optional(),
    provenance: priceProvenanceSchema,
    bookingUrl: z.url({ protocol: /^https?$/ }).optional(),
  })
  .superRefine((stay, context) => {
    if (stay.city.type !== "city") {
      context.addIssue({
        code: "custom",
        message: `A stay must be attached to a city, not a ${stay.city.type}`,
        path: ["city", "type"],
      });
    }
    // Object refinements still run after field issues; never throw on bad input.
    if (
      !localDateSchema.safeParse(stay.checkIn).success ||
      !localDateSchema.safeParse(stay.checkOut).success
    ) {
      return;
    }
    const nights = daysBetween(stay.checkIn, stay.checkOut);
    if (nights < 1) {
      context.addIssue({
        code: "custom",
        message: "checkOut must be at least one night after checkIn",
        path: ["checkOut"],
      });
    } else if (nights !== stay.nights) {
      context.addIssue({
        code: "custom",
        message: `nights ${stay.nights} does not match ${stay.checkIn}..${stay.checkOut} (${nights})`,
        path: ["nights"],
      });
    }
  });

export type Stay = z.infer<typeof staySchema>;
export type StayInput = z.input<typeof staySchema>;

/*
 * Accommodation coverage (ADR 0016).
 *
 * A trip has one accommodation stay per period on the ground, and each one says
 * what actually happened rather than only what it cost. Only a priced stay
 * carries an amount: unknown is not zero and is not an estimate.
 */

export const ACCOMMODATION_COVERAGE_STATES = [
  "priced",
  "not_searched",
  "unpriced",
  "unresolved",
] as const;

export type AccommodationCoverageState = (typeof ACCOMMODATION_COVERAGE_STATES)[number];

/** Why no query ran. Neither implies the other was deliberate. */
const notSearchedReasonSchema = z.enum(["outside_shortlist", "no_provider", "other"]);

/**
 * Why a query produced no price.
 *
 * A provider that answered with no availability and a provider we could not
 * reach are different facts about the world. Both leave us without a price, so
 * both are `unpriced`, but collapsing them would let an outage read as an
 * answer.
 */
const unpricedReasonSchema = z.enum([
  "provider_no_results",
  "provider_unavailable",
  "other",
]);

export type AccommodationCoverageReason =
  | z.infer<typeof notSearchedReasonSchema>
  | z.infer<typeof unpricedReasonSchema>
  | "unresolved_open_jaw_split";

const interval = {
  checkIn: localDateSchema,
  checkOut: localDateSchema,
  nights: z.number().int().positive(),
};

/**
 * Accommodation for one period on the ground.
 *
 * A discriminated union rather than one object with an optional price, so two
 * invariants are structural instead of conventional: an `unresolved` stay
 * cannot name a single city, and a `priced` stay cannot exist without a priced
 * `Stay` to carry its amount and provenance.
 */
export const accommodationStaySchema = z
  .discriminatedUnion("state", [
    z.object({
      state: z.literal("priced"),
      city: locationSchema,
      ...interval,
      /** Holds the price and provenance; there is no priced stay without it. */
      stay: staySchema,
    }),
    z.object({
      state: z.literal("not_searched"),
      reason: notSearchedReasonSchema,
      city: locationSchema,
      ...interval,
    }),
    z.object({
      state: z.literal("unpriced"),
      reason: unpricedReasonSchema,
      city: locationSchema,
      ...interval,
    }),
    z.object({
      state: z.literal("unresolved"),
      reason: z.literal("unresolved_open_jaw_split"),
      /**
       * Every city the stay spans. At least two, because the split between
       * them is precisely what cannot be determined (ADR 0016 §3).
       */
      cities: z.array(locationSchema).min(2),
      ...interval,
    }),
  ])
  .superRefine((entry, context) => {
    const places = entry.state === "unresolved" ? entry.cities : [entry.city];
    for (const [index, place] of places.entries()) {
      if (place.type !== "city") {
        context.addIssue({
          code: "custom",
          message: `Accommodation attaches to a city, not a ${place.type}`,
          path: entry.state === "unresolved" ? ["cities", index, "type"] : ["city", "type"],
        });
      }
    }
    // Object refinements still run after field issues; never throw on bad input.
    if (
      !localDateSchema.safeParse(entry.checkIn).success ||
      !localDateSchema.safeParse(entry.checkOut).success
    ) {
      return;
    }
    const nights = daysBetween(entry.checkIn, entry.checkOut);
    if (nights !== entry.nights) {
      context.addIssue({
        code: "custom",
        message: `nights ${String(entry.nights)} does not match ${entry.checkIn}..${entry.checkOut} (${String(nights)})`,
        path: ["nights"],
      });
    }
  });

export type AccommodationStay = z.infer<typeof accommodationStaySchema>;
export type AccommodationStayInput = z.input<typeof accommodationStaySchema>;

export interface AccommodationCoverage {
  readonly state: AccommodationCoverageState;
  /** Explains the state; never replaces it. Absent only when priced. */
  readonly reason?: AccommodationCoverageReason;
}

/** The state and reason of a stay, grouped for callers that want them together. */
export function coverageOf(entry: AccommodationStay): AccommodationCoverage {
  return entry.state === "priced"
    ? { state: "priced" }
    : { state: entry.state, reason: entry.reason };
}

/** The cities a stay covers: one, or every city an unresolved stay spans. */
export function citiesOf(entry: AccommodationStay): readonly Location[] {
  return entry.state === "unresolved" ? entry.cities : [entry.city];
}

/** Only a priced stay has an amount. Everything else contributes nothing. */
export function stayPrice(entry: AccommodationStay): Money | undefined {
  return entry.state === "priced" ? entry.stay.price : undefined;
}
