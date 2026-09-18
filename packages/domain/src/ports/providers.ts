import type { Stay } from "../accommodation.js";
import { DomainError } from "../errors.js";
import type { Location } from "../location.js";
import type { CurrencyCode } from "../money/currency.js";
import type { SourceType } from "../provenance.js";
import type { LocalDate } from "../time/local-date.js";
import type { UtcInstant } from "../time/zoned-timestamp.js";
import type { TransportOffer, TransportSegment } from "../transport.js";

/*
 * Provider ports.
 *
 * The domain defines these interfaces; adapters in a providers package
 * implement them. Adapters validate external responses with Zod and return
 * only normalized domain objects: provider DTOs never cross this boundary.
 *
 * Contract for every implementation:
 * - Provider errors (timeouts, rate limits, bad responses) are returned as a
 *   `failed` or `partial` result, not thrown, so one provider cannot fail a
 *   whole search.
 * - Every price carries provenance with an accurate source type; cached data
 *   is never labeled live.
 * - A multi-segment fare is returned as one offer, never split
 *   (docs/decisions/0002-separate-transport-offers-from-segments.md).
 * - Nothing is fabricated: no data means empty results, not placeholders.
 */

export type ProviderKind = "flight" | "rail" | "bus" | "accommodation";

export interface ProviderDescriptor {
  /** Stable provider id, used in provenance (e.g. "aviasales"). */
  readonly id: string;
  readonly kind: ProviderKind;
  /** Disabled providers are skipped without changing optimizer code. */
  readonly enabled: boolean;
  /** Source types this provider can legitimately produce. */
  readonly sourceTypes: readonly SourceType[];
  /**
   * Calls this provider will accept for one search. The optimizer budgets
   * fan-out against it instead of hard-coding a provider's limit.
   */
  readonly maxCallsPerSearch?: number;
}

export type ProviderFailureKind =
  | "timeout"
  | "rate_limited"
  | "unauthorized"
  | "unavailable"
  | "invalid_response"
  | "unsupported_query"
  | "unknown";

export interface ProviderFailure {
  readonly kind: ProviderFailureKind;
  readonly message: string;
  readonly retryable: boolean;
}

export type CacheOutcome = "hit" | "miss" | "bypass";

/** Observability data for one logical provider call. */
export interface ProviderCallMetrics {
  readonly startedAt: UtcInstant;
  readonly completedAt: UtcInstant;
  /** External HTTP requests actually sent (0 on a full cache hit). */
  readonly requestCount: number;
  readonly cache: CacheOutcome;
}

export type NonEmptyArray<T> = readonly [T, ...T[]];

export type ProviderResult<T> =
  | {
      readonly status: "ok";
      readonly provider: string;
      readonly data: T;
      readonly failures: readonly [];
      readonly metrics: ProviderCallMetrics;
    }
  | {
      /** Some data was retrieved, but part of the query failed. */
      readonly status: "partial";
      readonly provider: string;
      readonly data: T;
      readonly failures: NonEmptyArray<ProviderFailure>;
      readonly metrics: ProviderCallMetrics;
    }
  | {
      readonly status: "failed";
      readonly provider: string;
      readonly failures: NonEmptyArray<ProviderFailure>;
      readonly metrics: ProviderCallMetrics;
    };

export function okResult<T>(
  provider: string,
  data: T,
  metrics: ProviderCallMetrics,
): ProviderResult<T> {
  return { status: "ok", provider, data, failures: [], metrics };
}

export function partialResult<T>(
  provider: string,
  data: T,
  failures: readonly ProviderFailure[],
  metrics: ProviderCallMetrics,
): ProviderResult<T> {
  const [first, ...rest] = failures;
  if (first === undefined) {
    throw new DomainError("PARTIAL_RESULT_WITHOUT_FAILURE", "A partial result must list failures");
  }
  return { status: "partial", provider, data, failures: [first, ...rest], metrics };
}

export function failedResult<T>(
  provider: string,
  failures: readonly ProviderFailure[],
  metrics: ProviderCallMetrics,
): ProviderResult<T> {
  const [first, ...rest] = failures;
  if (first === undefined) {
    throw new DomainError("FAILED_RESULT_WITHOUT_FAILURE", "A failed result must list failures");
  }
  return { status: "failed", provider, failures: [first, ...rest], metrics };
}

/**
 * Normalized transport search output. Segments without an offer are
 * timetable-only (no known price).
 */
export interface TransportSearchResult {
  readonly segments: readonly TransportSegment[];
  readonly offers: readonly TransportOffer[];
}

export interface LocalDateRange {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

export interface FlightSearchQuery {
  /** IATA airport or metropolitan-area codes. */
  readonly origins: readonly string[];
  /** IATA codes, or "anywhere" for destination discovery. */
  readonly destinations: readonly string[] | "anywhere";
  readonly departureDates: LocalDateRange;
  /** Absent for one-way searches. */
  readonly returnDates?: LocalDateRange;
  readonly travelers: number;
  readonly currency: CurrencyCode;
}

export interface GroundTransportSearchQuery {
  readonly origin: Location;
  readonly destination: Location;
  readonly departureDates: LocalDateRange;
  readonly travelers: number;
  readonly currency: CurrencyCode;
}

export interface StaySearchQuery {
  readonly city: Location;
  readonly checkIn: LocalDate;
  readonly checkOut: LocalDate;
  readonly guests: number;
  readonly rooms: number;
  readonly currency: CurrencyCode;
}

export interface ProviderCallOptions {
  readonly signal?: AbortSignal;
}

export interface FlightProvider {
  readonly descriptor: ProviderDescriptor;
  search(
    query: FlightSearchQuery,
    options?: ProviderCallOptions,
  ): Promise<ProviderResult<TransportSearchResult>>;
}

export interface RailProvider {
  readonly descriptor: ProviderDescriptor;
  search(
    query: GroundTransportSearchQuery,
    options?: ProviderCallOptions,
  ): Promise<ProviderResult<TransportSearchResult>>;
}

export interface BusProvider {
  readonly descriptor: ProviderDescriptor;
  search(
    query: GroundTransportSearchQuery,
    options?: ProviderCallOptions,
  ): Promise<ProviderResult<TransportSearchResult>>;
}

export interface AccommodationProvider {
  readonly descriptor: ProviderDescriptor;
  search(
    query: StaySearchQuery,
    options?: ProviderCallOptions,
  ): Promise<ProviderResult<readonly Stay[]>>;
}
