import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { defaultProbeQueries, loadAviasalesConfig, runProbe, type ProbeCapture } from "../index.js";

/*
 * Runs the Phase 0 feasibility probe and writes captures to .probe/<run>/.
 *
 * Captures contain provider price data and stay out of version control
 * (.gitignore). The token is redacted from everything written here.
 *
 * Usage: pnpm aviasales:probe
 */

function summarize(capture: ProbeCapture): string {
  if (!capture.ok) {
    return `  ${capture.name}: FAILED ${capture.failure?.kind ?? "unknown"} (${capture.status ?? "-"})`;
  }
  const body = capture.body;
  let shape = "non-JSON body";
  if (body !== null && typeof body === "object") {
    const record: Record<string, unknown> = { ...body };
    const data = record["data"];
    const count = Array.isArray(data)
      ? `${data.length} records`
      : data !== null && typeof data === "object"
        ? `${Object.keys(data).length} keys`
        : "no data field";
    shape = `keys=[${Object.keys(record).join(",")}] ${count}`;
  }
  return `  ${capture.name}: ${capture.status} in ${capture.durationMs}ms — ${shape}`;
}

async function main(): Promise<void> {
  const configResult = loadAviasalesConfig();
  if (!configResult.ok) {
    for (const issue of configResult.issues) {
      process.stderr.write(`${issue.code}: ${issue.message}\n`);
    }
    process.stderr.write("Set AVIASALES_API_TOKEN in .env (see .env.example).\n");
    process.exitCode = 1;
    return;
  }
  const { config } = configResult;
  const queries = defaultProbeQueries(config.defaultCurrency);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = resolve(process.cwd(), ".probe", runId);
  await mkdir(directory, { recursive: true });

  process.stdout.write(`Probing ${config.baseUrl} with ${queries.length} calls\n`);
  const captures = await runProbe({
    config,
    queries,
    onCapture: (capture) => {
      process.stdout.write(`${summarize(capture)}\n`);
    },
  });

  for (const [index, capture] of captures.entries()) {
    const file = join(directory, `${String(index).padStart(2, "0")}-${capture.name}.json`);
    await writeFile(file, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  }
  await writeFile(
    join(directory, "summary.json"),
    `${JSON.stringify(
      {
        runId,
        baseUrl: config.baseUrl,
        currency: config.defaultCurrency,
        markerConfigured: config.marker !== undefined,
        calls: captures.map((capture) => ({
          name: capture.name,
          question: capture.question,
          ok: capture.ok,
          status: capture.status,
          durationMs: capture.durationMs,
          failure: capture.failure,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const failed = captures.filter((capture) => !capture.ok).length;
  process.stdout.write(`\nWrote ${captures.length} captures to ${directory} (${failed} failed)\n`);
}

await main();
