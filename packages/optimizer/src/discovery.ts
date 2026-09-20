import {
  lookupCityForAirport,
  type CityRepository,
  type CurrencyCode,
  type FlightProvider,
  type Location,
  type ProviderCallMetrics,
  type ProviderFailure,
  type TransportOffer,
  type TransportSegment,
} from "@travel-optimizer/domain";

import {
  canAfford,
  costOfQuery,
  createSearchBudget,
  DEFAULT_CALL_BUDGET,
  GUARANTEED_RETURN_QUERIES,
  recordSkip,
  spend,
  type SkippedQuery,
} from "./budget.js";
import { legsFrom, MAX_OFFERS_PER_AIRPORT, oneWayLegs } from "./one-way-legs.js";
import type { SelectedOrigin } from "./origin-expansion.js";
import {
  createReturnPool,
  type ReachSource,
  type ReturnCandidate,
} from "./return-pool.js";
import type { TravelWindow } from "./travel-window.js";

/*
 * Staged one-way discovery (docs/implementation-plan.md §48).
 *
 * Stage 1 asks one broad question: where can we fly from here? Stage 2 finds
 * ways home. Stage 3, for multi-city, asks the same broad question again from
 * each destination: where can we go on to?
 *
 * Stages 2 and 3 feed each other. A second city stage 3 reaches becomes a
 * candidate for a way home in its own right, ranked against the stage-1
 * destinations by what it is already known to cost to get there
 * (`return-pool.ts`, ADR 0015 §7). Candidates are chosen deterministically
 * rather than by whatever order the provider answered in.
 *
 * The call budget is an application-level safety limit shared by every optional
 * dimension of a search. It is not a claim about the provider's own quota,
 * which is unverified (docs/provider-compliance.md).
 */

/** What a way-home query was spent on, and why it was chosen. */
export interface EnrichmentRecord {
  readonly airport: Location;
  /** The city it serves, when the reference data resolves one (ADR 0010). */
  readonly city: Location | undefined;
  /** Airports passed through to get here, home excluded. */
  readonly via: readonly Location[];
  /** Fares already known to reach it, in minor units; never a prediction. */
  readonly reachCostMinor: number;
  readonly source: ReachSource;
  readonly returnOffersFound: number;
}

/** A candidate a query was not spent on, in the shared shape (`budget.ts`). */
export interface SkippedDestination extends SkippedQuery {
  readonly city: Location | undefined;
  readonly via: readonly Location[];
  readonly reachCostMinor: number;
  readonly source: ReachSource;
}

/** A destination asked where it could go on to next (stage 3). */
export interface OnwardRecord {
  readonly airport: Location;
  readonly onwardOffersFound: number;
}

/**
 * Where a search's candidates went, stage by stage (spec §25).
 *
 * Every place is counted once and in one place. A candidate is discovered,
 * then admitted or capped, then queried or skipped, and a query either finds
 * fares or does not — so a thin result can be traced to the step that thinned
 * it rather than guessed at.
 */
export interface DiscoveryFunnel {
  /** Destinations stage 1 found a fare to. */
  readonly destinationsDiscovered: number;
  /** Of those, the ones inside the shortlist cap and so eligible for a query. */
  readonly destinationsAdmitted: number;
  /** Onward queries actually made, each from one admitted destination. */
  readonly onwardQueriesExecuted: number;
  /** Airports onward legs reached, before the cheapest-per-airport cap. */
  readonly secondCityAirportsDiscovered: number;
  /** Of those, the ones admitted to the return pool (ADR 0015 §7). */
  readonly secondCityAirportsAdmitted: number;
  /** Way-home queries made, split by how the place was found. */
  readonly returnQueriesFromStageOne: number;
  readonly returnQueriesFromSecondCity: number;
  /** Of those, the ones that came back with at least one fare. */
  readonly returnFaresFoundFromStageOne: number;
  readonly returnFaresFoundFromSecondCity: number;
}

const EMPTY_FUNNEL: DiscoveryFunnel = {
  destinationsDiscovered: 0,
  destinationsAdmitted: 0,
  onwardQueriesExecuted: 0,
  secondCityAirportsDiscovered: 0,
  secondCityAirportsAdmitted: 0,
  returnQueriesFromStageOne: 0,
  returnQueriesFromSecondCity: 0,
  returnFaresFoundFromStageOne: 0,
  returnFaresFoundFromSecondCity: 0,
};

