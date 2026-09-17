import type { Location } from "../location.js";
import type { CurrencyCode } from "../money/currency.js";
import type { SourceType } from "../provenance.js";
import { minutesBetween, zonedTimestampFromOffsetIso } from "../time/zoned-timestamp.js";
import {
  transportOfferSchema,
  transportSegmentSchema,
  type PriceBasis,
  type TransportMode,
  type TransportOffer,
  type TransportSegment,
} from "../transport.js";

// Deterministic builders for unit tests. Prices here are test inputs, not
// real fares, and every fixture offer is attributed to a fixture provider.

export const FIXTURE_PROVIDER = "fixture";

export interface SegmentFixture {
  readonly id: string;
  readonly mode: TransportMode;
  readonly origin: Location;
  readonly destination: Location;
  /** ISO-8601 with explicit offset, local to the origin. */
  readonly departure: string;
  /** ISO-8601 with explicit offset, local to the destination. */
  readonly arrival: string;
  readonly transfers?: number;
}

export function segment(fixture: SegmentFixture): TransportSegment {
  const departureAt = zonedTimestampFromOffsetIso(fixture.departure, fixture.origin.timeZone);
  const arrivalAt = zonedTimestampFromOffsetIso(fixture.arrival, fixture.destination.timeZone);
  return transportSegmentSchema.parse({
    id: fixture.id,
    mode: fixture.mode,
    origin: fixture.origin,
    destination: fixture.destination,
    departureAt,
    arrivalAt,
    durationMinutes: Math.round(minutesBetween(departureAt, arrivalAt)),
    transfers: fixture.transfers ?? 0,
    provider: FIXTURE_PROVIDER,
  });
}

export interface OfferFixture {
  readonly id: string;
  readonly segmentIds: readonly string[];
  readonly amountMinor: number;
  readonly currency?: CurrencyCode;
  readonly priceBasis?: PriceBasis;
  readonly sourceType?: SourceType;
}

export function offer(fixture: OfferFixture): TransportOffer {
  return transportOfferSchema.parse({
    id: fixture.id,
    segmentIds: fixture.segmentIds,
    price: { amountMinor: fixture.amountMinor, currency: fixture.currency ?? "EUR" },
    priceBasis: fixture.priceBasis ?? { kind: "perTraveler" },
    provenance: {
      provider: FIXTURE_PROVIDER,
      providerReference: fixture.id,
      sourceType: fixture.sourceType ?? "cached",
      fetchedAt: "2026-09-17T12:00:00Z",
    },
  });
}
