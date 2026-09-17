import { z } from "zod";

import { timeZoneIdSchema } from "./time/zoned-timestamp.js";

export const LOCATION_TYPES = ["city", "airport", "station"] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

/**
 * A normalized place: city, airport or station.
 *
 * `id` is our own stable identifier, never a provider's. `timeZone` is required
 * so local dates can be derived (docs/decisions/0003-zoned-timestamps.md).
 * Relationships (airport ↔ city, nearby airports) belong to the geography
 * model, not to this type.
 */
export const locationSchema = z.object({
  id: z.string().min(1),
  type: z.enum(LOCATION_TYPES),
  name: z.string().trim().min(1),
  countryCode: z.string().regex(/^[A-Z]{2}$/, {
    message: "Expected an ISO 3166-1 alpha-2 country code",
  }),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timeZone: timeZoneIdSchema,
  iata: z
    .string()
    .regex(/^[A-Z]{3}$/, { message: "Expected a three-letter IATA code" })
    .optional(),
});

export type Location = z.infer<typeof locationSchema>;
export type LocationInput = z.input<typeof locationSchema>;
