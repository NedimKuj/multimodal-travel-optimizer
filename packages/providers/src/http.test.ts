import { describe, expect, it } from "vitest";

import { failureForStatus, httpGetText, redactSecrets, type FetchLike } from "./http.js";

function respondWith(status: number, body: string): FetchLike {
  return () => Promise.resolve(new Response(body, { status }));
}

/** A fetch that never settles until aborted, rejecting with the abort reason. */
const neverSettles: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      const reason: unknown = init.signal?.reason;
      reject(reason instanceof Error ? reason : new Error("aborted"));
    });
  });

describe("httpGetText", () => {
  it("returns the raw body on success", async () => {
    const outcome = await httpGetText(
      { url: "https://example.test/a", timeoutMs: 1000 },
      respondWith(200, '{"success":true}'),
    );
    expect(outcome).toMatchObject({ ok: true, status: 200, body: '{"success":true}' });
  });

  it("turns HTTP errors into failures instead of throwing", async () => {
    const outcome = await httpGetText(
      { url: "https://example.test/a", timeoutMs: 1000 },
      respondWith(401, "unauthorized"),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a failure");
    expect(outcome.failure).toMatchObject({ kind: "unauthorized", retryable: false });
    expect(outcome.status).toBe(401);
  });

  it("turns network errors into failures instead of throwing", async () => {
    const outcome = await httpGetText({ url: "https://example.test/a", timeoutMs: 1000 }, () =>
      Promise.reject(new TypeError("connection refused")),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a failure");
    expect(outcome.failure).toMatchObject({ kind: "unavailable", retryable: true });
    expect(outcome.failure.message).toContain("connection refused");
  });

  it("reports a timeout as a retryable failure", async () => {
    const outcome = await httpGetText(
      { url: "https://example.test/slow", timeoutMs: 10 },
      neverSettles,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a failure");
    expect(outcome.failure.kind).toBe("timeout");
  });

  it("honours caller cancellation", async () => {
    const controller = new AbortController();
    const pending = httpGetText(
      { url: "https://example.test/slow", timeoutMs: 5000, signal: controller.signal },
      neverSettles,
    );
    controller.abort();
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
  });

  it("measures call duration for provider metrics", async () => {
    const outcome = await httpGetText(
      { url: "https://example.test/a", timeoutMs: 1000 },
      respondWith(200, "{}"),
    );
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("failureForStatus", () => {
  it.each([
    [401, "unauthorized", false],
    [403, "unauthorized", false],
    [429, "rate_limited", true],
    [500, "unavailable", true],
    [503, "unavailable", true],
    [400, "unsupported_query", false],
  ])("maps HTTP %i to %s", (status, kind, retryable) => {
    expect(failureForStatus(status, "body")).toMatchObject({ kind, retryable });
  });

  it("truncates long bodies", () => {
    expect(failureForStatus(500, "x".repeat(1000)).message.length).toBeLessThan(230);
  });
});

describe("redactSecrets", () => {
  it("removes every occurrence of a secret", () => {
    const url = "https://api.test/x?token=abc123&other=abc123";
    expect(redactSecrets(url, ["abc123"])).toBe(
      "https://api.test/x?token=***REDACTED***&other=***REDACTED***",
    );
  });

  it("ignores empty secrets", () => {
    expect(redactSecrets("nothing to hide", [""])).toBe("nothing to hide");
  });
});
