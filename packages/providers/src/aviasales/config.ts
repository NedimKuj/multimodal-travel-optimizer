import { currencyCodeSchema, type DomainIssue } from "@travel-optimizer/domain";
import { z } from "zod";

/**
 * Aviasales adapter configuration.
 *
 * The token is a secret: it is read from the environment, never committed,
 * never logged, and redacted from anything the probe writes to disk.
 *
 * `marker` is the Travelpayouts affiliate id. Without it no booking link is
 * produced, because an unattributed link would misrepresent where the price
 * can be verified (docs/provider-compliance.md).
 */
export const aviasalesConfigSchema = z.object({
  token: z.string().min(1),
  marker: z.string().min(1).optional(),
  baseUrl: z.url().default("https://api.travelpayouts.com"),
  bookingBaseUrl: z.url().default("https://www.aviasales.com"),
  timeoutMs: z.number().int().positive().max(120_000).default(10_000),
  defaultCurrency: currencyCodeSchema.default("EUR"),
  enabled: z.boolean().default(true),
});

export type AviasalesConfig = z.infer<typeof aviasalesConfigSchema>;

export type AviasalesConfigResult =
  | { readonly ok: true; readonly config: AviasalesConfig }
  | { readonly ok: false; readonly issues: readonly DomainIssue[] };

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * Builds the config from environment variables:
 * `AVIASALES_API_TOKEN` (required), `AVIASALES_MARKER`, `AVIASALES_BASE_URL`,
 * `AVIASALES_TIMEOUT_MS`, `AVIASALES_CURRENCY`.
 *
 * Returns issues rather than throwing, and never includes the token value in
 * a message.
 */
export function loadAviasalesConfig(
  env: Readonly<Partial<Record<string, string>>> = process.env,
): AviasalesConfigResult {
  const timeoutRaw = optional(env["AVIASALES_TIMEOUT_MS"]);
  const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);

  const parsed = aviasalesConfigSchema.safeParse({
    token: optional(env["AVIASALES_API_TOKEN"]),
    marker: optional(env["AVIASALES_MARKER"]),
    baseUrl: optional(env["AVIASALES_BASE_URL"]),
    bookingBaseUrl: optional(env["AVIASALES_BOOKING_BASE_URL"]),
    timeoutMs,
    defaultCurrency: optional(env["AVIASALES_CURRENCY"]),
  });

  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "INVALID_AVIASALES_CONFIG",
        message: `${issue.path.map(String).join(".") || "config"}: ${issue.message}`,
      })),
    };
  }
  return { ok: true, config: parsed.data };
}

/** Values that must never appear in logs, captures or error messages. */
export function secretsOf(config: AviasalesConfig): readonly string[] {
  return [config.token];
}
