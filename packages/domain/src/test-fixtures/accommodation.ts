import { staySchema, type Stay } from "../accommodation.js";
import type { Location } from "../location.js";
import type { SourceType } from "../provenance.js";
import { daysBetween, parseLocalDate } from "../time/local-date.js";
import { FIXTURE_PROVIDER } from "./transport.js";

// Deterministic stay builder for unit tests. Prices are test inputs only.

export interface StayFixture {
  readonly id: string;
  readonly city: Location;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly amountMinor: number;
  readonly guests?: number;
  readonly sourceType?: SourceType;
}

export function stay(fixture: StayFixture): Stay {
  return staySchema.parse({
    id: fixture.id,
    propertyId: `property-${fixture.id}`,
    city: fixture.city,
    checkIn: fixture.checkIn,
    checkOut: fixture.checkOut,
    nights: daysBetween(parseLocalDate(fixture.checkIn), parseLocalDate(fixture.checkOut)),
    guests: fixture.guests ?? 2,
    rooms: 1,
    price: { amountMinor: fixture.amountMinor, currency: "EUR" },
    provenance: {
      provider: FIXTURE_PROVIDER,
      providerReference: fixture.id,
      sourceType: fixture.sourceType ?? "cached",
      fetchedAt: "2026-09-17T12:00:00Z",
    },
  });
}
