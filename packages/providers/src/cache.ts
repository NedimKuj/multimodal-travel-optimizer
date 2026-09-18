import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
 * A process-local cache with a fixed TTL. Useful inside one search; a CLI run
 * needs the file-backed cache below to benefit across invocations.
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

/**
 * A cache on disk, so repeated CLI runs do not re-buy the same data.
 *
 * Entries hold provider responses, so the directory belongs outside version
 * control (see .gitignore). Cache problems never fail a search: a read that
 * cannot be parsed is treated as a miss, and a failed write is ignored.
 */
export function createFileResponseCache(
  directory: string,
  ttlMs: number,
  now: () => number = () => Date.now(),
): ResponseCache {
  const pathFor = (key: string): string =>
    join(directory, `${createHash("sha256").update(key).digest("hex")}.json`);

  return {
    get(key) {
      let contents: string;
      try {
        contents = readFileSync(pathFor(key), "utf8");
      } catch {
        return undefined;
      }
      try {
        const parsed: unknown = JSON.parse(contents);
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          !("body" in parsed) ||
          !("storedAt" in parsed) ||
          typeof parsed.body !== "string" ||
          typeof parsed.storedAt !== "number"
        ) {
          return undefined;
        }
        if (now() - parsed.storedAt >= ttlMs) return undefined;
        return { body: parsed.body, storedAt: parsed.storedAt };
      } catch {
        return undefined;
      }
    },
    set(key, body) {
      try {
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          pathFor(key),
          JSON.stringify({ body, storedAt: now() }),
          "utf8",
        );
      } catch {
        // A cache that cannot be written is not a search failure.
      }
    },
  };
}
