import {
  budgetTotal,
  compareMoney,
  localDate,
  lookupCityForAirport,
  parseUtcInstant,
  summarizeTrip,
  type AirportGeography,
  type AirportRepository,
  type CityRepository,
  type CurrencyCode,
  type DomainIssue,
  type FlightProvider,
  type FlightSearchQuery,
  type Location,
  type ProviderCallMetrics,
  type ProviderFailure,
  type SearchRequest,
  type TransportOffer,
  type TransportSegment,
  type ItineraryGap,
  type TripCandidate,
  type TripSummary,
} from "@travel-optimizer/domain";

import {
  DEFAULT_CONNECTION_RULES,
  requiredConnectionMinutes,
  validateConnections,
  type ConnectionRules,
} from "./connection-rules.js";
import {
  buildGroundTransferLeg,
  DEFAULT_GROUND_TRANSFER_CONFIG,
  needsAccessTransfer,
  type GroundTransferConfig,
} from "./ground-transfer.js";
import {
  expandOrigins,
  originCodes,
  type OriginExpansion,
  type OriginExpansionConfig,
} from "./origin-expansion.js";
import { evaluateTrip, resolveTravelWindow, type TravelWindow } from "./travel-window.js";

/*
 * Phase 1 flight exploration.
 *
 * Provider-agnostic: it talks to the FlightProvider port and never knows which
 * provider is behind it. Discovery uses provider round-trip fares only
 * (docs/decisions/0008-phase-1-round-trip-discovery.md); composing two one-way
 * fares belongs to the open-jaw phase.
 *
 * Costs here are transport only. They are never a complete-trip cost, because
 * accommodation does not exist until Phase 4.
 */

export interface RankedCandidate {
  readonly candidate: TripCandidate;
  readonly summary: TripSummary;
  readonly nights: number;
}

export interface DestinationResult {
  /** The first destination city, when the reference data resolves one. */
  readonly city: Location | undefined;
  /** Every city visited, in order: one for a round trip, two for an open jaw. */
  readonly cities: readonly Location[];
  /** Destination airports behind this city, in first-seen order. */
  readonly airports: readonly Location[];
  /** Candidates for this destination, cheapest first. */
  readonly candidates: readonly RankedCandidate[];
}

export interface ExplorationCounts {
  readonly offersReturned: number;
  readonly candidatesBuilt: number;
  readonly rejectedNotRoundTrip: number;
  /** Rejected because a connection was too short to be travelled. */
  readonly rejectedInfeasible: number;
  readonly rejectedInvalid: number;
  readonly rejectedOutsideWindow: number;
  readonly rejectedNights: number;
  readonly rejectedBudget: number;
  /** Open-jaw pairings whose unpriced sector was too far to be plausible. */
  readonly rejectedGapTooFar: number;
  /** Pairings where the way home leaves before the outbound arrives. */
  readonly rejectedReturnBeforeArrival: number;
  /** Destinations reached but with no retrieved way home. */
  readonly destinationsWithoutReturn: number;
  readonly destinations: number;
}

export interface DiscoveryRecord {
  readonly enriched: readonly { readonly airport: Location; readonly returnOffersFound: number }[];
  readonly skipped: readonly { readonly airport: Location; readonly reason: string }[];
  readonly callsPlanned: number;
  readonly callBudget: number;
}

export interface FlightExplorationResult {
  readonly status: "ok" | "partial" | "failed";
  readonly window?: TravelWindow;
  /** Present when the search composed itineraries from one-way fares. */
  readonly discovery?: DiscoveryRecord;
  /** Which origins were queried, and which were skipped and why. */
  readonly origins?: OriginExpansion;
  readonly destinations: readonly DestinationResult[];
  readonly counts: ExplorationCounts;
  readonly providerFailures: readonly ProviderFailure[];
  readonly providerMetrics?: ProviderCallMetrics;
  /** Data-quality problems worth surfacing, never silently dropped. */
  readonly issues: readonly DomainIssue[];
}

