import { createHash, randomUUID } from "node:crypto";

import {
  parseUtcInstant,
  type CurrencyCode,
  type DomainIssue,
  type ProviderCallMetrics,
  type ProviderDescriptor,
  type ProviderFailure,
  type SearchRequest,
  type UtcInstant,
} from "@travel-optimizer/domain";

import { priceDestinations } from "./accommodation-search.js";
import type { Shortlist } from "./accommodation-shortlist.js";
import { createAccommodationBudget, type AccommodationSearchBudget } from "./budget.js";
import { exploreComposedItineraries } from "./composed-search.js";
import {
  exploreFlights,
  type DestinationResult,
  type DiscoveryRecord,
  type ExplorationCounts,
  type FlightExplorationDeps,
} from "./flight-exploration.js";
import type { OriginExpansionRecord } from "./origin-expansion.js";
import type { AccommodationProvider } from "@travel-optimizer/domain";
import type { TravelWindow } from "./travel-window.js";

/*
 * Reproducibility record for a search (AGENTS.md rule 15).
 *
 * Every search carries an id, the normalized request it ran, the optimizer
 * version, provider information, timings and the counts behind its results, so
 * a result set can be explained and a run can be compared with another.
 */

/** Bumped when a change alters which results a given request produces. */
export const OPTIMIZER_VERSION = "0.1.0-phase1";

/** Stages from docs/optimizer-spec.md §26. Only stages actually run are recorded. */
export type SearchStage =
  | "destinations"
  | "flights"
  | "ground_transport"
  | "open_jaw"
  | "accommodation"
  | "optimization"
  | "complete";

export interface SearchStageRecord {
  readonly stage: SearchStage;
  readonly startedAt: UtcInstant;
  readonly completedAt: UtcInstant;
}

export interface SearchProviderRecord {
  readonly descriptor: ProviderDescriptor;
  readonly status: "ok" | "partial" | "failed";
  readonly failures: readonly ProviderFailure[];
  readonly metrics?: ProviderCallMetrics;
}

export interface SearchTrace {
  readonly searchId: string;
  /**
   * Stable hash of the normalized request, currency and optimizer version.
   * Identical requests share a fingerprint, which is what deduplication and
   * caching key on; `searchId` stays unique per execution.
   */
  readonly fingerprint: string;
  readonly optimizerVersion: string;
  readonly status: "ok" | "partial" | "failed";
  readonly strategy: SearchStrategy;
  readonly request: SearchRequest;
  readonly currency: CurrencyCode;
  readonly window?: TravelWindow;
  /** Present when the search composed itineraries from one-way fares. */
  readonly discovery?: DiscoveryRecord;
  /** Origins queried and alternatives skipped, with reasons (ADR 0013). */
  readonly origins?: OriginExpansionRecord;
  readonly startedAt: UtcInstant;
  readonly completedAt: UtcInstant;
  readonly stages: readonly SearchStageRecord[];
  readonly provider: SearchProviderRecord;
  readonly counts: ExplorationCounts;
  readonly destinations: readonly DestinationResult[];
  /** How accommodation was priced, when the search got that far (ADR 0016). */
  readonly accommodation?: AccommodationRecord;
  readonly issues: readonly DomainIssue[];
}

export interface AccommodationRecord {
  /** Absent means no provider was configured, not that none was needed. */
  readonly providerId: string | undefined;
  readonly shortlisted: number;
  readonly patterns: readonly string[];
  readonly queriesPlanned: number;
  readonly queriesMade: number;
  readonly budget: AccommodationSearchBudget;
  readonly failures: readonly ProviderFailure[];
}

