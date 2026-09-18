import type { ProviderFailure } from "@travel-optimizer/domain";

/*
 * Minimal HTTP layer for provider adapters.
 *
 * It never throws: every transport problem becomes a `ProviderFailure`, so one
 * provider failing cannot fail a whole search (AGENTS.md rule 14).
 */

export interface HttpGetRequest {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Caller-owned cancellation, combined with the timeout. */
  readonly signal?: AbortSignal;
}

export type HttpOutcome =
  | {
      readonly ok: true;
      readonly status: number;
      readonly body: string;
      readonly durationMs: number;
    }
  | {
      readonly ok: false;
      readonly failure: ProviderFailure;
      readonly status?: number;
      readonly durationMs: number;
    };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Maps an HTTP status to a failure kind, with retryability. */
export function failureForStatus(status: number, body: string): ProviderFailure {
  const detail = body.slice(0, 200);
  if (status === 401 || status === 403) {
    return {
      kind: "unauthorized",
      message: `Provider rejected the credentials (HTTP ${status})`,
      retryable: false,
    };
  }
  if (status === 429) {
    return { kind: "rate_limited", message: `HTTP 429: ${detail}`, retryable: true };
  }
  if (status >= 500) {
    return { kind: "unavailable", message: `HTTP ${status}: ${detail}`, retryable: true };
  }
  return { kind: "unsupported_query", message: `HTTP ${status}: ${detail}`, retryable: false };
}

/**
 * Performs a GET and returns the raw body.
 *
 * The body is returned as text, not parsed: schema validation belongs to the
 * adapter, and the raw text is what a probe records.
 */
export async function httpGetText(
  request: HttpGetRequest,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<HttpOutcome> {
  const startedAt = performance.now();
  const elapsed = (): number => Math.round(performance.now() - startedAt);

  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal =
    request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal]);

  try {
    const response = await fetchImpl(request.url, {
      method: "GET",
      headers: { accept: "application/json", "accept-encoding": "gzip, deflate", ...request.headers },
      signal,
    });
    const body = await response.text();
    if (!response.ok) {
      return { ok: false, failure: failureForStatus(response.status, body), status: response.status, durationMs: elapsed() };
    }
    return { ok: true, status: response.status, body, durationMs: elapsed() };
  } catch (error) {
    return { ok: false, failure: failureForError(error), durationMs: elapsed() };
  }
}

function failureForError(error: unknown): ProviderFailure {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return { kind: "timeout", message: "Request timed out", retryable: true };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { kind: "timeout", message: "Request aborted", retryable: false };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "unavailable", message: `Network error: ${message}`, retryable: true };
}

/**
 * Replaces secrets with a placeholder so a URL or body can be logged or stored.
 * Always applied before anything leaves the process.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    redacted = redacted.split(secret).join("***REDACTED***");
  }
  return redacted;
}
