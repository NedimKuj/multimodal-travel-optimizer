/*
 * Response cache.
 *
 * External calls are treated as expensive (AGENTS.md rule 8): the cache is
 * checked before a provider is called. Keys never contain credentials, because
 * callers key on the redacted URL.
 */

export interface CachedResponse {
  readonly body: string;
  readonly storedAt: number;
}

export interface ResponseCache {
  get(key: string): CachedResponse | undefined;
  set(key: string, body: string): void;
}

/**
 * A process-local cache with a fixed TTL. Deliberately simple: a shared cache
 * (Redis) is only worth adding once there is more than one process.
 */
export function createInMemoryResponseCache(
  ttlMs: number,
  now: () => number = () => Date.now(),
): ResponseCache {
  const entries = new Map<string, CachedResponse>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (now() - entry.storedAt >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return entry;
    },
    set(key, body) {
      entries.set(key, { body, storedAt: now() });
    },
  };
}
