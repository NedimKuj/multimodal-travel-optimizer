import {
  budgetTotal,
  compareMoney,
  compareZonedTimestamps,
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
  deriveStayIntervals,
  initialAccommodation,
  type StayInterval,
} from "./accommodation-stays.js";
import type { SkippedQuery } from "./budget.js";
import type { DiscoveryFunnel } from "./discovery.js";
import type { ReachSource } from "./return-pool.js";
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
import {
  evaluateTrip,
  resolveTravelWindow,
  type StayRules,
  type TravelWindow,
} from "./travel-window.js";

/*
 * Flight exploration from the provider's own round-trip fares.
 *
 * Provider-agnostic: it talks to the FlightProvider port and never knows which
 * provider is behind it. Discovery here uses round-trip fares only
 * (docs/decisions/0008-phase-1-round-trip-discovery.md); composing one-way
 * fares into round trips, open jaws and multi-city trips is
 * `composed-search.ts`.
 *
 * Costs here are transport only. They are never a complete-trip cost, because
 * no accommodation provider is available (docs/implementation-plan.md, Phase 4).
 */

export interface RankedCandidate {
  readonly candidate: TripCandidate;
  readonly summary: TripSummary;
  /** Nights on the ground, summed across stays. */
  readonly nights: number;
  /** Nights per stay, in visit order; one entry for a round trip (spec §9). */
  readonly nightsByStay: readonly number[];
  /** Where this trip needs a bed, before anything has been searched. */
  readonly stayIntervals: readonly StayInterval[];
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
  /** Multi-stop trips that never stopped: a city passed through in hours. */
  readonly rejectedStayTooShort: number;
  /** Destinations reached but with no retrieved way home. */
  readonly destinationsWithoutReturn: number;
  /** Second cities an onward leg reached, as cities not airports (ADR 0010). */
  readonly secondCitiesReached: number;
  /** Second cities reached, but with no retrieved way home from them. */
  readonly secondCitiesWithoutReturn: number;
  /** Candidates built from three or more priced legs (patterns 3 and 4). */
  readonly multiCityCandidatesBuilt: number;
  readonly destinations: number;
}

export interface DiscoveryRecord {
  /** Way-home queries made, and why each candidate was chosen (ADR 0015 §7). */
  readonly enriched: readonly {
    readonly airport: Location;
    readonly city: Location | undefined;
    readonly via: readonly Location[];
    readonly reachCostMinor: number;
    readonly source: ReachSource;
    readonly returnOffersFound: number;
  }[];
  /** Destinations asked where they could go on to, and what came back. */
  readonly onward: readonly { readonly airport: Location; readonly onwardOffersFound: number }[];
  /** Queries the search chose not to make, in the shared shape (`budget.ts`). */
  readonly skipped: readonly SkippedQuery[];
  /** Where candidates went, stage by stage (`discovery.ts`). */
  readonly funnel: DiscoveryFunnel;
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
  rejectedStayTooShort: 0,
  destinationsWithoutReturn: 0,
  secondCitiesReached: 0,
  secondCitiesWithoutReturn: 0,
  multiCityCandidatesBuilt: 0,
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
    // This path searches the provider's own round-trip fares (ADR 0008);
    // composing one-way fares is `composed-search.ts`.
    returnDates: window.return,
    travelers: request.travelers,
    currency,
  };
}

