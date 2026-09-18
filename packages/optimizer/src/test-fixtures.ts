import {
  locationSchema,
  normalizeSearchRequest,
  okResult,
  parseUtcInstant,
  transportOfferSchema,
  transportSegmentSchema,
  zonedTimestampFromOffsetIso,
  type AirportGeography,
  type CityRepository,
  type FlightProvider,
  type FlightSearchQuery,
  type Location,
  type ProviderCallMetrics,
  type ProviderResult,
  type SearchRequest,
  type TransportOffer,
  type TransportSearchResult,
  type TransportSegment,
} from "@travel-optimizer/domain";

/*
 * Synthetic fixtures for optimizer tests. Prices, airports and fares here are
 * TEST INPUTS, not provider data, and no test touches the network.
 */

export const FIXTURE_PROVIDER = "fixture-flights";

function location(input: {
  code: string;
  name: string;
  timeZone: string;
  countryCode: string;
  type?: "airport" | "city";
}): Location {
  const type = input.type ?? "airport";
  return locationSchema.parse({
    id: `${type}:${input.code}`,
    type,
    name: input.name,
    countryCode: input.countryCode,
    latitude: 45,
    longitude: 15,
    timeZone: input.timeZone,
    iata: input.code,
  });
}

/** A minimal airport fixture; coordinates are placeholders. */
export function airport(code: string, name: string, timeZone = "Europe/Sarajevo"): Location {
  return location({ code, name, timeZone, countryCode: "BA" });
}

export const SJJ = location({ code: "SJJ", name: "Sarajevo", timeZone: "Europe/Sarajevo", countryCode: "BA" });
export const FCO = location({ code: "FCO", name: "Rome Fiumicino", timeZone: "Europe/Rome", countryCode: "IT" });
export const CIA = location({ code: "CIA", name: "Rome Ciampino", timeZone: "Europe/Rome", countryCode: "IT" });
export const SAW = location({ code: "SAW", name: "Istanbul Sabiha", timeZone: "Europe/Istanbul", countryCode: "TR" });
export const ROME = location({ code: "ROM", name: "Rome", timeZone: "Europe/Rome", countryCode: "IT", type: "city" });
export const ISTANBUL = location({ code: "IST", name: "Istanbul", timeZone: "Europe/Istanbul", countryCode: "TR", type: "city" });

/**
 * Distances used by the fixture geography, in kilometres. Roughly real:
 * Fiumicino and Sabiha Gokcen need an access transfer, Ciampino does not.
 */
export const FIXTURE_DISTANCES_KM: Record<string, number> = {
  [`${FCO.id}->${ROME.id}`]: 30,
  [`${CIA.id}->${ROME.id}`]: 15,
  [`${SAW.id}->${ISTANBUL.id}`]: 40,
};

export const fixtureGeography: AirportGeography = {
  provenance: {
    source: "test-fixture",
    fetchedAt: parseUtcInstant("2026-09-18T08:00:00Z"),
    recordCount: 4,
  },
  distanceBetween: (from, to) =>
    FIXTURE_DISTANCES_KM[`${from.id}->${to.id}`] ??
    FIXTURE_DISTANCES_KM[`${to.id}->${from.id}`] ??
    Number.POSITIVE_INFINITY,
  findNearby: () => [],
};

export const cityRepository: CityRepository = {
  provenance: {
    source: "test-fixture",
    fetchedAt: parseUtcInstant("2026-09-18T08:00:00Z"),
    recordCount: 2,
  },
  findByCode: (code) => (code === "ROM" ? ROME : code === "IST" ? ISTANBUL : undefined),
  findForAirport: (airport) => {
    if (airport.id === FCO.id || airport.id === CIA.id) return ROME;
    if (airport.id === SAW.id) return ISTANBUL;
    return undefined;
  },
};

export interface SegmentSpec {
  readonly id: string;
  readonly origin: Location;
  readonly destination: Location;
  readonly departure: string;
  readonly arrival: string;
  readonly transfers?: number;
}

export function segment(spec: SegmentSpec): TransportSegment {
  const departureAt = zonedTimestampFromOffsetIso(spec.departure, spec.origin.timeZone);
  const arrivalAt = zonedTimestampFromOffsetIso(spec.arrival, spec.destination.timeZone);
  const durationMinutes = Math.round(
    (Date.parse(arrivalAt.instant) - Date.parse(departureAt.instant)) / 60_000,
  );
  return transportSegmentSchema.parse({
    id: spec.id,
    mode: "flight",
    origin: spec.origin,
    destination: spec.destination,
    departureAt,
    arrivalAt,
    durationMinutes,
    transfers: spec.transfers ?? 0,
    carrier: "XX",
    provider: FIXTURE_PROVIDER,
  });
}

export function offer(id: string, segmentIds: readonly string[], amountMinor: number): TransportOffer {
  return transportOfferSchema.parse({
    id,
    segmentIds,
    price: { amountMinor, currency: "EUR" },
    priceBasis: { kind: "perTraveler" },
    provenance: {
      provider: FIXTURE_PROVIDER,
      providerReference: id,
      sourceType: "cached",
      fetchedAt: "2026-09-18T09:00:00Z",
    },
  });
}

/** A round trip fixture: two segments priced by one fare. */
export function roundTrip(options: {
  readonly id: string;
  readonly destination: Location;
  readonly outbound: [string, string];
  readonly inbound: [string, string];
  readonly amountMinor: number;
  readonly transfers?: number;
}): { segments: TransportSegment[]; offer: TransportOffer } {
  const out = segment({
    id: `${options.id}-out`,
    origin: SJJ,
    destination: options.destination,
    departure: options.outbound[0],
    arrival: options.outbound[1],
    ...(options.transfers !== undefined && { transfers: options.transfers }),
  });
  const back = segment({
    id: `${options.id}-back`,
    origin: options.destination,
    destination: SJJ,
    departure: options.inbound[0],
    arrival: options.inbound[1],
  });
  return {
    segments: [out, back],
    offer: offer(options.id, [out.id, back.id], options.amountMinor),
  };
}

export const metrics: ProviderCallMetrics = {
  startedAt: parseUtcInstant("2026-09-18T09:00:00Z"),
  completedAt: parseUtcInstant("2026-09-18T09:00:01Z"),
  requestCount: 1,
  cache: "miss",
};

/** A FlightProvider stub that returns exactly what a test gives it. */
export function stubFlightProvider(
  result: ProviderResult<TransportSearchResult>,
  onQuery?: (query: FlightSearchQuery) => void,
): FlightProvider {
  return {
    descriptor: {
      id: FIXTURE_PROVIDER,
      kind: "flight",
      enabled: true,
      sourceTypes: ["cached"],
    },
    search: (query) => {
      onQuery?.(query);
      return Promise.resolve(result);
    },
  };
}

export function searchResult(
  parts: readonly { segments: TransportSegment[]; offer: TransportOffer }[],
): ProviderResult<TransportSearchResult> {
  return okResult(
    FIXTURE_PROVIDER,
    {
      segments: parts.flatMap((part) => part.segments),
      offers: parts.map((part) => part.offer),
    },
    metrics,
  );
}

export function request(overrides: Record<string, unknown> = {}): SearchRequest {
  const result = normalizeSearchRequest({
    origin: "SJJ",
    destination: null,
    departureDate: "2026-12-26",
    returnDate: "2027-01-03",
    flexibilityDays: 2,
    minNights: 5,
    maxNights: 7,
    travelers: 2,
    transportModes: ["flight"],
    allowOpenJaw: false,
    allowMultiCity: false,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join("; "));
  return result.request;
}
