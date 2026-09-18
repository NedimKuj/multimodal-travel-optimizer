import { describe, expect, it } from "vitest";

import type { FetchLike } from "../http.js";
import { loadAviasalesConfig, type AviasalesConfig } from "./config.js";
import { buildProbeUrl, defaultProbeQueries, runProbe, type ProbeQuery } from "./probe.js";

const token = "secret-token-1234";

function config(): AviasalesConfig {
  const result = loadAviasalesConfig({ AVIASALES_API_TOKEN: token });
  if (!result.ok) throw new Error("expected config");
  return result.config;
}

const query: ProbeQuery = {
  name: "test-call",
  question: "does it work?",
  path: "/aviasales/v3/prices_for_dates",
  params: { origin: "SJJ", currency: "eur" },
};

describe("buildProbeUrl", () => {
  it("builds an absolute URL with the query parameters", () => {
    expect(buildProbeUrl(config(), query)).toBe(
      "https://api.travelpayouts.com/aviasales/v3/prices_for_dates?origin=SJJ&currency=eur",
    );
  });

  it("never puts the token in the URL", () => {
    expect(buildProbeUrl(config(), query)).not.toContain(token);
  });
});

describe("runProbe", () => {
  it("sends the token as a header and redacts it from captures", async () => {
    const seen: Record<string, unknown>[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      seen.push({ url, headers: init.headers });
      return Promise.resolve(new Response(`{"success":true,"token":"${token}","data":[]}`));
    };
    const captures = await runProbe({ config: config(), queries: [query], pauseMs: 0, fetchImpl });

    expect(seen[0]?.["headers"]).toMatchObject({ "x-access-token": token });
    expect(JSON.stringify(captures)).not.toContain(token);
    expect(captures[0]).toMatchObject({ ok: true, status: 200, name: "test-call" });
  });

  it("records failures without aborting the run", async () => {
    let call = 0;
    const fetchImpl: FetchLike = () => {
      call += 1;
      return Promise.resolve(
        call === 1 ? new Response("nope", { status: 401 }) : new Response('{"data":[]}'),
      );
    };
    const captures = await runProbe({
      config: config(),
      queries: [query, { ...query, name: "second" }],
      pauseMs: 0,
      fetchImpl,
    });
    expect(captures).toHaveLength(2);
    expect(captures[0]).toMatchObject({ ok: false, failure: { kind: "unauthorized" } });
    expect(captures[1]).toMatchObject({ ok: true });
  });

  it("keeps a non-JSON body as raw text", async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(new Response("<html>not json</html>"));
    const captures = await runProbe({ config: config(), queries: [query], pauseMs: 0, fetchImpl });
    expect(captures[0]).toMatchObject({ ok: true, rawBody: "<html>not json</html>" });
  });
});

describe("defaultProbeQueries", () => {
  it("covers the questions Phase 0 asks", () => {
    const names = defaultProbeQueries("EUR").map((probe) => probe.name);
    expect(names).toContain("v3-prices-for-dates-roundtrip");
    expect(names.filter((name) => name.startsWith("v3-flexibility-"))).toHaveLength(5);
    expect(names.filter((name) => name.includes("month"))).toHaveLength(3);
  });

  it("stays a bounded, explicit plan", () => {
    expect(defaultProbeQueries("EUR").length).toBeLessThanOrEqual(20);
  });

  it("passes the currency through in the provider's expected case", () => {
    const [first] = defaultProbeQueries("BAM");
    expect(first?.params["currency"]).toBe("bam");
  });
});