export interface CandidateAttempt {
  readonly candidate: TripCandidate;
  readonly summary: TripSummary;
  readonly nights: number;
  /** Nights per stay, in visit order (spec §9). */
  readonly nightsByStay: readonly number[];
  /** Where this trip needs a bed (ADR 0016). */
  readonly stayIntervals: readonly StayInterval[];
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

/** What one junction between two legs looks like once transfers are attached. */
export interface StayBoundary {
  /** The segment whose arrival puts the traveler where they stay. */
  readonly reached: TransportSegment;
  /** The segment whose departure takes them away again. */
  readonly left: TransportSegment;
  /** Where the traveler is while they stay: the city, or the airport itself. */
  readonly place: Location;
  /** Set when the traveler makes their own way between two places (ADR 0014). */
  readonly gap?: ItineraryGap;
}

export interface AccessTransfers {
  readonly segments: TransportSegment[];
  readonly offers: TransportOffer[];
  /** One per junction between consecutive legs, in travel order. */
  readonly stays: readonly StayBoundary[];
}

/** A transfer, plus where it leaves the traveler. */
interface TransferSide {
  /** Where the traveler is once the airport is behind them. */
  readonly place: Location;
  readonly leg?: { readonly segment: TransportSegment; readonly offer: TransportOffer };
}

/**
 * Carries the traveler from the airport they land at into its city, when the
 * airport is far enough away to matter (ADR 0011).
 *
 * Buffers come from the connection rules, not a fixed figure: stepping off a
 * flight onto a bus is not the same as connecting between flights (ADR 0012 §4).
 */
function transferIntoCity(
  arriving: TransportSegment,
  request: SearchRequest,
  context: CandidateContext,
): TransferSide {
  const airport = arriving.destination;
  const lookup = lookupCityForAirport(context.cities, airport);
  if (!lookup.ok) return { place: airport };

  const city = lookup.city;
  const distanceKm = context.geography.distanceBetween(airport, city);
  if (!needsAccessTransfer(distanceKm, context.groundTransfer)) return { place: airport };

  const buffer = requiredConnectionMinutes(airport, airport, context.connectionRules, {
    arrivingBy: arriving.mode,
    departingBy: "ground_transfer",
  });
  if (!buffer.ok) return { place: airport };

  return {
    place: city,
    leg: buildGroundTransferLeg({
      id: `${arriving.id}:access-in`,
      from: airport,
      to: city,
      distanceKm,
      travelers: request.travelers,
      anchor: arriving.arrivalAt,
      anchorRole: "depart_after",
      bufferMinutes: buffer.minutes,
      fetchedAt: context.fetchedAt,
      config: context.groundTransfer,
    }),
  };
}

/** The mirror of `transferIntoCity`: back out to the airport they leave from. */
function transferToAirport(
  leaving: TransportSegment,
  request: SearchRequest,
  context: CandidateContext,
): TransferSide {
  const airport = leaving.origin;
  const lookup = lookupCityForAirport(context.cities, airport);
  if (!lookup.ok) return { place: airport };

  const city = lookup.city;
  const distanceKm = context.geography.distanceBetween(airport, city);
  if (!needsAccessTransfer(distanceKm, context.groundTransfer)) return { place: airport };

  const buffer = requiredConnectionMinutes(airport, airport, context.connectionRules, {
    arrivingBy: "ground_transfer",
    departingBy: leaving.mode,
  });
  if (!buffer.ok) return { place: airport };

  return {
    place: city,
    leg: buildGroundTransferLeg({
      id: `${leaving.id}:access-out`,
      from: city,
      to: airport,
      distanceKm,
      travelers: request.travelers,
      anchor: leaving.departureAt,
      anchorRole: "arrive_before",
      bufferMinutes: buffer.minutes,
      fetchedAt: context.fetchedAt,
      config: context.groundTransfer,
    }),
  };
}

/**
 * Attaches access transfers per stay, and derives the gaps between them.
 *
 * Each junction is handled on its own terms: the traveler lands at one airport
 * and leaves from another, which for a round trip is the same airport and for
 * an open jaw is not. Deriving both sides separately is what keeps an open jaw
 * honest — the sector the traveler arranges themselves then runs from where
 * they actually are to where they actually need to be, which is city to city
 * when both airports are far out, and asymmetric when only one is.
 */
export function buildAccessTransfers(
  legs: readonly TransportSegment[],
  request: SearchRequest,
  context: CandidateContext,
): AccessTransfers {
  const segments: TransportSegment[] = [];
  const offers: TransportOffer[] = [];
  const stays: StayBoundary[] = [];

  for (let index = 0; index + 1 < legs.length; index += 1) {
    const arriving = legs[index];
    const leaving = legs[index + 1];
    if (arriving === undefined || leaving === undefined) continue;

    const inbound = transferIntoCity(arriving, request, context);
    const outbound = transferToAirport(leaving, request, context);
    for (const side of [inbound, outbound]) {
      if (side.leg === undefined) continue;
      segments.push(side.leg.segment);
      offers.push(side.leg.offer);
    }

    const reached = inbound.leg?.segment ?? arriving;
    const left = outbound.leg?.segment ?? leaving;
    // Same airport both ways: one place, nothing to bridge. Different airports:
    // the traveler crosses between them on their own (ADR 0014).
    const continuous = reached.destination.id === left.origin.id;
    stays.push({
      reached,
      left,
      place: inbound.place,
      ...(continuous
        ? {}
        : { gap: gapBetween(reached.destination, left.origin, context.geography) }),
    });
  }

  return { segments, offers, stays };
}

/** How far an unpriced sector may stretch before a pairing stops being plausible. */
export const DEFAULT_MAX_UNPRICED_GAP_KM = 800;

/**
 * Records a sector we cannot price: both endpoints, the distance, and why.
 *
 * Never a segment and never an offer, because we know neither its times nor
 * its price, and inventing either would be a fabrication (ADR 0014 §1).
 */
function gapBetween(from: Location, to: Location, geography: AirportGeography): ItineraryGap {
  const distanceKm = geography.distanceBetween(from, to);
  return {
    id: `gap:${from.id}->${to.id}`,
    from,
    to,
    ...(Number.isFinite(distanceKm) && distanceKm > 0 ? { distanceKm } : {}),
    status: "unpriced",
    reason: "no_licensed_source",
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
): { segments: TransportSegment[]; offers: TransportOffer[] } {
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
    // This path builds trips from provider round-trip fares only.
    return { ok: false, counter: "rejectedNotRoundTrip" };
  }

  return assembleCandidate({
    id: `trip:${offer.id}`,
    legs: [outbound, inbound],
    offers: [offer],
    request,
    window,
    context,
  });
}

export interface AssembleCandidateInput {
  readonly id: string;
  /**
   * The priced legs in travel order: two for a round trip, three or more for a
   * multi-city trip.
   */
  readonly legs: readonly TransportSegment[];
  readonly offers: readonly TransportOffer[];
  readonly request: SearchRequest;
  readonly window: TravelWindow;
  readonly context: CandidateContext;
  /**
   * How far a sector the traveler arranges themselves may stretch. Derived
   * gaps beyond it are not offered at all rather than offered with a caveat.
   */
  readonly maxUnpricedGapKm?: number;
  /** Nights required in each place a multi-stop trip stops at (ADR 0015 §4). */
  readonly stayRules?: StayRules;
}

/**
 * The airports a traveler passes through between legs.
 *
 * One entry per junction for a trip that leaves from where it landed, two where
 * it does not — an open jaw's arrival and departure airports are both visited.
 */
function visitedAirports(legs: readonly TransportSegment[]): Location[] {
  const visited: Location[] = [];
  for (let index = 0; index + 1 < legs.length; index += 1) {
    const arriving = legs[index];
    const leaving = legs[index + 1];
    if (arriving === undefined || leaving === undefined) continue;
    visited.push(arriving.destination);
    if (arriving.destination.id !== leaving.origin.id) visited.push(leaving.origin);
  }
  return visited;
}

/**
 * Finishes a candidate: access transfers, feasibility, window, nights, budget.
 *
 * Shared by provider round trips and itineraries composed from one-way fares,
 * so both are judged by exactly the same rules.
 */
export function assembleCandidate(input: AssembleCandidateInput): AttemptOutcome {
  const { legs, request, window, context } = input;
  const outbound = legs[0];
  const inbound = legs.at(-1);
  if (outbound === undefined || inbound === undefined || legs.length < 2) {
    return { ok: false, counter: "rejectedInvalid" };
  }

  // Every leg must leave after the one before it lands. Assembly sorts segments
  // by instant, so an out-of-order set would otherwise sort into a spatially
  // broken chain and be rejected as a discontinuity, which explains nothing.
  for (let index = 0; index + 1 < legs.length; index += 1) {
    const arriving = legs[index];
    const leaving = legs[index + 1];
    if (arriving === undefined || leaving === undefined) continue;
    if (compareZonedTimestamps(leaving.departureAt, arriving.arrivalAt) <= 0) {
      return { ok: false, counter: "rejectedReturnBeforeArrival" };
    }
  }

  const access = buildAccessTransfers(legs, request, context);

  // The gap's endpoints depend on which transfers exist, so its distance can
  // only be judged here — and the distance judged is the one reported.
  const ceiling = input.maxUnpricedGapKm ?? DEFAULT_MAX_UNPRICED_GAP_KM;
  const gaps = access.stays.flatMap((stay) => (stay.gap === undefined ? [] : [stay.gap]));
  for (const gap of gaps) {
    if (gap.distanceKm === undefined || gap.distanceKm > ceiling) {
      return { ok: false, counter: "rejectedGapTooFar" };
    }
  }

  const originAccess = buildOriginTransfers(outbound, inbound, request, context);
  const allSegments = [...legs, ...access.segments, ...originAccess.segments].sort((a, b) =>
    a.departureAt.instant < b.departureAt.instant
      ? -1
      : a.departureAt.instant > b.departureAt.instant
        ? 1
        : 0,
  );
  const first = allSegments[0];
  if (first === undefined) return { ok: false, counter: "rejectedInvalid" };

  const feasibility = validateConnections(allSegments, context.connectionRules, gaps);
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

  // Where this trip needs a bed, and what is known about it. Nothing has been
  // searched at assembly time, so every resolvable stay starts unsearched and
  // the search stage refines it; an unresolved one is already final (ADR 0016).
  const stayIntervals = deriveStayIntervals(access.stays, context.cities);

  const candidate: TripCandidate = {
    id: input.id,
    origin: first.origin,
    travelers: request.travelers,
    segments: allSegments,
    offers: [...input.offers, ...access.offers, ...originAccess.offers],
    stays: [],
    gaps,
    accommodation: initialAccommodation(stayIntervals, "outside_shortlist"),
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

  // The window bounds the flights the traveler asked for; nights count time on
  // the ground, which a transfer shifts (spec §8, §9). Each stay runs from the
  // moment they reach the place to the moment they leave it.
  const evaluation = evaluateTrip(window, {
    tripStart: localDate(outbound.departureAt),
    tripEnd: localDate(inbound.departureAt),
    stays: access.stays.map((stay) => ({
      groundStart: localDate(stay.reached.arrivalAt),
      groundEnd: localDate(stay.left.departureAt),
    })),
  }, input.stayRules);
  if (!evaluation.ok) {
    return {
      ok: false,
      counter:
        evaluation.reason === "outside_window"
          ? "rejectedOutsideWindow"
          : evaluation.reason === "stay_too_short"
            ? "rejectedStayTooShort"
            : "rejectedNights",
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
      nightsByStay: evaluation.nightsByStay,
      stayIntervals,
      destinationAirports: visitedAirports(legs),
    },
  };
}

/**
 * Which amounts may be compared with which.
 *
 * ```text
 * 0  complete                  transport and accommodation both fully priced
 * 1  accommodation incomplete  a stay is unpriced, unresolved or not searched
 * 2  unpriced transport sector a leg of the journey has no price
 * ```
 *
 * `not_searched` and `unpriced` share class 1 because in neither case do we
 * hold the price; their states and reasons carry the difference (ADR 0016 §8).
 */
export function comparisonClass(candidate: RankedCandidate): number {
  const { exclusions } = candidate.summary.cost;
  if (exclusions.includes("unpriced_segment")) return 2;
  if (
    exclusions.includes("accommodation") ||
    exclusions.includes("unresolved_accommodation")
  ) {
    return 1;
  }
  return 0;
}

/**
 * Orders candidates, completely priced ones first.
 *
 * A cheaper known cost never outranks a fuller one: doing so would reward an
 * itinerary for what it leaves out (ADR 0014, ADR 0016 §8). Missing
 * accommodation is never zero, never estimated and never a penalty — it simply
 * puts the candidate in a class of its own, and `cost.total` already sums
 * priced components only.
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
      nightsByStay: attempt.nightsByStay,
      stayIntervals: attempt.stayIntervals,
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
 * Explores the provider's round-trip fares: query them within
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
