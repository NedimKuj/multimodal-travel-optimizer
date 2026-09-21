import { DomainError, instantEpochMilliseconds, instantFromEpochMilliseconds, type UtcInstant } from "@travel-optimizer/domain";

/*
 * The Aviasales Data API retention boundary.
 *
 * Travelpayouts' clarification of 2026-09-21 (docs/provider-compliance.md) caps
 * how long Data API results may be held at 24 hours. That is a provider
 * constraint rather than a tuning knob, so it is expressed once, here, and
 * every place a retention period enters the system is checked against it.
 *
 * It bounds two different things, which are easy to confuse:
 *
 *   - how long a raw response may be replayed from cache, and
 *   - how long a mapped price may be used (`expiresAt`).
 *
 * It bounds neither the age of the fare upstream. The endpoint serves fares
 * observed in the last 48 hours, so a price may already be older than the
 * moment we fetched it. Nothing here implies otherwise: prices stay `cached`.
 */

/** Maximum time Data API results may be retained, per the provider. */
export const AVIASALES_MAX_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Checks a cache TTL against the provider's ceiling and returns it unchanged.
 *
 * Throws rather than clamping: silently shortening a configured TTL would hide
 * a compliance mistake behind working software, and the caller asked for a
 * value the provider does not permit.
 */
export function aviasalesRetentionTtl(ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new DomainError(
      "INVALID_AVIASALES_RETENTION",
      `Cache TTL must be a positive number of milliseconds, got ${String(ttlMs)}`,
    );
  }
  if (ttlMs > AVIASALES_MAX_RETENTION_MS) {
    throw new DomainError(
      "AVIASALES_RETENTION_EXCEEDED",
      `Cache TTL of ${String(ttlMs)}ms exceeds the Aviasales Data API retention limit of ${String(AVIASALES_MAX_RETENTION_MS)}ms (24 hours)`,
    );
  }
  return ttlMs;
}

/**
 * The boundary beyond which a fetched price may no longer be used.
 *
 * This is our permitted-use boundary, not a claim that the fare stays valid
 * for 24 hours — see the note above.
 */
export function aviasalesExpiryFor(fetchedAt: UtcInstant): UtcInstant {
  return instantFromEpochMilliseconds(
    instantEpochMilliseconds(fetchedAt) + AVIASALES_MAX_RETENTION_MS,
  );
}
