import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeSearchRequest,
  type AirportGeography,
  type AirportRepository,
  type CityRepository,
  type DomainIssue,
  type FlightProvider,
} from "@travel-optimizer/domain";
import { loadReferenceData, SnapshotUnavailableError } from "@travel-optimizer/geo";
import { runFlightSearch, type SearchTrace } from "@travel-optimizer/optimizer";
import {
  aviasalesRetentionTtl,
  createAviasalesFlightProvider,
  createFileResponseCache,
  loadAviasalesConfig,
} from "@travel-optimizer/providers";

import type { MappedSearchRequest } from "../lib/map-search-request";

/** Same cache policy as the CLI — 1h TTL inside the 24h retention ceiling. */
export const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_DIRECTORY = ".cache/providers";

/** apps/web/src/server → monorepo root (same place the CLI uses for cache). */
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export interface RunSearchOverrides {
  readonly referenceData?: {
    readonly airports: AirportRepository;
    readonly cities: CityRepository;
    readonly geography: AirportGeography;
  };
  readonly flightProvider?: FlightProvider;
  readonly cwd?: string;
  readonly env?: Readonly<Partial<Record<string, string>>>;
  readonly now?: () => Date;
  readonly newSearchId?: () => string;
}

export type RunSearchResult =
  | { readonly ok: true; readonly trace: SearchTrace }
  | {
      readonly ok: false;
      readonly status: number;
      readonly issues: readonly DomainIssue[];
      readonly message: string;
    };

/**
 * Thin composition root for Trip Explorer — mirrors `packages/cli` run().
 *
 * Does not call providers from the browser. Does not alter optimizer behavior.
 */
export async function runTripSearch(
  mapped: MappedSearchRequest,
  overrides: RunSearchOverrides = {},
): Promise<RunSearchResult> {
  const normalized = normalizeSearchRequest(mapped.input);
  if (!normalized.ok) {
    return {
      ok: false,
      status: 400,
      issues: normalized.issues,
      message: "Invalid search request",
    };
  }

  const env = overrides.env ?? process.env;
  const cwd = overrides.cwd ?? WORKSPACE_ROOT;

  let referenceData = overrides.referenceData;
  if (referenceData === undefined) {
    try {
      const loaded = await loadReferenceData();
      referenceData = {
        airports: loaded.airports.repository,
        cities: loaded.cities.repository,
        geography: loaded.geography.geography,
      };
    } catch (error) {
      const message =
        error instanceof SnapshotUnavailableError
          ? error.message
          : `Could not load reference data: ${error instanceof Error ? error.message : String(error)}`;
      return {
        ok: false,
        status: 503,
        issues: [{ code: "REFERENCE_DATA", message }],
        message,
      };
    }
  }

  let flightProvider = overrides.flightProvider;
  if (flightProvider === undefined) {
    const configResult = loadAviasalesConfig(env);
    if (!configResult.ok) {
      const missingToken = configResult.issues.some((issue) =>
        issue.message.startsWith("token:"),
      );
      return {
        ok: false,
        status: 503,
        issues: missingToken
          ? [{ code: "MISSING_TOKEN", message: "AVIASALES_API_TOKEN is not set" }]
          : configResult.issues,
        message: "Flight provider is not configured",
      };
    }

    flightProvider = createAviasalesFlightProvider({
      config: configResult.config,
      airports: referenceData.airports,
      cache: createFileResponseCache(
        resolve(cwd, CACHE_DIRECTORY),
        aviasalesRetentionTtl(CACHE_TTL_MS),
      ),
    });
  }

  const trace = await runFlightSearch(
    normalized.request,
    {
      flightProvider,
      cities: referenceData.cities,
      geography: referenceData.geography,
      airports: referenceData.airports,
    },
    {
      currency: mapped.currency,
      strategy: mapped.compose ? "composed" : "provider_round_trips",
      ...(overrides.now !== undefined && { now: overrides.now }),
      ...(overrides.newSearchId !== undefined && { newSearchId: overrides.newSearchId }),
    },
  );

  return { ok: true, trace };
}