export interface DiscoveryResult {
  readonly outboundSegments: readonly TransportSegment[];
  readonly outboundOffers: readonly TransportOffer[];
  /** Return legs keyed by the destination airport they depart from. */
  readonly returnsByAirport: ReadonlyMap<
    string,
    { readonly segments: readonly TransportSegment[]; readonly offers: readonly TransportOffer[] }
  >;
  /** Onward legs keyed by the destination airport they depart from. */
  readonly onwardByAirport: ReadonlyMap<
    string,
    { readonly segments: readonly TransportSegment[]; readonly offers: readonly TransportOffer[] }
  >;
  readonly enriched: readonly EnrichmentRecord[];
  readonly onward: readonly OnwardRecord[];
  readonly skipped: readonly SkippedDestination[];
  readonly funnel: DiscoveryFunnel;
  readonly failures: readonly ProviderFailure[];
  readonly metrics: readonly ProviderCallMetrics[];
  /** Provider calls this search planned, against the budget. */
  readonly callsPlanned: number;
  readonly callBudget: number;
  readonly status: "ok" | "partial" | "failed";
}

export interface DiscoveryOptions {
  readonly window: TravelWindow;
  readonly currency: CurrencyCode;
  readonly travelers: number;
  readonly origins: readonly SelectedOrigin[];
  /** Resolves the city behind an airport, for grouping and presentation. */
  readonly cities: CityRepository;
  readonly callBudget?: number;
  /** Cap on destinations enriched, before the budget is even considered. */
  readonly maxEnrichedDestinations?: number;
  /**
   * Ask each destination where it can go on to next. Off unless multi-city was
   * requested: every onward query competes for the same budget as a way home,
   * and a search that skips queries reports itself as partial.
   */
  readonly multiCity?: boolean;
  /** Overrides the guaranteed return-leg floor; for tests and tuning. */
  readonly guaranteedReturnQueries?: number;
  /**
   * Onward legs per airport admitted to the return pool. Must match what
   * composition pairs, or a call is spent on a leg that is then pruned.
   */
  readonly maxOnwardLegsPerAirport?: number;
  readonly signal?: AbortSignal;
}

interface Candidate {
  readonly airport: Location;
  readonly cheapestOutboundMinor: number;
}

/** Cheapest outbound fare first, then IATA: a total order, so runs repeat. */
function rankDestinations(
  segments: readonly TransportSegment[],
  offers: readonly TransportOffer[],
): Candidate[] {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const cheapest = new Map<string, Candidate>();

  for (const offer of offers) {
    const [segmentId] = offer.segmentIds;
    if (segmentId === undefined || offer.segmentIds.length !== 1) continue;
    const segment = byId.get(segmentId);
    if (segment === undefined) continue;
    const airport = segment.destination;
    const current = cheapest.get(airport.id);
    if (current === undefined || offer.price.amountMinor < current.cheapestOutboundMinor) {
      cheapest.set(airport.id, { airport, cheapestOutboundMinor: offer.price.amountMinor });
    }
  }

  return [...cheapest.values()].sort(
    (a, b) =>
      a.cheapestOutboundMinor - b.cheapestOutboundMinor ||
      (a.airport.iata ?? a.airport.id).localeCompare(b.airport.iata ?? b.airport.id),
  );
}

/**
 * Runs the funnel: one outbound discovery call, then ways home and onward legs
 * for as many destinations as the remaining budget allows.
 */
