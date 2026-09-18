import { describe, expect, it } from "vitest";

import { loadAviasalesConfig, secretsOf } from "./config.js";

const token = "test-token-value";

describe("loadAviasalesConfig", () => {
  it("applies documented defaults", () => {
    const result = loadAviasalesConfig({ AVIASALES_API_TOKEN: token });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected config");
    expect(result.config).toEqual({
      token,
      baseUrl: "https://api.travelpayouts.com",
      bookingBaseUrl: "https://www.aviasales.com",
      timeoutMs: 10_000,
      defaultCurrency: "EUR",
      enabled: true,
    });
  });

  it("reads optional settings", () => {
    const result = loadAviasalesConfig({
      AVIASALES_API_TOKEN: token,
      AVIASALES_MARKER: "12345",
      AVIASALES_TIMEOUT_MS: "2500",
      AVIASALES_CURRENCY: "BAM",
    });
    if (!result.ok) throw new Error("expected config");
    expect(result.config).toMatchObject({ marker: "12345", timeoutMs: 2500, defaultCurrency: "BAM" });
  });

  it("requires a token", () => {
    const result = loadAviasalesConfig({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected issues");
    expect(result.issues[0]?.message).toContain("token");
  });

  it("treats blank values as absent", () => {
    const result = loadAviasalesConfig({ AVIASALES_API_TOKEN: "   " });
    expect(result.ok).toBe(false);
  });

  it("rejects an unsupported currency instead of falling back", () => {
    const result = loadAviasalesConfig({ AVIASALES_API_TOKEN: token, AVIASALES_CURRENCY: "XYZ" });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-numeric or negative timeout", () => {
    expect(loadAviasalesConfig({ AVIASALES_API_TOKEN: token, AVIASALES_TIMEOUT_MS: "soon" }).ok).toBe(
      false,
    );
    expect(loadAviasalesConfig({ AVIASALES_API_TOKEN: token, AVIASALES_TIMEOUT_MS: "-1" }).ok).toBe(
      false,
    );
  });

  it("never echoes the token in an error message", () => {
    const result = loadAviasalesConfig({ AVIASALES_API_TOKEN: token, AVIASALES_CURRENCY: "XYZ" });
    if (result.ok) throw new Error("expected issues");
    for (const issue of result.issues) {
      expect(issue.message).not.toContain(token);
    }
  });

  it("lists the token as a secret to redact", () => {
    const result = loadAviasalesConfig({ AVIASALES_API_TOKEN: token });
    if (!result.ok) throw new Error("expected config");
    expect(secretsOf(result.config)).toEqual([token]);
  });
});