export interface FlightExplorationDeps {
  readonly flightProvider: FlightProvider;
  readonly cities: CityRepository;
  /** Used to measure airport-to-city distance for access transfers. */
  readonly geography: AirportGeography;
  /** Resolves the requested origin and any alternatives. */
  readonly airports: AirportRepository;
}

export interface FlightExplorationOptions {
  /** Currency to search in; must match the budget's currency when one is set. */
  readonly currency: CurrencyCode;
  readonly signal?: AbortSignal;
  readonly connectionRules?: ConnectionRules;
  readonly groundTransfer?: GroundTransferConfig;
  readonly originExpansion?: OriginExpansionConfig;
  /** Injected so estimates carry a deterministic timestamp in tests. */
  readonly now?: () => Date;
}

const emptyCounts: ExplorationCounts = {
  offersReturned: 0,
  candidatesBuilt: 0,
  rejectedNotRoundTrip: 0,
  rejectedInfeasible: 0,
  rejectedInvalid: 0,
  rejectedOutsideWindow: 0,
  rejectedNights: 0,
  rejectedBudget: 0,
  rejectedGapTooFar: 0,
  rejectedReturnBeforeArrival: 0,
  destinationsWithoutReturn: 0,
  destinations: 0,
};

function failed(issues: readonly DomainIssue[]): FlightExplorationResult {
  return {
    status: "failed",
    destinations: [],
    counts: emptyCounts,
    providerFailures: [],
    issues,
  };
}

/**
 * Calls one origin costs: one per departure-month and return-month pair, which
 * is how a month-granular provider plans them. Used only for budgeting.
 */
export function callsPerOrigin(window: TravelWindow): number {
  const months = (from: string, to: string): string[] => {
    const list: string[] = [];
    let cursor = from.slice(0, 7);
    const last = to.slice(0, 7);
    while (cursor <= last && list.length <= 24) {
      list.push(cursor);
      const [year = "", month = ""] = cursor.split("-");
      cursor =
        Number(month) === 12
          ? `${String(Number(year) + 1)}-01`
          : `${year}-${String(Number(month) + 1).padStart(2, "0")}`;
    }
    return list;
  };
  const departures = months(window.departure.from, window.departure.to);
  const returns = months(window.return.from, window.return.to);
  return departures.reduce(
    (total, departure) => total + returns.filter((entry) => entry >= departure).length,
    0,
  );
}

function buildQuery(
  request: SearchRequest,
  window: TravelWindow,
  currency: CurrencyCode,
  origins: readonly string[],
): FlightSearchQuery {
  return {
    origins,
    destinations: request.destination === null ? "anywhere" : [request.destination],
    departureDates: window.departure,
    // Phase 1 searches round trips only.
    returnDates: window.return,
    travelers: request.travelers,
    currency,
  };
}

export interface CandidateAttempt {
  readonly candidate: TripCandidate;
  readonly summary: TripSummary;
  readonly nights: number;
  /** Airports the traveler visits, in order: one for a round trip, two for an open jaw. */
  readonly destinationAirports: readonly Location[];
}

export type AttemptOutcome =
  | { readonly ok: true; readonly attempt: CandidateAttempt }
  | { readonly ok: false; readonly counter: keyof ExplorationCounts; readonly issue?: DomainIssue };

export interface CandidateContext {
  readonly requestedOrigin: Location;
  readonly cities: CityRepository;
  readonly geography: AirportGeography;
  readonly connectionRules: ConnectionRules;
  readonly groundTransfer: GroundTransferConfig;
  readonly fetchedAt: ReturnType<typeof parseUtcInstant>;
}

export interface AccessTransfers {
  readonly segments: TransportSegment[];
  readonly offers: TransportOffer[];
  /** Where the traveler actually is at each end of the stay. */
  readonly arrivalInCity?: TransportSegment;
  readonly departureFromCity?: TransportSegment;
}

