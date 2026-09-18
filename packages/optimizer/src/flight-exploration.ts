import {
  budgetTotal,
  compareMoney,
  localDate,
  lookupCityForAirport,
  parseUtcInstant,
  summarizeTrip,
  type AirportGeography,
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
  /** The destination city, when the reference data resolves one. */
  readonly city: Location | undefined;
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
  readonly destinations: number;
}

export interface FlightExplorationResult {
  readonly status: "ok" | "partial" | "failed";
  readonly window?: TravelWindow;
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
}

export interface FlightExplorationOptions {
  /** Currency to search in; must match the budget's currency when one is set. */
  readonly currency: CurrencyCode;
  readonly signal?: AbortSignal;
  readonly connectionRules?: ConnectionRules;
  readonly groundTransfer?: GroundTransferConfig;
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

function buildQuery(
  request: SearchRequest,
  window: TravelWindow,
  currency: CurrencyCode,
): FlightSearchQuery {
  return {
    origins: [request.origin],
    destinations: request.destination === null ? "anywhere" : [request.destination],
    departureDates: window.departure,
    // Phase 1 searches round trips only.
    returnDates: window.return,
    travelers: request.travelers,
    currency,
  };
}

interface CandidateAttempt {
  readonly candidate: TripCandidate;
  readonly summary: TripSummary;
  readonly nights: number;
  readonly destinationAirport: Location;
}

type AttemptOutcome =
  | { readonly ok: true; readonly attempt: CandidateAttempt }
  | { readonly ok: false; readonly counter: keyof ExplorationCounts; readonly issue?: DomainIssue };

interface CandidateContext {
  readonly cities: CityRepository;
  readonly geography: AirportGeography;
  readonly connectionRules: ConnectionRules;
  readonly groundTransfer: GroundTransferConfig;
  readonly fetchedAt: ReturnType<typeof parseUtcInstant>;
}

interface AccessTransfers {
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
function buildAccessTransfers(
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

  const access = buildAccessTransfers(outbound, inbound, request, context);
  const allSegments = [outbound, inbound, ...access.segments].sort((a, b) =>
    a.departureAt.instant < b.departureAt.instant
      ? -1
      : a.departureAt.instant > b.departureAt.instant
        ? 1
        : 0,
  );
  const first = allSegments[0];
  if (first === undefined) return { ok: false, counter: "rejectedInvalid" };

  const feasibility = validateConnections(allSegments, context.connectionRules);
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
    id: `trip:${offer.id}`,
    origin: first.origin,
    travelers: request.travelers,
    segments: allSegments,
    offers: [offer, ...access.offers],
    stays: [],
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
      destinationAirport: outbound.destination,
    },
  };
}

function compareCandidates(a: RankedCandidate, b: RankedCandidate): number {
  const byCost = compareMoney(a.summary.cost.total, b.summary.cost.total);
  if (byCost !== 0) return byCost;
  const byTime = a.summary.travelTimeMinutes - b.summary.travelTimeMinutes;
  if (byTime !== 0) return byTime;
  return a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0;
}

/** Groups candidates by destination city, keeping each airport identifiable. */
function groupByDestination(
  attempts: readonly CandidateAttempt[],
  cities: CityRepository,
  issues: DomainIssue[],
): DestinationResult[] {
  interface Group {
    city: Location | undefined;
    airports: Location[];
    candidates: RankedCandidate[];
  }
  const groups = new Map<string, Group>();
  const reportedAirports = new Set<string>();

  for (const attempt of attempts) {
    const lookup = lookupCityForAirport(cities, attempt.destinationAirport);
    if (!lookup.ok && !reportedAirports.has(attempt.destinationAirport.id)) {
      reportedAirports.add(attempt.destinationAirport.id);
      issues.push(lookup.issue);
    }
    // An unresolvable city falls back to the airport as its own destination;
    // no city is invented.
    const city = lookup.ok ? lookup.city : undefined;
    const key = city?.id ?? attempt.destinationAirport.id;

    let group = groups.get(key);
    if (group === undefined) {
      group = { city, airports: [], candidates: [] };
      groups.set(key, group);
    }
    if (!group.airports.some((airport) => airport.id === attempt.destinationAirport.id)) {
      group.airports.push(attempt.destinationAirport);
    }
    group.candidates.push({
      candidate: attempt.candidate,
      summary: attempt.summary,
      nights: attempt.nights,
    });
  }

  const destinations = [...groups.values()].map((group) => ({
    city: group.city,
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

  const query = buildQuery(request, window, options.currency);
  const providerResult = await deps.flightProvider.search(
    query,
    options.signal === undefined ? undefined : { signal: options.signal },
  );

  if (providerResult.status === "failed") {
    return {
      ...failed([]),
      window,
      providerFailures: providerResult.failures,
      providerMetrics: providerResult.metrics,
    };
  }

  const context: CandidateContext = {
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
    destinations,
    counts,
    providerFailures: providerResult.failures,
    providerMetrics: providerResult.metrics,
    issues,
  };
}
