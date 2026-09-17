import { describe, expect, it } from "vitest";

import { parseUtcInstant } from "../time/zoned-timestamp.js";
import {
  failedResult,
  okResult,
  partialResult,
  type ProviderCallMetrics,
  type ProviderFailure,
  type TransportSearchResult,
} from "./providers.js";

const metrics: ProviderCallMetrics = {
  startedAt: parseUtcInstant("2026-09-17T12:00:00Z"),
  completedAt: parseUtcInstant("2026-09-17T12:00:01Z"),
  requestCount: 1,
  cache: "miss",
};

const timeout: ProviderFailure = {
  kind: "timeout",
  message: "Request timed out",
  retryable: true,
};

const empty: TransportSearchResult = { segments: [], offers: [] };

describe("provider result envelopes", () => {
  it("builds ok results with no failures", () => {
    expect(okResult("fixture", empty, metrics)).toEqual({
      status: "ok",
      provider: "fixture",
      data: empty,
      failures: [],
      metrics,
    });
  });

  it("builds partial results that keep data and expose failures", () => {
    const result = partialResult("fixture", empty, [timeout], metrics);
    expect(result.status).toBe("partial");
    expect(result.failures).toEqual([timeout]);
    expect("data" in result).toBe(true);
  });

  it("builds failed results without data", () => {
    const result = failedResult<TransportSearchResult>("fixture", [timeout], metrics);
    expect(result.status).toBe("failed");
    expect("data" in result).toBe(false);
  });

  it("refuses partial or failed results that hide the failure", () => {
    expect(() => partialResult("fixture", empty, [], metrics)).toThrow(/must list failures/);
    expect(() => failedResult("fixture", [], metrics)).toThrow(/must list failures/);
  });
});