/**
 * Adds transfers between an airport and its city when the airport is far
 * enough away to matter (ADR 0011), so a cheap fare into a distant airport is
 * compared on the same footing as a dearer one into a close airport.
 *
 * Buffers come from the connection rules, not a fixed figure: a bus arriving
 * at a terminal must still leave the airport's check-in time (ADR 0012 §4).
 */
export function buildAccessTransfers(
  outbound: TransportSegment,
  inbound: TransportSegment,
  request: SearchRequest,
  context: CandidateContext,
): AccessTransfers {
  const airport = outbound.destination;
  const lookup = lookupCityForAirport(context.cities, airport);
  if (!lookup.ok) return { segments: [], offers: [] };

  const city = lookup.city;
  const distanceKm = context.geography.distanceBetween(airport, city);
  if (!needsAccessTransfer(distanceKm, context.groundTransfer)) {
    return { segments: [], offers: [] };
  }

  const bufferAfterArrival = requiredConnectionMinutes(airport, airport, context.connectionRules, {
    arrivingBy: outbound.mode,
    departingBy: "ground_transfer",
  });
  const bufferBeforeDeparture = requiredConnectionMinutes(
    airport,
    airport,
    context.connectionRules,
    { arrivingBy: "ground_transfer", departingBy: inbound.mode },
  );
  if (!bufferAfterArrival.ok || !bufferBeforeDeparture.ok) return { segments: [], offers: [] };

  const intoCity = buildGroundTransferLeg({
    id: `${outbound.id}:access-in`,
    from: airport,
    to: city,
    distanceKm,
    travelers: request.travelers,
    anchor: outbound.arrivalAt,
    anchorRole: "depart_after",
    bufferMinutes: bufferAfterArrival.minutes,
    fetchedAt: context.fetchedAt,
    config: context.groundTransfer,
  });
  const backToAirport = buildGroundTransferLeg({
    id: `${inbound.id}:access-out`,
    from: city,
    to: airport,
    distanceKm,
    travelers: request.travelers,
    anchor: inbound.departureAt,
    anchorRole: "arrive_before",
    bufferMinutes: bufferBeforeDeparture.minutes,
    fetchedAt: context.fetchedAt,
    config: context.groundTransfer,
  });

  return {
    segments: [intoCity.segment, backToAirport.segment],
    offers: [intoCity.offer, backToAirport.offer],
    arrivalInCity: intoCity.segment,
    departureFromCity: backToAirport.segment,
  };
}

/**
 * Connects the traveler to an alternative origin airport and back again.
 *
 * Nearby is not equivalent (ADR 0013): a fare from another airport is only
 * usable if the journey to it is part of the itinerary being judged.
 */
export function buildOriginTransfers(
  outbound: TransportSegment,
  inbound: TransportSegment,
  request: SearchRequest,
  context: CandidateContext,
): AccessTransfers {
  const requested = context.requestedOrigin;
  if (outbound.origin.id === requested.id) return { segments: [], offers: [] };

  const distanceKm = context.geography.distanceBetween(requested, outbound.origin);
  if (!Number.isFinite(distanceKm)) return { segments: [], offers: [] };

  const toAirport = requiredConnectionMinutes(
    outbound.origin,
    outbound.origin,
    context.connectionRules,
    { arrivingBy: "ground_transfer", departingBy: outbound.mode },
  );
  const fromAirport = requiredConnectionMinutes(
    inbound.destination,
    inbound.destination,
    context.connectionRules,
    { arrivingBy: inbound.mode, departingBy: "ground_transfer" },
  );
  if (!toAirport.ok || !fromAirport.ok) return { segments: [], offers: [] };

  const out = buildGroundTransferLeg({
    id: `${outbound.id}:origin-in`,
    from: requested,
    to: outbound.origin,
    distanceKm,
    travelers: request.travelers,
    anchor: outbound.departureAt,
    anchorRole: "arrive_before",
    bufferMinutes: toAirport.minutes,
    fetchedAt: context.fetchedAt,
    config: context.groundTransfer,
  });
  const back = buildGroundTransferLeg({
    id: `${inbound.id}:origin-out`,
    from: inbound.destination,
    to: requested,
    distanceKm,
    travelers: request.travelers,
    anchor: inbound.arrivalAt,
    anchorRole: "depart_after",
    bufferMinutes: fromAirport.minutes,
    fetchedAt: context.fetchedAt,
    config: context.groundTransfer,
  });

  return { segments: [out.segment, back.segment], offers: [out.offer, back.offer] };
}

