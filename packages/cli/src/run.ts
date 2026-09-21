import { resolve } from "node:path";

import {
  normalizeSearchRequest,
  type AirportGeography,
  type AirportRepository,
  type CityRepository,
  type DomainIssue,
  type FlightProvider,
} from "@travel-optimizer/domain";
import { loadReferenceData, SnapshotUnavailableError } from "@travel-optimizer/geo";
import { runFlightSearch } from "@travel-optimizer/optimizer";
import {
  createAviasalesFlightProvider,
  createFileResponseCache,
  loadAviasalesConfig,
} from "@travel-optimizer/providers";

import { HELP_TEXT, parseArguments, type CliOptions } from "./args.js";
import { formatSearch } from "./format.js";

/*
 * trip-search composition root: arguments -> reference data -> provider ->
 * search -> output. All the decisions live in the packages it wires together.
 */

/** Cached provider responses live here, outside version control. */
const CACHE_DIRECTORY = ".cache/providers";
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Partial<Record<string, string>>>;
  readonly cwd: string;
}

/**
 * Seams for tests: supplying either skips loading snapshots from disk or
 * talking to a real provider. Production passes neither.
 */
export interface RunOverrides {
  readonly referenceData?: {
    readonly airports: AirportRepository;
    readonly cities: CityRepository;
    readonly geography: AirportGeography;
  };
  readonly flightProvider?: FlightProvider;
}

function reportIssues(io: CliIo, heading: string, issues: readonly DomainIssue[]): void {
  io.stderr(`${heading}\n`);
  for (const issue of issues) {
    io.stderr(`  ${issue.message}\n`);
  }
}

function toSearchRequestInput(options: CliOptions): Record<string, unknown> {
  return {
    origin: options.origin,
    destination: options.destination,
    departureDate: options.from,
    ...(options.to !== undefined && { returnDate: options.to }),
    ...(options.endDate !== undefined && { endDate: options.endDate }),
    flexibilityDays: options.flexibilityDays,
    ...(options.nights !== undefined && {
      minNights: options.nights.min,
      maxNights: options.nights.max,
    }),
    travelers: options.travelers,
    ...(options.budget !== undefined && { budget: options.budget }),
    // Flights only: no rail or bus source is licence-cleared
    // (docs/provider-compliance.md).
    transportModes: ["flight"],
    allowOpenJaw: options.openJaw,
    allowMultiCity: options.multiCity,
    alternativeAirports: options.alternativeAirports,
  };
}

/**
 * Runs the CLI and returns its exit code.
 *
 * 0 success (including "nothing matched"), 1 usage or configuration problem,
 * 2 the provider failed outright.
 */
export async function run(
  argv: readonly string[],
  io: CliIo,
  overrides: RunOverrides = {},
): Promise<number> {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    if ("help" in parsed) {
      io.stdout(`${HELP_TEXT}\n`);
      return 0;
    }
    reportIssues(io, "Invalid arguments:", parsed.issues);
    io.stderr("\nRun with --help for usage.\n");
    return 1;
  }
  const { options } = parsed;

  const normalized = normalizeSearchRequest(toSearchRequestInput(options));
  if (!normalized.ok) {
    reportIssues(io, "Invalid search:", normalized.issues);
    return 1;
  }

  const configResult = loadAviasalesConfig(io.env);
  if (!configResult.ok) {
    const missingToken = configResult.issues.some((issue) => issue.message.startsWith("token:"));
    reportIssues(
      io,
      "Provider is not configured:",
      missingToken
        ? [{ code: "MISSING_TOKEN", message: "AVIASALES_API_TOKEN is not set" }]
        : configResult.issues,
    );
    io.stderr("\nSet AVIASALES_API_TOKEN in .env (see .env.example).\n");
    return 1;
  }

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
      if (error instanceof SnapshotUnavailableError) {
        io.stderr(`${error.message}\n`);
      } else {
        io.stderr(
          `Could not load reference data: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      return 1;
    }
  }

  const provider =
    overrides.flightProvider ??
    createAviasalesFlightProvider({
      config: configResult.config,
      airports: referenceData.airports,
      cache: createFileResponseCache(resolve(io.cwd, CACHE_DIRECTORY), CACHE_TTL_MS),
    });

  const trace = await runFlightSearch(
    normalized.request,
    {
      flightProvider: provider,
      cities: referenceData.cities,
      geography: referenceData.geography,
      airports: referenceData.airports,
    },
    {
      currency: options.currency,
      strategy: options.compose ? "composed" : "provider_round_trips",
    },
  );

  io.stdout(
    options.json
      ? `${JSON.stringify(trace, null, 2)}\n`
      : `${formatSearch(trace, { limit: options.limit })}\n`,
  );

  return trace.status === "failed" ? 2 : 0;
}