export async function discoverOneWayLegs(
  provider: FlightProvider,
  options: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const callBudget =
    options.callBudget ?? provider.descriptor.maxCallsPerSearch ?? DEFAULT_CALL_BUDGET;
  const budget = createSearchBudget(callBudget);
  const failures: ProviderFailure[] = [];
  const metrics: ProviderCallMetrics[] = [];
  const originCodes = options.origins.map((origin) => origin.airport.iata ?? origin.airport.id);
  const [primary] = options.origins;

  // Stage 1 asks every origin the same broad question, so it costs a call per
  // departure month per origin.
  const outboundCost = costOfQuery(options.window.departure) * originCodes.length;
  spend(budget, outboundCost);
  const outbound = await provider.search(
    {
      origins: originCodes,
      destinations: "anywhere",
      departureDates: options.window.departure,
      travelers: options.travelers,
      currency: options.currency,
    },
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  metrics.push(outbound.metrics);
  failures.push(...outbound.failures);

  if (outbound.status === "failed" || primary === undefined) {
    return {
      outboundSegments: [],
      outboundOffers: [],
      returnsByAirport: new Map(),
      onwardByAirport: new Map(),
      enriched: [],
      onward: [],
      skipped: [],
      funnel: EMPTY_FUNNEL,
      failures,
      metrics,
      callsPlanned: budget.usedProviderCalls,
      callBudget,
      status: "failed",
    };
  }

  const ranked = rankDestinations(outbound.data.segments, outbound.data.offers);
  const shortlist = ranked.slice(0, options.maxEnrichedDestinations ?? ranked.length);

  const returnsByAirport = new Map<
    string,
    { segments: readonly TransportSegment[]; offers: readonly TransportOffer[] }
  >();
  const onwardByAirport = new Map<
    string,
    { segments: readonly TransportSegment[]; offers: readonly TransportOffer[] }
  >();
  const enriched: EnrichmentRecord[] = [];
  const onward: OnwardRecord[] = [];
  const skipped: SkippedDestination[] = [];
  const pool = createReturnPool();
  // Airports onward legs reached, and the subset that entered the pool. Sets,
  // so an airport two onward queries both reach is still one airport.
  const secondCityAirportsSeen = new Set<string>();
  const secondCityAirportsAdmitted = new Set<string>();

  const returnCallCost = costOfQuery(options.window.return);
  // An onward leg may depart any time the traveler is away, so it is priced
  // against the whole window rather than the return range alone.
  const onwardCallCost = costOfQuery(options.window.outerBounds);
  const homeCode = primary.airport.iata ?? primary.airport.id;

  const maxOnwardLegs = options.maxOnwardLegsPerAirport ?? MAX_OFFERS_PER_AIRPORT;
  const cityFor = (airport: Location): Location | undefined => {
    const lookup = lookupCityForAirport(options.cities, airport);
    return lookup.ok ? lookup.city : undefined;
  };

  /** A stage-1 destination, as a candidate for a way home. */
  const directCandidate = (candidate: Candidate): ReturnCandidate => ({
    airport: candidate.airport,
    city: cityFor(candidate.airport),
    path: {
      via: [candidate.airport],
      reachCostMinor: candidate.cheapestOutboundMinor,
      source: "stage_1",
    },
  });

  const skip = (
    candidate: ReturnCandidate,
    stage: "return" | "onward",
    reason: SkippedQuery["reason"],
  ): void => {
    const record = {
      stage,
      airport: candidate.airport,
      city: candidate.city,
      via: candidate.path.via,
      reachCostMinor: candidate.path.reachCostMinor,
      source: candidate.path.source,
      reason,
    };
    skipped.push(record);
    recordSkip(budget, record);
  };

  /** Asks how to get home from one place an itinerary could end. */
  const queryReturn = async (candidate: ReturnCandidate): Promise<void> => {
    const code = candidate.airport.iata ?? candidate.airport.id;
    spend(budget, returnCallCost);
    const back = await provider.search(
      {
        origins: [code],
        destinations: [homeCode],
        departureDates: options.window.return,
        travelers: options.travelers,
        currency: options.currency,
      },
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    metrics.push(back.metrics);
    failures.push(...back.failures);

    const record = {
      airport: candidate.airport,
      city: candidate.city,
      via: candidate.path.via,
      reachCostMinor: candidate.path.reachCostMinor,
      source: candidate.path.source,
    };
    if (back.status === "failed") {
      enriched.push({ ...record, returnOffersFound: 0 });
      return;
    }
    returnsByAirport.set(candidate.airport.id, {
      segments: back.data.segments,
      offers: back.data.offers,
    });
    enriched.push({ ...record, returnOffersFound: back.data.offers.length });
  };

  /** Asks where a destination can be travelled on to (stage 3). */
  const queryOnward = async (candidate: ReturnCandidate): Promise<void> => {
    const code = candidate.airport.iata ?? candidate.airport.id;
    spend(budget, onwardCallCost);
    const on = await provider.search(
      {
        origins: [code],
        destinations: "anywhere",
        departureDates: options.window.outerBounds,
        travelers: options.travelers,
        currency: options.currency,
      },
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    metrics.push(on.metrics);
    failures.push(...on.failures);

    if (on.status === "failed") {
      onward.push({ airport: candidate.airport, onwardOffersFound: 0 });
      return;
    }
    onwardByAirport.set(candidate.airport.id, {
      segments: on.data.segments,
      offers: on.data.offers,
    });
    onward.push({ airport: candidate.airport, onwardOffersFound: on.data.offers.length });

    // Every second city reached becomes a candidate for a way home of its own,
    // ranked against the stage-1 destinations by what it is already known to
    // cost to get there. Only the legs composition will actually pair are
    // admitted, so a call is never spent on one it would prune (ADR 0015 §7).
    const reached = oneWayLegs(on.data.segments, on.data.offers).filter(
      (leg) => leg.segment.origin.id === candidate.airport.id,
    );
    for (const leg of reached) secondCityAirportsSeen.add(leg.segment.destination.id);

    for (const leg of legsFrom(reached, candidate.airport.id, maxOnwardLegs)) {
      const second = leg.segment.destination;
      secondCityAirportsAdmitted.add(second.id);
      pool.offer({
        airport: second,
        city: cityFor(second),
        path: {
          via: [...candidate.path.via, second],
          reachCostMinor: candidate.path.reachCostMinor + leg.offer.price.amountMinor,
          source: "onward",
        },
      });
    }
  };

  // Stages 2 and 3 share what stage 1 left (ADR 0015). Ways home are
  // guaranteed a floor, then the two stages alternate, which adapts to how many
  // candidates each actually has in a way a fixed proportion would not.
  //
  // Only where the return candidates come from has changed: a growing pool fed
  // by both stages, rather than stage 1 alone (ADR 0015 §7).
  const stageOne = shortlist.map(directCandidate);
  for (const candidate of stageOne) pool.offer(candidate);
  // Onward discovery starts only from stage-1 destinations, which fixes the
  // depth of a trip at SJJ -> A -> B -> SJJ rather than opening a traversal.
  const onwardQueue = options.multiCity === true ? [...stageOne] : [];

  let guaranteed = Math.min(
    options.guaranteedReturnQueries ?? GUARANTEED_RETURN_QUERIES,
    pool.size(),
  );
  while (guaranteed > 0) {
    // No onward query has run yet, so the pool holds stage-1 destinations only
    // and the floor lands exactly where it always has.
    const candidate = pool.take();
    if (candidate === undefined) break;
    guaranteed -= 1;
    // The floor is hard against onward discovery, never against the budget.
    if (!canAfford(budget, returnCallCost)) {
      skip(candidate, "return", "call_budget");
      continue;
    }
    await queryReturn(candidate);
  }

  // After the floor: return, onward, return, onward, while anything fits. An
  // onward query refills the pool, so a return turn that found nothing this
  // round may well find something the next: the loop ends when a whole round
  // runs nothing, not when the pool happens to be empty.
  type Stage = "return" | "onward";
  let next: Stage = "return";
  for (;;) {
    const order: readonly Stage[] =
      next === "return" ? ["return", "onward"] : ["onward", "return"];
    let ran = false;
    for (const stage of order) {
      const cost = stage === "return" ? returnCallCost : onwardCallCost;
      const head = stage === "return" ? pool.peek() : onwardQueue[0];
      if (head === undefined || !canAfford(budget, cost)) continue;
      if (stage === "return") {
        pool.take();
        await queryReturn(head);
      } else {
        onwardQueue.shift();
        await queryOnward(head);
      }
      next = stage === "return" ? "onward" : "return";
      ran = true;
      break;
    }
    if (!ran) break;
  }

  // Whatever neither stage could reach is recorded, never dropped quietly.
  for (const candidate of pool.remaining()) skip(candidate, "return", "call_budget");
  for (const candidate of onwardQueue) skip(candidate, "onward", "call_budget");

  // Destinations past the enrichment cap were never candidates for a call: a
  // limit of ours stopped them, not the budget. One may since have been reached
  // by an onward leg and entered the pool on its own merits, and the pool has
  // already accounted for it — reporting it capped as well would contradict
  // the query it was actually given.
  for (const candidate of ranked.slice(shortlist.length)) {
    if (pool.knows(candidate.airport.id)) continue;
    skip(directCandidate(candidate), "return", "cap");
  }

  const queriedFrom = (source: ReachSource): EnrichmentRecord[] =>
    enriched.filter((entry) => entry.source === source);
  const funnel: DiscoveryFunnel = {
    destinationsDiscovered: ranked.length,
    destinationsAdmitted: shortlist.length,
    onwardQueriesExecuted: onward.length,
    secondCityAirportsDiscovered: secondCityAirportsSeen.size,
    secondCityAirportsAdmitted: secondCityAirportsAdmitted.size,
    returnQueriesFromStageOne: queriedFrom("stage_1").length,
    returnQueriesFromSecondCity: queriedFrom("onward").length,
    returnFaresFoundFromStageOne: queriedFrom("stage_1").filter(
      (entry) => entry.returnOffersFound > 0,
    ).length,
    returnFaresFoundFromSecondCity: queriedFrom("onward").filter(
      (entry) => entry.returnOffersFound > 0,
    ).length,
  };

  return {
    outboundSegments: outbound.data.segments,
    outboundOffers: outbound.data.offers,
    returnsByAirport,
    onwardByAirport,
    enriched,
    onward,
    skipped,
    funnel,
    failures,
    metrics,
    callsPlanned: budget.usedProviderCalls,
    callBudget,
    status: failures.length > 0 ? "partial" : "ok",
  };
}
