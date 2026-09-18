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

import {
  exploreFlights,
  type DestinationResult,
  type ExplorationCounts,
  type FlightExplorationDeps,
} from "./flight-exploration.js";
import type { OriginExpansionRecord } from "./origin-expansion.js";
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
  readonly request: SearchRequest;
  readonly currency: CurrencyCode;
  readonly window?: TravelWindow;
  /** Origins queried and alternatives skipped, with reasons (ADR 0013). */
  readonly origins?: OriginExpansionRecord;
  readonly startedAt: UtcInstant;
  readonly completedAt: UtcInstant;
  readonly stages: readonly SearchStageRecord[];
  readonly provider: SearchProviderRecord;
  readonly counts: ExplorationCounts;
  readonly destinations: readonly DestinationResult[];
  readonly issues: readonly DomainIssue[];
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
): string {
  const canonical = JSON.stringify(canonicalize({ request, currency, optimizerVersion }));
  return createHash("sha256").update(canonical).digest("hex");
}

export interface RunSearchOptions {
  readonly currency: CurrencyCode;
  readonly signal?: AbortSignal;
  /** Injected for reproducible tests. */
  readonly now?: () => Date;
  readonly newSearchId?: () => string;
  readonly optimizerVersion?: string;
}

/**
 * Runs Phase 1 exploration and wraps it in a trace.
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
  const exploration = await exploreFlights(request, deps, {
    currency,
    ...(options.signal !== undefined && { signal: options.signal }),
  });
  const flightsCompletedAt = parseUtcInstant(now().toISOString());
  const completedAt = parseUtcInstant(now().toISOString());

  const stages: SearchStageRecord[] = [
    { stage: "flights", startedAt, completedAt: flightsCompletedAt },
    { stage: "optimization", startedAt: flightsCompletedAt, completedAt },
    { stage: "complete", startedAt: completedAt, completedAt },
  ];

  return {
    searchId: newSearchId(),
    fingerprint: searchFingerprint(request, currency, optimizerVersion),
    optimizerVersion,
    status: exploration.status,
    request,
    currency,
    ...(exploration.window !== undefined && { window: exploration.window }),
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
    destinations: exploration.destinations,
    issues: exploration.issues,
  };
}
