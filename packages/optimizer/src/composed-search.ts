import {
  parseUtcInstant,
  type DomainIssue,
  type ProviderCallMetrics,
} from "@travel-optimizer/domain";

import { composeItineraries, type CompositionConfig } from "./composition.js";
import { DEFAULT_CONNECTION_RULES } from "./connection-rules.js";
import { discoverOneWayLegs } from "./discovery.js";
import {
  groupByDestination,
  type CandidateContext,
  type ExplorationCounts,
  type FlightExplorationDeps,
  type FlightExplorationOptions,
  type FlightExplorationResult,
} from "./flight-exploration.js";
import { DEFAULT_GROUND_TRANSFER_CONFIG } from "./ground-transfer.js";
import { expandOrigins } from "./origin-expansion.js";
import { resolveTravelWindow } from "./travel-window.js";

/*
 * Composing itineraries from independently priced one-way fares.
 *
 * Wider coverage than provider round trips (51 destinations against 15,
 * measured 2026-09-18), and the only way to build an open jaw. The A -> B
 * sector of an open jaw stays an unpriced gap (ADR 0014).
 */

export interface ComposedSearchOptions extends FlightExplorationOptions {
  readonly composition?: CompositionConfig;
  readonly callBudget?: number;
  readonly maxEnrichedDestinations?: number;
}

/** Merges the composition's counters into the full set. */
function mergeCounts(
  base: ExplorationCounts,
  partial: Partial<Record<keyof ExplorationCounts, number>>,
): ExplorationCounts {
  return { ...base, ...partial };
}

export async function exploreComposedItineraries(
  request: Parameters<typeof resolveTravelWindow>[0],
  deps: FlightExplorationDeps,
  options: ComposedSearchOptions,
): Promise<FlightExplorationResult> {
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

  const windowResult = resolveTravelWindow(request);
  if (!windowResult.ok) {
    return {
      status: "failed",
      destinations: [],
      counts: emptyCounts,
      providerFailures: [],
      issues: windowResult.issues,
    };
  }
  const { window } = windowResult;

  const expansion = expandOrigins({
    request,
    airports: deps.airports,
    geography: deps.geography,
    // Stage 1 costs one call per departure month, per origin.
    callsPerOrigin: 1,
    callBudget: options.callBudget ?? deps.flightProvider.descriptor.maxCallsPerSearch ?? 12,
    ...(options.originExpansion !== undefined && { config: options.originExpansion }),
  });
  if (expansion.origins.length === 0) {
    return {
      status: "failed",
      window,
      destinations: [],
      counts: emptyCounts,
      providerFailures: [],
      issues: expansion.issues,
      origins: expansion,
    };
  }

  const discovery = await discoverOneWayLegs(deps.flightProvider, {
    window,
    currency: options.currency,
    travelers: request.travelers,
    origins: expansion.origins,
    cities: deps.cities,
    ...(options.callBudget !== undefined && { callBudget: options.callBudget }),
    ...(options.maxEnrichedDestinations !== undefined && {
      maxEnrichedDestinations: options.maxEnrichedDestinations,
    }),
    // Onward discovery is opt-in: it competes for the same budget as the ways
    // home, and every skipped query makes a search report itself as partial.
    ...(request.allowMultiCity && { multiCity: true }),
    ...(options.signal !== undefined && { signal: options.signal }),
  });

  const discoveryRecord = {
    enriched: discovery.enriched.map((entry) => ({
      airport: entry.airport,
      city: entry.city,
      via: entry.via,
      reachCostMinor: entry.reachCostMinor,
      source: entry.source,
      returnOffersFound: entry.returnOffersFound,
    })),
    onward: discovery.onward.map((entry) => ({
      airport: entry.airport,
      onwardOffersFound: entry.onwardOffersFound,
    })),
    skipped: discovery.skipped.map((entry) => ({
      stage: entry.stage,
      airport: entry.airport,
      reason: entry.reason,
    })),
    funnel: discovery.funnel,
    callsPlanned: discovery.callsPlanned,
    callBudget: discovery.callBudget,
  };

  const metrics: ProviderCallMetrics | undefined = discovery.metrics[0];
  const aggregatedMetrics =
    metrics === undefined
      ? undefined
      : {
          startedAt: metrics.startedAt,
          completedAt: discovery.metrics.at(-1)?.completedAt ?? metrics.completedAt,
          requestCount: discovery.metrics.reduce((total, entry) => total + entry.requestCount, 0),
          cache: discovery.metrics.every((entry) => entry.cache === "hit")
            ? ("hit" as const)
            : ("miss" as const),
        };

  if (discovery.status === "failed") {
    return {
      status: "failed",
      window,
      discovery: discoveryRecord,
      destinations: [],
      counts: emptyCounts,
      providerFailures: discovery.failures,
      ...(aggregatedMetrics !== undefined && { providerMetrics: aggregatedMetrics }),
      issues: [],
      origins: expansion,
    };
  }

  const requestedOrigin = expansion.origins[0]?.airport;
  if (requestedOrigin === undefined) {
    return {
      status: "failed",
      window,
      destinations: [],
      counts: emptyCounts,
      providerFailures: discovery.failures,
      issues: [],
      origins: expansion,
    };
  }

  const context: CandidateContext = {
    requestedOrigin,
    cities: deps.cities,
    geography: deps.geography,
    connectionRules: options.connectionRules ?? DEFAULT_CONNECTION_RULES,
    groundTransfer: options.groundTransfer ?? DEFAULT_GROUND_TRANSFER_CONFIG,
    fetchedAt: parseUtcInstant((options.now ?? (() => new Date()))().toISOString()),
  };

  const composed = composeItineraries({
    discovery,
    request,
    window,
    context,
    ...(options.composition !== undefined && { config: options.composition }),
  });

  const issues: DomainIssue[] = [...composed.issues];
  const destinations = groupByDestination(composed.attempts, deps.cities, issues);

  const counts = mergeCounts(emptyCounts, {
    ...composed.counts,
    offersReturned: discovery.outboundOffers.length,
    candidatesBuilt: composed.attempts.length,
    destinations: destinations.length,
    destinationsWithoutReturn: discovery.enriched.filter((entry) => entry.returnOffersFound === 0)
      .length,
  });

  // Budget-limited or partially failed searches say so rather than looking thorough.
  const status =
    discovery.failures.length > 0 || discovery.skipped.length > 0 ? "partial" : "ok";

  return {
    status,
    window,
    discovery: discoveryRecord,
    destinations,
    counts,
    providerFailures: discovery.failures,
    ...(aggregatedMetrics !== undefined && { providerMetrics: aggregatedMetrics }),
    issues,
    origins: expansion,
  };
}
