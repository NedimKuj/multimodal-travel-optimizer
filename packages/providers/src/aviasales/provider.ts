import {
  failedResult,
  isCurrencyCode,
  localDate,
  okResult,
  parseLocalDate,
  parseUtcInstant,
  partialResult,
  compareLocalDates,
  type AirportRepository,
  type CurrencyCode,
  type DomainIssue,
  type FlightProvider,
  type FlightSearchQuery,
  type LocalDateRange,
  type ProviderCallMetrics,
  type ProviderCallOptions,
  type ProviderDescriptor,
  type ProviderFailure,
  type ProviderResult,
  type TransportOffer,
  type TransportSegment,
  type TransportSearchResult,
} from "@travel-optimizer/domain";

import type { ResponseCache } from "../cache.js";
import { httpGetText, redactSecrets, type FetchLike } from "../http.js";
import { secretsOf, type AviasalesConfig } from "./config.js";
import { aviasalesPricesForDatesResponseSchema, parseResponse } from "./dto.js";
import { AVIASALES_PROVIDER_ID, mapPriceRecords } from "./mapper.js";

/*
 * Aviasales flight provider.
 *
 * Discovery only: every price it produces is `cached`
 * (docs/decisions/0006-aviasales-data-api-semantics.md). Queries are month
 * granular because exact-date queries return almost nothing, and results are
 * filtered back to the requested window locally.
 */

/** Hard ceiling on calls per search, so one query cannot fan out unbounded. */
export const MAX_CALLS_PER_SEARCH = 12;

export interface AviasalesProviderOptions {
  readonly config: AviasalesConfig;
  readonly airports: AirportRepository;
  readonly cache?: ResponseCache;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
}

interface PlannedCall {
  readonly url: string;
  readonly month: string;
}

/** Months (YYYY-MM) touched by a date range, in order. */
export function monthsInRange(range: LocalDateRange): string[] {
  const months: string[] = [];
  let cursor = range.from.slice(0, 7);
  const last = range.to.slice(0, 7);
  while (cursor <= last) {
    months.push(cursor);
    const [year = "", month = ""] = cursor.split("-");
    const next = Number(month) === 12 ? `${String(Number(year) + 1)}-01` : `${year}-${String(Number(month) + 1).padStart(2, "0")}`;
    cursor = next;
    // Safety stop for an absurd range. Any range this long blows the call
    // budget below, so a truncated list can never reach a result.
    if (months.length > 24) break;
  }
  return months;
}

interface CallShape {
  readonly origin: string;
  readonly destination: string | undefined;
  readonly month: string;
  readonly returnMonth: string | undefined;
}

function buildSearchUrl(
  config: AviasalesConfig,
  query: FlightSearchQuery,
  shape: CallShape,
): string {
  const url = new URL("/aviasales/v3/prices_for_dates", config.baseUrl);
  url.searchParams.set("origin", shape.origin);
  if (shape.destination !== undefined) url.searchParams.set("destination", shape.destination);
  url.searchParams.set("departure_at", shape.month);
  if (shape.returnMonth !== undefined) url.searchParams.set("return_at", shape.returnMonth);
  const oneWay = query.returnDates === undefined;
  url.searchParams.set("one_way", String(oneWay));
  url.searchParams.set("currency", query.currency.toLowerCase());
  url.searchParams.set("limit", "1000");
  url.searchParams.set("sorting", "price");
  // `unique=true` returns one record per destination. For one-way discovery
  // that is breadth (48 destinations vs 7). For round trips it is the
  // opposite: one record per destination means one date pair per destination,
  // and most of those pairs fall outside any specific travel window, so it is
  // left off (measured 2026-09-18: 5 in-window fares without it, 2 with).
  if (shape.destination === undefined && oneWay) url.searchParams.set("unique", "true");
  return url.toString();
}

function planCalls(config: AviasalesConfig, query: FlightSearchQuery): PlannedCall[] {
  const departureMonths = monthsInRange(query.departureDates);
  // A query carries one departure month and one return month, so a return
  // window spanning two months needs one call per pair. Querying only the
  // first month would silently drop the rest of the user's return window.
  const returnMonths =
    query.returnDates === undefined ? [undefined] : monthsInRange(query.returnDates);
  const destinations = query.destinations === "anywhere" ? [undefined] : query.destinations;

  const calls: PlannedCall[] = [];
  for (const origin of query.origins) {
    for (const destination of destinations) {
      for (const month of departureMonths) {
        for (const returnMonth of returnMonths) {
          // A return before the outbound month is not a trip.
          if (returnMonth !== undefined && returnMonth < month) continue;
          calls.push({
            url: buildSearchUrl(config, query, { origin, destination, month, returnMonth }),
            month,
          });
        }
      }
    }
  }
  return calls;
}

function withinWindow(segment: TransportSegment, range: LocalDateRange): boolean {
  const date = localDate(segment.departureAt);
  return (
    compareLocalDates(date, parseLocalDate(range.from)) >= 0 &&
    compareLocalDates(date, parseLocalDate(range.to)) <= 0
  );
}

/**
 * Keeps only offers whose flights fall inside the requested dates.
 *
 * Month-granular queries return the whole month, and returning those extra
 * dates would silently widen the user's constraints.
 */
