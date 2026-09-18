import {
  DomainError,
  lookupAirport,
  minorUnitDigits,
  parseMoney,
  parseUtcInstant,
  transportOfferSchema,
  transportSegmentSchema,
  zonedTimestampFromOffsetIso,
  type AirportRepository,
  type CurrencyCode,
  type DomainIssue,
  type Location,
  type Money,
  type TransportOffer,
  type TransportSegment,
  type UtcInstant,
  type ZonedTimestamp,
} from "@travel-optimizer/domain";

import type { AviasalesPriceRecord } from "./dto.js";

/*
 * Normalizes Aviasales price records into domain segments and offers.
 *
 * Rules come from docs/decisions/0006-aviasales-data-api-semantics.md:
 * arrival times are derived from durations, a round-trip record is one offer
 * over two segments, prices are per traveler and always `cached`, and any
 * record we cannot map exactly is dropped with a reason rather than patched.
 */

export const AVIASALES_PROVIDER_ID = "aviasales";

export interface MapRecordOptions {
  readonly airports: AirportRepository;
  /** Currency the provider quoted, from the response envelope or the request. */
  readonly currency: CurrencyCode;
  /** When we received the response; the only timestamp this API gives us. */
  readonly fetchedAt: UtcInstant;
  /** Affiliate marker. Without it no booking link is produced. */
  readonly marker?: string;
  readonly bookingBaseUrl: string;
}

export interface MappedRecord {
  readonly segments: readonly TransportSegment[];
  readonly offer: TransportOffer;
}

export type RecordMapping =
  | { readonly ok: true; readonly mapped: MappedRecord }
  | { readonly ok: false; readonly issue: DomainIssue };

function drop(code: string, message: string): RecordMapping {
  return { ok: false, issue: { code, message } };
}

function describe(record: AviasalesPriceRecord): string {
  return `${record.origin_airport}-${record.destination_airport} ${record.departure_at}`;
}

/**
 * Converts a provider price to Money, refusing amounts that cannot be
 * represented exactly in the currency's minor unit rather than rounding a fare.
 */
export function priceToMoney(value: number, currency: CurrencyCode): Money | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  const digits = minorUnitDigits(currency);
  const scaled = value * 10 ** digits;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-6) return undefined;
  try {
    return parseMoney(value.toFixed(digits), currency);
  } catch {
    return undefined;
  }
}

function arrivalAfter(
  departure: ZonedTimestamp,
  durationMinutes: number,
  destination: Location,
): ZonedTimestamp {
  // Derived, not observed: the API returns no arrival time (ADR 0006 §3).
  return {
    instant: parseUtcInstant(
      new Date(Date.parse(departure.instant) + durationMinutes * 60_000).toISOString(),
    ),
    timeZone: destination.timeZone,
  };
}

function segmentId(
  origin: Location,
  destination: Location,
  departure: ZonedTimestamp,
  record: AviasalesPriceRecord,
): string {
  const service = record.flight_number === undefined ? record.airline : `${record.airline}${String(record.flight_number)}`;
  return `${AVIASALES_PROVIDER_ID}:${origin.iata ?? origin.id}-${destination.iata ?? destination.id}:${departure.instant}:${service}`;
}

function buildSegment(
  origin: Location,
  destination: Location,
  departureIso: string,
  durationMinutes: number,
  transfers: number,
  record: AviasalesPriceRecord,
): TransportSegment | DomainIssue {
  let departure: ZonedTimestamp;
  try {
    departure = zonedTimestampFromOffsetIso(departureIso, origin.timeZone);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    // Includes offsets that disagree with the airport's zone (ADR 0006 §6).
    return { code: error.code, message: `${describe(record)}: ${error.message}` };
  }

  const candidate = {
    id: segmentId(origin, destination, departure, record),
    mode: "flight",
    origin,
    destination,
    departureAt: departure,
    arrivalAt: arrivalAfter(departure, durationMinutes, destination),
    durationMinutes,
    transfers,
    carrier: record.airline,
    ...(record.flight_number !== undefined && { serviceNumber: String(record.flight_number) }),
    provider: AVIASALES_PROVIDER_ID,
  };

  const parsed = transportSegmentSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      code: "SEGMENT_REJECTED_BY_DOMAIN",
      message: `${describe(record)}: ${parsed.error.issues
        .map((issue) => `${issue.path.map(String).join(".")} ${issue.message}`)
        .join("; ")}`,
    };
  }
  return parsed.data;
}

function isIssue(value: TransportSegment | DomainIssue): value is DomainIssue {
  return "code" in value;
}

