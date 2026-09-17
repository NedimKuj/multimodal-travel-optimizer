import { z } from "zod";

import { locationSchema } from "./location.js";
import { moneySchema } from "./money/money.js";
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