/** Turns one offer into a validated, feasible, in-window, in-budget candidate. */
function buildCandidate(
  offer: TransportOffer,
  segmentsById: ReadonlyMap<string, TransportSegment>,
  request: SearchRequest,
  window: TravelWindow,
  context: CandidateContext,
): AttemptOutcome {
  const segments = offer.segmentIds.map((id) => segmentsById.get(id));
  const [outbound, inbound] = segments;
  if (outbound === undefined || inbound === undefined || segments.length !== 2) {
    // Phase 1 only builds trips from provider round-trip fares.
    return { ok: false, counter: "rejectedNotRoundTrip" };
  }

  return assembleCandidate({
    id: `trip:${offer.id}`,
    outbound,
    inbound,
    offers: [offer],
    gaps: [],
    request,
    window,
    context,
  });
}

export interface AssembleCandidateInput {
  readonly id: string;
  readonly outbound: TransportSegment;
  readonly inbound: TransportSegment;
  readonly offers: readonly TransportOffer[];
  /** Sectors the traveler arranges themselves (ADR 0014). */
  readonly gaps: readonly ItineraryGap[];
  readonly request: SearchRequest;
  readonly window: TravelWindow;
  readonly context: CandidateContext;
}

/**
 * Finishes a candidate: access transfers, feasibility, window, nights, budget.
 *
 * Shared by provider round trips and itineraries composed from one-way fares,
 * so both are judged by exactly the same rules.
 */
export function assembleCandidate(input: AssembleCandidateInput): AttemptOutcome {
  const { outbound, inbound, request, window, context } = input;
  const access = buildAccessTransfers(outbound, inbound, request, context);
  const originAccess = buildOriginTransfers(outbound, inbound, request, context);
  const allSegments = [outbound, inbound, ...access.segments, ...originAccess.segments].sort((a, b) =>
    a.departureAt.instant < b.departureAt.instant
      ? -1
      : a.departureAt.instant > b.departureAt.instant
        ? 1
        : 0,
  );
  const first = allSegments[0];
  if (first === undefined) return { ok: false, counter: "rejectedInvalid" };

  const feasibility = validateConnections(allSegments, context.connectionRules, input.gaps);
  if (!feasibility.ok) {
    return {
      ok: false,
      counter: "rejectedInfeasible",
      issue: {
        code: "INFEASIBLE_CONNECTION",
        message: feasibility.issues.map((issue) => issue.message).join("; "),
      },
    };
  }

  const candidate: TripCandidate = {
    id: input.id,
    origin: first.origin,
    travelers: request.travelers,
    segments: allSegments,
    offers: [...input.offers, ...access.offers, ...originAccess.offers],
    stays: [],
    gaps: [...input.gaps],
  };

  const summarized = summarizeTrip(candidate);
  if (!summarized.ok) {
    return {
      ok: false,
      counter: "rejectedInvalid",
      issue: {
        code: "INVALID_CANDIDATE",
        message: `${candidate.id}: ${summarized.issues.map((issue) => issue.code).join(", ")}`,
      },
    };
  }

  // The window bounds the flights the traveler asked for; nights count time in
  // the destination city, which a transfer shifts (spec §8, §9).
  const evaluation = evaluateTrip(window, {
    tripStart: localDate(outbound.departureAt),
    groundStart: localDate((access.arrivalInCity ?? outbound).arrivalAt),
    groundEnd: localDate((access.departureFromCity ?? inbound).departureAt),
    tripEnd: localDate(inbound.departureAt),
  });
  if (!evaluation.ok) {
    return {
      ok: false,
      counter: evaluation.reason === "outside_window" ? "rejectedOutsideWindow" : "rejectedNights",
    };
  }

  if (request.budget !== undefined) {
    const limit = budgetTotal(request.budget, request.travelers);
    if (limit.currency !== summarized.summary.cost.total.currency) {
      return {
        ok: false,
        counter: "rejectedInvalid",
        issue: {
          code: "BUDGET_CURRENCY_MISMATCH",
          message: `Budget is in ${limit.currency} but the fare is in ${summarized.summary.cost.total.currency}; convert explicitly before comparing`,
        },
      };
    }
    // Transport alone over budget can only get worse once accommodation is
    // added, so this filter is sound even though the cost is transport-only.
    if (compareMoney(summarized.summary.cost.total, limit) > 0) {
      return { ok: false, counter: "rejectedBudget" };
    }
  }

  return {
    ok: true,
    attempt: {
      candidate,
      summary: summarized.summary,
      nights: evaluation.nights,
      destinationAirports:
        outbound.destination.id === inbound.origin.id
          ? [outbound.destination]
          : [outbound.destination, inbound.origin],
    },
  };
}

