#!/usr/bin/env node
import { run } from "../run.js";

/*
 * trip-search entry point.
 *
 * Usage: pnpm trip-search --origin SJJ --from 2026-12-26 --to 2027-01-03 \
 *          --nights 5:7 --flex 2 --people 2 --budget 700
 */

process.exitCode = await run(process.argv.slice(2), {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  env: process.env,
  cwd: process.cwd(),
});