function filterToWindow(
  segments: readonly TransportSegment[],
  offers: readonly TransportOffer[],
  query: FlightSearchQuery,
): TransportSearchResult {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const keptOffers = offers.filter((offer) => {
    const offerSegments = offer.segmentIds.map((id) => byId.get(id));
    if (offerSegments.some((segment) => segment === undefined)) return false;
    const [outbound, inbound] = offerSegments;
    if (outbound === undefined || !withinWindow(outbound, query.departureDates)) return false;
    if (query.returnDates !== undefined) {
      if (inbound === undefined) return false;
      if (!withinWindow(inbound, query.returnDates)) return false;
    }
    return true;
  });

  const keptSegmentIds = new Set(keptOffers.flatMap((offer) => offer.segmentIds));
  return {
    segments: segments.filter((segment) => keptSegmentIds.has(segment.id)),
    offers: keptOffers,
  };
}

function summarizeIssues(issues: readonly DomainIssue[]): ProviderFailure | undefined {
  if (issues.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const issue of issues) {
    counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  }
  const breakdown = [...counts.entries()].map(([code, count]) => `${code}×${String(count)}`).join(", ");
  return {
    kind: "invalid_response",
    message: `${String(issues.length)} record(s) dropped as unusable: ${breakdown}`,
    retryable: false,
  };
}

export function createAviasalesFlightProvider(
  options: AviasalesProviderOptions,
): FlightProvider {
  const { config, airports, cache, fetchImpl, now = () => new Date() } = options;
  const secrets = secretsOf(config);

  const descriptor: ProviderDescriptor = {
    id: AVIASALES_PROVIDER_ID,
    kind: "flight",
    enabled: config.enabled,
    // This API only ever serves cached fares.
    sourceTypes: ["cached"],
  };

  return {
    descriptor,
    async search(
      query: FlightSearchQuery,
      callOptions?: ProviderCallOptions,
    ): Promise<ProviderResult<TransportSearchResult>> {
      const startedAt = parseUtcInstant(now().toISOString());
      const failures: ProviderFailure[] = [];
      const allSegments: TransportSegment[] = [];
      const allOffers: TransportOffer[] = [];
      const issues: DomainIssue[] = [];
      let requestCount = 0;
      let cacheHits = 0;

      const finish = (): ProviderCallMetrics => ({
        startedAt,
        completedAt: parseUtcInstant(now().toISOString()),
        requestCount,
        cache: requestCount === 0 && cacheHits > 0 ? "hit" : cacheHits > 0 ? "miss" : cache === undefined ? "bypass" : "miss",
      });

      if (!config.enabled) {
        return failedResult(
          descriptor.id,
          [{ kind: "unsupported_query", message: "Provider is disabled", retryable: false }],
          finish(),
        );
      }

      const planned = planCalls(config, query);
      if (planned.length > MAX_CALLS_PER_SEARCH) {
        // Refuse rather than truncate: truncating would quietly narrow the search.
        return failedResult(
          descriptor.id,
          [
            {
              kind: "unsupported_query",
              message: `Query needs ${String(planned.length)} calls, over the ${String(MAX_CALLS_PER_SEARCH)} call budget. Narrow the origins, destinations or date range.`,
              retryable: false,
            },
          ],
          finish(),
        );
      }

      for (const call of planned) {
        const key = redactSecrets(call.url, secrets);
        let body = cache?.get(key)?.body;
        if (body !== undefined) {
          cacheHits += 1;
        } else {
          const outcome = await httpGetText(
            {
              url: call.url,
              timeoutMs: config.timeoutMs,
              headers: { "x-access-token": config.token },
              ...(callOptions?.signal !== undefined && { signal: callOptions.signal }),
            },
            fetchImpl,
          );
          requestCount += 1;
          if (!outcome.ok) {
            failures.push({
              ...outcome.failure,
              message: redactSecrets(outcome.failure.message, secrets),
            });
            continue;
          }
          body = outcome.body;
          cache?.set(key, body);
        }

        const parsed = parseResponse(body, aviasalesPricesForDatesResponseSchema);
        if (!parsed.ok) {
          failures.push(parsed.failure);
          continue;
        }

        const currency = resolveCurrency(parsed.response.currency, query.currency);
        if (currency === undefined) {
          failures.push({
            kind: "invalid_response",
            message: `Provider answered in ${String(parsed.response.currency)} but ${query.currency} was requested`,
            retryable: false,
          });
          continue;
        }

        const mapped = mapPriceRecords(parsed.response.data, {
          airports,
          currency,
          fetchedAt: parseUtcInstant(now().toISOString()),
          ...(config.marker !== undefined && { marker: config.marker }),
          bookingBaseUrl: config.bookingBaseUrl,
        });
        allSegments.push(...mapped.segments);
        allOffers.push(...mapped.offers);
        issues.push(...mapped.issues);
      }

      const metrics = finish();
      if (failures.length === planned.length && planned.length > 0) {
        return failedResult(descriptor.id, failures, metrics);
      }

      const data = filterToWindow(dedupe(allSegments), dedupe(allOffers), query);
      const dropped = summarizeIssues(issues);
      const allFailures = dropped === undefined ? failures : [...failures, dropped];
      if (allFailures.length > 0) {
        return partialResult(descriptor.id, data, allFailures, metrics);
      }
      return okResult(descriptor.id, data, metrics);
    },
  };
}

function dedupe<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function resolveCurrency(
  responseCurrency: string | undefined,
  requested: CurrencyCode,
): CurrencyCode | undefined {
  if (responseCurrency === undefined) return requested;
  const upper = responseCurrency.toUpperCase();
  if (!isCurrencyCode(upper) || upper !== requested) return undefined;
  return requested;
}
