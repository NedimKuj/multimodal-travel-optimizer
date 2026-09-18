import { httpGetText, redactSecrets, type FetchLike } from "../http.js";
import { secretsOf, type AviasalesConfig } from "./config.js";

/*
 * Phase 0 feasibility probe.
 *
 * The Data API's v3 response shape is not documented publicly (the support
 * article returns 403 to automated requests and the endpoint 401s without a
 * token), so the schemas have to be derived from observed responses. This runs
 * a small, fixed set of calls and records exactly what came back.
 *
 * It is a research tool, not part of a search path: every call is explicit,
 * the total is bounded, and calls are spaced out to stay polite.
 */

export interface ProbeQuery {
  /** Short identifier used in the capture filename. */
  readonly name: string;
  /** What this call is meant to establish. */
  readonly question: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface ProbeCapture {
  readonly name: string;
  readonly question: string;
  /** Request URL with the token redacted. */
  readonly url: string;
  readonly status?: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly failure?: { readonly kind: string; readonly message: string };
  /** Parsed body when it is JSON, otherwise the raw text. Token redacted. */
  readonly body?: unknown;
  readonly rawBody?: string;
}

/** The fixed probe plan: SJJ coverage, several months, date flexibility, currency. */
export function defaultProbeQueries(currency: string): readonly ProbeQuery[] {
  const lower = currency.toLowerCase();
  return [
    {
      name: "v3-prices-for-dates-anywhere-december",
      question: "How many destinations does SJJ reach for a fixed departure date?",
      path: "/aviasales/v3/prices_for_dates",
      params: { origin: "SJJ", departure_at: "2026-12-26", currency: lower, limit: "30", sorting: "price", one_way: "true" },
    },
    {
      name: "v3-prices-for-dates-roundtrip",
      question: "Does a round-trip query return one record covering both directions?",
      path: "/aviasales/v3/prices_for_dates",
      params: { origin: "SJJ", departure_at: "2026-12-26", return_at: "2027-01-02", currency: lower, limit: "30", sorting: "price", one_way: "false" },
    },
    {
      name: "v3-prices-for-dates-sjj-ist",
      question: "What fields describe a single known route (SJJ to IST)?",
      path: "/aviasales/v3/prices_for_dates",
      params: { origin: "SJJ", destination: "IST", departure_at: "2026-12-26", return_at: "2027-01-02", currency: lower, limit: "10", one_way: "false" },
    },
    {
      name: "v3-prices-for-dates-month-2026-12",
      question: "Does a month-granularity departure_at work, and what does it return?",
      path: "/aviasales/v3/prices_for_dates",
      params: { origin: "SJJ", departure_at: "2026-12", currency: lower, limit: "30", one_way: "true" },
    },
    {
      name: "v3-prices-for-dates-month-2027-01",
      question: "Month coverage: January 2027.",
      path: "/aviasales/v3/prices_for_dates",
      params: { origin: "SJJ", departure_at: "2027-01", currency: lower, limit: "30", one_way: "true" },
    },
    {
      name: "v3-prices-for-dates-month-2027-03",
      question: "Month coverage: March 2027, further out.",
      path: "/aviasales/v3/prices_for_dates",
      params: { origin: "SJJ", departure_at: "2027-03", currency: lower, limit: "30", one_way: "true" },
    },
    {
      name: "v3-grouped-prices",
      question: "Is there a cheapest-per-destination discovery endpoint?",
      path: "/aviasales/v3/grouped_prices",
      params: { origin: "SJJ", currency: lower, group_by: "departure_at" },
    },
    {
      name: "v3-get-latest-prices",
      question: "What does the latest-prices endpoint return for SJJ?",
      path: "/aviasales/v3/get_latest_prices",
      params: { origin: "SJJ", currency: lower, limit: "30", one_way: "true" },
    },
    {
      name: "v1-city-directions",
      question: "Legacy discovery endpoint: destinations reachable from SJJ.",
      path: "/v1/city-directions",
      params: { origin: "SJJ", currency: lower },
    },
    // Date flexibility: the same route across a +/-2 day window.
    ...["2026-12-24", "2026-12-25", "2026-12-26", "2026-12-27", "2026-12-28"].map((date) => ({
      name: `v3-flexibility-${date}`,
      question: `Availability and price for SJJ on ${date} (flexibility window).`,
      path: "/aviasales/v3/prices_for_dates",
      params: { origin: "SJJ", departure_at: date, currency: lower, limit: "10", sorting: "price", one_way: "true" },
    })),
  ];
}

export function buildProbeUrl(config: AviasalesConfig, query: ProbeQuery): string {
  const url = new URL(query.path, config.baseUrl);
  for (const [key, value] of Object.entries(query.params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RunProbeOptions {
  readonly config: AviasalesConfig;
  readonly queries: readonly ProbeQuery[];
  /** Pause between calls, to stay well inside any rate limit. */
  readonly pauseMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly onCapture?: (capture: ProbeCapture) => void;
}

/**
 * Runs the probe plan sequentially. The token travels in a header, never in the
 * recorded URL, and every captured string is redacted before it is returned.
 */
export async function runProbe(options: RunProbeOptions): Promise<ProbeCapture[]> {
  const { config, queries, pauseMs = 400, fetchImpl, onCapture } = options;
  const secrets = secretsOf(config);
  const captures: ProbeCapture[] = [];

  for (const [index, query] of queries.entries()) {
    if (index > 0) await delay(pauseMs);
    const url = buildProbeUrl(config, query);
    const outcome = await httpGetText(
      { url, timeoutMs: config.timeoutMs, headers: { "x-access-token": config.token } },
      fetchImpl,
    );

    const base = {
      name: query.name,
      question: query.question,
      url: redactSecrets(url, secrets),
      durationMs: outcome.durationMs,
    };

    let capture: ProbeCapture;
    if (!outcome.ok) {
      capture = {
        ...base,
        ok: false,
        ...(outcome.status !== undefined && { status: outcome.status }),
        failure: {
          kind: outcome.failure.kind,
          message: redactSecrets(outcome.failure.message, secrets),
        },
      };
    } else {
      const text = redactSecrets(outcome.body, secrets);
      capture = { ...base, ok: true, status: outcome.status, ...parseBody(text) };
    }
    captures.push(capture);
    onCapture?.(capture);
  }
  return captures;
}

function parseBody(text: string): { body: unknown } | { rawBody: string } {
  try {
    const body: unknown = JSON.parse(text);
    return { body };
  } catch {
    return { rawBody: text };
  }
}