function bookingUrl(record: AviasalesPriceRecord, options: MapRecordOptions): string | undefined {
  if (options.marker === undefined || record.link === undefined) return undefined;
  try {
    const url = new URL(record.link, options.bookingBaseUrl);
    url.searchParams.set("marker", options.marker);
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Maps one record into its segments and the single offer that prices them. */
export function mapPriceRecord(
  record: AviasalesPriceRecord,
  options: MapRecordOptions,
): RecordMapping {
  const originLookup = lookupAirport(options.airports, record.origin_airport);
  if (!originLookup.ok) return drop(originLookup.issue.code, originLookup.issue.message);
  const destinationLookup = lookupAirport(options.airports, record.destination_airport);
  if (!destinationLookup.ok) {
    return drop(destinationLookup.issue.code, destinationLookup.issue.message);
  }
  const origin = originLookup.airport;
  const destination = destinationLookup.airport;

  const price = priceToMoney(record.price, options.currency);
  if (price === undefined) {
    return drop(
      "UNREPRESENTABLE_PRICE",
      `${describe(record)}: price ${record.price} is not exact in ${options.currency}`,
    );
  }

  const outboundMinutes =
    record.duration_to ?? (record.return_at === undefined ? record.duration : undefined);
  if (outboundMinutes === undefined || outboundMinutes <= 0) {
    return drop("MISSING_DURATION", `${describe(record)}: no outbound duration`);
  }

  const outbound = buildSegment(
    origin,
    destination,
    record.departure_at,
    outboundMinutes,
    record.transfers ?? 0,
    record,
  );
  if (isIssue(outbound)) return { ok: false, issue: outbound };

  const segments: TransportSegment[] = [outbound];

  if (record.return_at !== undefined) {
    const inboundMinutes = record.duration_back;
    if (inboundMinutes === undefined || inboundMinutes <= 0) {
      return drop("MISSING_DURATION", `${describe(record)}: no return duration`);
    }
    const inbound = buildSegment(
      destination,
      origin,
      record.return_at,
      inboundMinutes,
      record.return_transfers ?? 0,
      record,
    );
    if (isIssue(inbound)) return { ok: false, issue: inbound };
    segments.push(inbound);
  }

  const link = record.link?.split("?")[0];
  // The id includes what distinguishes one fare from another over the same
  // flights (price and selling agency), so two agencies quoting the same
  // segments produce two offers instead of silently collapsing into one.
  const fareKey = `${String(price.amountMinor)}${price.currency}${record.gate === undefined ? "" : `:${record.gate}`}`;
  const offerCandidate = {
    id: `${AVIASALES_PROVIDER_ID}:offer:${segments.map((segment) => segment.id).join("+")}:${fareKey}`,
    segmentIds: segments.map((segment) => segment.id),
    price,
    // The API has no passenger parameter; prices are per adult (ADR 0006 §4).
    priceBasis: { kind: "perTraveler" },
    provenance: {
      provider: AVIASALES_PROVIDER_ID,
      ...(link !== undefined && { providerReference: link }),
      // Cached fares with no expiry of their own (ADR 0006 §1).
      sourceType: "cached",
      fetchedAt: options.fetchedAt,
      ...(record.expires_at !== undefined && { expiresAt: record.expires_at }),
    },
    ...(bookingUrl(record, options) !== undefined && { bookingUrl: bookingUrl(record, options) }),
  };

  const offer = transportOfferSchema.safeParse(offerCandidate);
  if (!offer.success) {
    return drop(
      "OFFER_REJECTED_BY_DOMAIN",
      `${describe(record)}: ${offer.error.issues
        .map((issue) => `${issue.path.map(String).join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  }
  return { ok: true, mapped: { segments, offer: offer.data } };
}

export interface MappedRecords {
  readonly segments: readonly TransportSegment[];
  readonly offers: readonly TransportOffer[];
  /** One issue per dropped record, so a thin result is visibly thin. */
  readonly issues: readonly DomainIssue[];
}

/** Maps many records, de-duplicating segments that several fares share. */
export function mapPriceRecords(
  records: readonly AviasalesPriceRecord[],
  options: MapRecordOptions,
): MappedRecords {
  const segments = new Map<string, TransportSegment>();
  const offers = new Map<string, TransportOffer>();
  const issues: DomainIssue[] = [];

  for (const record of records) {
    const mapping = mapPriceRecord(record, options);
    if (!mapping.ok) {
      issues.push(mapping.issue);
      continue;
    }
    for (const segment of mapping.mapped.segments) {
      segments.set(segment.id, segment);
    }
    offers.set(mapping.mapped.offer.id, mapping.mapped.offer);
  }

  return { segments: [...segments.values()], offers: [...offers.values()], issues };
}