/** Canonical JSON: object keys sorted, so equal requests hash equally. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function searchFingerprint(
  request: SearchRequest,
  currency: CurrencyCode,
  optimizerVersion: string = OPTIMIZER_VERSION,
  /** Different strategies answer the same request differently. */
  strategy: SearchStrategy = "provider_round_trips",
): string {
  const canonical = JSON.stringify(
    canonicalize({ request, currency, optimizerVersion, strategy }),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * How candidates are discovered.
 *
 * `provider_round_trips` uses the provider's own round-trip fares: fewer calls,
 * always complete, but narrower (ADR 0008). `composed` builds itineraries from
 * one-way fares: far more destinations, and the only way to reach an open jaw.
 */
export type SearchStrategy = "provider_round_trips" | "composed";

export interface RunSearchOptions {
  readonly currency: CurrencyCode;
  /** Defaults to `composed` when the request allows an open jaw. */
  readonly strategy?: SearchStrategy;
  readonly signal?: AbortSignal;
  /** Injected for reproducible tests. */
  readonly now?: () => Date;
  readonly newSearchId?: () => string;
  readonly optimizerVersion?: string;
  /**
   * Accommodation is priced only when a provider is configured. None exists
   * today, so every stay reports `not_searched / no_provider` — a true fact
   * about the trip, not a stand-in for a price (ADR 0016).
   */
  readonly accommodationProvider?: AccommodationProvider;
  /** Accommodation's own budget, independent of the transport calls. */
  readonly accommodationCalls?: number;
  /** How many candidates may be priced. */
  readonly accommodationShortlist?: number;
}

/**
 * Runs a search and wraps it in a trace.
 *
 * Stages listed are the ones this phase actually performs; ground transport,
 * open jaw and accommodation are absent rather than reported as empty.
 */
export async function runFlightSearch(
  request: SearchRequest,
  deps: FlightExplorationDeps,
  options: RunSearchOptions,
): Promise<SearchTrace> {
  const {
    currency,
    now = () => new Date(),
    newSearchId = () => randomUUID(),
    optimizerVersion = OPTIMIZER_VERSION,
  } = options;

  const startedAt = parseUtcInstant(now().toISOString());
  // Open jaw needs one-way fares, so it implies composition; composition is
  // also useful on its own, for the destinations round-trip fares never reach.
  const strategy: SearchStrategy =
    options.strategy ?? (request.allowOpenJaw ? "composed" : "provider_round_trips");
  const exploration =
    strategy === "composed"
    ? await exploreComposedItineraries(request, deps, {
        currency,
        ...(options.signal !== undefined && { signal: options.signal }),
        ...(options.now !== undefined && { now: options.now }),
      })
    : await exploreFlights(request, deps, {
        currency,
        ...(options.signal !== undefined && { signal: options.signal }),
        ...(options.now !== undefined && { now: options.now }),
      });
  const flightsCompletedAt = parseUtcInstant(now().toISOString());

  const accommodationBudget = createAccommodationBudget(options.accommodationCalls ?? 0);
  const priced = await priceDestinations(exploration.destinations, {
    request,
    shortlistLimit: options.accommodationShortlist ?? DEFAULT_ACCOMMODATION_SHORTLIST,
    budget: accommodationBudget,
    travelers: request.travelers,
    currency,
    ...(options.accommodationProvider !== undefined && {
      provider: options.accommodationProvider,
    }),
    ...(options.signal !== undefined && { signal: options.signal }),
  });
  const accommodationCompletedAt = parseUtcInstant(now().toISOString());
  const completedAt = parseUtcInstant(now().toISOString());

  const stages: SearchStageRecord[] = [
    { stage: "flights", startedAt, completedAt: flightsCompletedAt },
    { stage: "accommodation", startedAt: flightsCompletedAt, completedAt: accommodationCompletedAt },
    { stage: "optimization", startedAt: accommodationCompletedAt, completedAt },
    { stage: "complete", startedAt: completedAt, completedAt },
  ];

  return {
    searchId: newSearchId(),
    fingerprint: searchFingerprint(request, currency, optimizerVersion, strategy),
    optimizerVersion,
    status: exploration.status,
    strategy,
    request,
    currency,
    ...(exploration.window !== undefined && { window: exploration.window }),
    ...(exploration.discovery !== undefined && { discovery: exploration.discovery }),
    ...(exploration.origins !== undefined && { origins: exploration.origins }),
    startedAt,
    completedAt,
    stages,
    provider: {
      descriptor: deps.flightProvider.descriptor,
      status: exploration.status,
      failures: exploration.providerFailures,
      ...(exploration.providerMetrics !== undefined && { metrics: exploration.providerMetrics }),
    },
    counts: exploration.counts,
    destinations: priced.destinations,
    accommodation: accommodationRecord(priced, options.accommodationProvider, accommodationBudget),
    issues: [...exploration.issues, ...priced.issues],
  };
}

/** Candidates priced when no limit is given. */
export const DEFAULT_ACCOMMODATION_SHORTLIST = 10;

function accommodationRecord(
  priced: { readonly shortlist: Shortlist; readonly search: { readonly queriesPlanned: number; readonly queriesMade: number; readonly failures: readonly ProviderFailure[] } },
  provider: AccommodationProvider | undefined,
  budget: AccommodationSearchBudget,
): AccommodationRecord {
  return {
    providerId: provider?.descriptor.id,
    shortlisted: priced.shortlist.selected.length,
    patterns: priced.shortlist.patterns,
    queriesPlanned: priced.search.queriesPlanned,
    queriesMade: priced.search.queriesMade,
    budget,
    failures: priced.search.failures,
  };
}
