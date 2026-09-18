import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFileResponseCache, createInMemoryResponseCache } from "./cache.js";

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

describe("createInMemoryResponseCache", () => {
  it("returns what it stored, until the TTL passes", () => {
    const time = clock();
    const cache = createInMemoryResponseCache(1000, time.now);
    cache.set("key", "body");
    expect(cache.get("key")?.body).toBe("body");
    time.advance(999);
    expect(cache.get("key")?.body).toBe("body");
    time.advance(1);
    expect(cache.get("key")).toBeUndefined();
  });

  it("misses on unknown keys", () => {
    expect(createInMemoryResponseCache(1000).get("nothing")).toBeUndefined();
  });
});

describe("createFileResponseCache", () => {
  function tempCache(ttlMs = 1000) {
    const directory = mkdtempSync(join(tmpdir(), "response-cache-"));
    const time = clock();
    return { directory, time, cache: createFileResponseCache(directory, ttlMs, time.now) };
  }

  it("survives being rebuilt, so repeated runs reuse the response", () => {
    const { directory, cache, time } = tempCache();
    cache.set("https://provider.test/search?x=1", "cached body");

    // A fresh instance, as a second CLI run moments later would create.
    const second = createFileResponseCache(directory, 1000, time.now);
    expect(second.get("https://provider.test/search?x=1")?.body).toBe("cached body");
  });

  it("expires entries", () => {
    const { cache, time } = tempCache();
    cache.set("key", "body");
    time.advance(1000);
    expect(cache.get("key")).toBeUndefined();
  });

  it("keeps different keys apart", () => {
    const { cache } = tempCache();
    cache.set("a", "first");
    cache.set("b", "second");
    expect(cache.get("a")?.body).toBe("first");
    expect(cache.get("b")?.body).toBe("second");
  });

  it("treats an unreadable or corrupt entry as a miss", () => {
    const { directory, cache } = tempCache();
    expect(cache.get("never stored")).toBeUndefined();

    const corrupt = createFileResponseCache(directory, 1000, () => 0);
    corrupt.set("key", "body");
    // Overwrite the entry with something that is not a cache record.
    const files = ["not json", JSON.stringify({ body: 42 })];
    for (const contents of files) {
      writeFileSync(
        // Same hashing the cache uses, recomputed here to target the file.
        join(directory, `${createHash("sha256").update("key").digest("hex")}.json`),
        contents,
        "utf8",
      );
      expect(corrupt.get("key")).toBeUndefined();
    }
  });

  it("does not throw when the directory cannot be written", () => {
    const cache = createFileResponseCache("/proc/nonexistent/cache", 1000);
    expect(() => {
      cache.set("key", "body");
    }).not.toThrow();
    expect(cache.get("key")).toBeUndefined();
  });
});