/** 0 for a complete amount, 1 for one that excludes an unpriced sector. */
function comparisonClass(candidate: RankedCandidate): number {
  return candidate.summary.cost.exclusions.includes("unpriced_segment") ? 1 : 0;
}

/**
 * Orders candidates, completely priced ones first.
 *
 * A known cost that excludes a sector is never compared against a full total:
 * doing so would reward an itinerary for the part it leaves out (ADR 0014).
 */
export function compareCandidates(a: RankedCandidate, b: RankedCandidate): number {
  const byClass = comparisonClass(a) - comparisonClass(b);
  if (byClass !== 0) return byClass;
  const byCost = compareMoney(a.summary.cost.total, b.summary.cost.total);
  if (byCost !== 0) return byCost;
  const byTime = a.summary.travelTimeMinutes - b.summary.travelTimeMinutes;
  if (byTime !== 0) return byTime;
  return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
}

/** Groups candidates by destination city, keeping each airport identifiable. */
export function groupByDestination(
  attempts: readonly CandidateAttempt[],
  cities: CityRepository,
  issues: DomainIssue[],
): DestinationResult[] {
  interface Group {
    cities: Location[];
    airports: Location[];
    candidates: RankedCandidate[];
  }
  const groups = new Map<string, Group>();
  const reportedAirports = new Set<string>();

  for (const attempt of attempts) {
    // An open jaw visits two places; a round trip one. The destination is the
    // whole sequence, so "Vienna → Prague" is its own entry.
    const visited = attempt.destinationAirports.map((airport) => {
      const lookup = lookupCityForAirport(cities, airport);
      if (!lookup.ok && !reportedAirports.has(airport.id)) {
        reportedAirports.add(airport.id);
        issues.push(lookup.issue);
      }
      // An unresolvable city falls back to the airport; no city is invented.
      return { airport, city: lookup.ok ? lookup.city : undefined };
    });
    const key = visited.map((entry) => entry.city?.id ?? entry.airport.id).join(">");

    let group = groups.get(key);
    if (group === undefined) {
      group = { cities: [], airports: [], candidates: [] };
      groups.set(key, group);
    }
    for (const entry of visited) {
      if (entry.city !== undefined && !group.cities.some((city) => city.id === entry.city?.id)) {
        group.cities.push(entry.city);
      }
      if (!group.airports.some((airport) => airport.id === entry.airport.id)) {
        group.airports.push(entry.airport);
      }
    }
    group.candidates.push({
      candidate: attempt.candidate,
      summary: attempt.summary,
      nights: attempt.nights,
    });
  }

  const destinations = [...groups.values()].map((group) => ({
    city: group.cities[0],
    cities: group.cities,
    airports: group.airports,
    candidates: [...group.candidates].sort(compareCandidates),
  }));

  // Cheapest destination first; ties broken deterministically.
  return destinations.sort((a, b) => {
    const [first] = a.candidates;
    const [second] = b.candidates;
    if (first === undefined || second === undefined) return 0;
    const byCandidate = compareCandidates(first, second);
    if (byCandidate !== 0) return byCandidate;
    const aKey = a.city?.id ?? a.airports[0]?.id ?? "";
    const bKey = b.city?.id ?? b.airports[0]?.id ?? "";
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
}

/**
 * Runs Phase 1 exploration: query the flight provider for round trips within
 * the resolved travel window, then keep the candidates that satisfy the
 * request, counting every rejection.
 */
export async function exploreFlights(
  request: SearchRequest,
  deps: FlightExplorationDeps,
  options: FlightExplorationOptions,
): Promise<FlightExplorationResult> {
  const windowResult = resolveTravelWindow(request);
  if (!windowResult.ok) {
    return failed(windowResult.issues);
  }
  const { window } = windowResult;

  const expansion = expandOrigins({
    request,
    airports: deps.airports,
    geography: deps.geography,
    callsPerOrigin: callsPerOrigin(window),
    callBudget: deps.flightProvider.descriptor.maxCallsPerSearch ?? Number.POSITIVE_INFINITY,
    ...(options.originExpansion !== undefined && { config: options.originExpansion }),
  });
  if (expansion.origins.length === 0) {
    return { ...failed(expansion.issues), window };
  }

  const query = buildQuery(request, window, options.currency, originCodes(expansion));
  const providerResult = await deps.flightProvider.search(
    query,
    options.signal === undefined ? undefined : { signal: options.signal },
  );

  if (providerResult.status === "failed") {
    return {
      ...failed([]),
      window,
      origins: expansion,
      providerFailures: providerResult.failures,
      providerMetrics: providerResult.metrics,
    };
  }

  const requestedOrigin = expansion.origins[0]?.airport;
  if (requestedOrigin === undefined) {
    return { ...failed([]), window, origins: expansion };
  }
  const context: CandidateContext = {
    requestedOrigin,
    cities: deps.cities,
    geography: deps.geography,
    connectionRules: options.connectionRules ?? DEFAULT_CONNECTION_RULES,
    groundTransfer: options.groundTransfer ?? DEFAULT_GROUND_TRANSFER_CONFIG,
    fetchedAt: parseUtcInstant((options.now ?? (() => new Date()))().toISOString()),
  };

  const segmentsById = new Map(
    providerResult.data.segments.map((segment) => [segment.id, segment]),
  );
  const counts: Record<keyof ExplorationCounts, number> = { ...emptyCounts };
  const issues: DomainIssue[] = [];
  const attempts: CandidateAttempt[] = [];

  counts.offersReturned = providerResult.data.offers.length;
  for (const offer of providerResult.data.offers) {
    const outcome = buildCandidate(offer, segmentsById, request, window, context);
    if (!outcome.ok) {
      counts[outcome.counter] += 1;
      if (outcome.issue !== undefined) issues.push(outcome.issue);
      continue;
    }
    counts.candidatesBuilt += 1;
    attempts.push(outcome.attempt);
  }

  const destinations = groupByDestination(attempts, deps.cities, issues);
  counts.destinations = destinations.length;

  return {
    status: providerResult.status === "partial" ? "partial" : "ok",
    window,
    origins: expansion,
    destinations,
    counts,
    providerFailures: providerResult.failures,
    providerMetrics: providerResult.metrics,
    issues,
  };
}
