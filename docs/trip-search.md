# `trip-search` — Phase 1 flight exploration

Runs a real search from the command line, so the optimizer can be exercised
without a UI (`docs/implementation-plan.md` §51).

Phase 1 searches **flights only**: no accommodation, ground transport,
alternative airports, open jaw or multi-city. Every price is a **cached fare
for transport only** and is not guaranteed bookable.

## Prerequisites

1. `AVIASALES_API_TOKEN` in a local `.env` (see `.env.example`). Never commit it.
2. Reference data fetched once: `pnpm geo:fetch` (airports and cities; the
   snapshots stay out of version control, see ADR 0007).

## Usage

```bash
pnpm trip-search \
  --origin SJJ \
  --from 2026-12-26 \
  --to 2027-01-03 \
  --nights 5:7 \
  --flex 2 \
  --people 2 \
  --budget 700
```

`pnpm trip-search --help` lists every flag and its default.

**What the dates mean** (ADR 0009): with `--nights`, `--from`/`--to` bound the
period you could be away, and any trip fitting inside `[from-flex, to+flex]`
with nights in range qualifies. Without `--nights`, they are exact departure and
return dates, each with `±flex` tolerance.

`--budget` is **per person by default**; pass `--budget-basis total` for a whole
trip budget. The CLI prints back which one it used.

## Reading the output

```text
Provider calls: 1 (cache hit) · fares returned: 7
Filtered out: 2 wrong length
Candidates: 5 across 3 destination(s)

1. Istanbul (TR) — SAW
   109.00 EUR / person · 218.00 EUR total · transport only
   3 nights · 3h 45m travelling · direct both ways
   out  2027-01-01 16:10 SJJ → 2027-01-01 20:00 SAW · 1h 50m · direct · PC 294
   back 2027-01-04 15:20 SAW → 2027-01-04 15:15 SJJ · 1h 55m · direct · PC 294
   cached price · checked 2026-09-18 10:41Z · aviasales · no provider expiry (freshness unknown)
```

- **Times are local** to each airport. A return that appears to land before it
  departs is a time-zone difference, not an error.
- **"no provider expiry (freshness unknown)"** means this API supplied no
  expiry, not that the price lasts forever (ADR 0006).
- **"transport only"** is literal: accommodation, transfers and extras are not
  in that total, so it is not comparable with a complete-trip cost.
- The **filtered-out counts** explain a thin result. Nothing is dropped
  silently.
- `--json` prints the whole search trace: `searchId`, request fingerprint,
  provider metrics, every count, and the candidates.

Exit codes: `0` success (including no matches), `1` usage or configuration
problem, `2` the provider failed outright.

## Caching

Provider responses are cached on disk in `.cache/providers` for an hour, so
repeated runs cost nothing (`Provider calls: 0 (cache hit)`). Delete the
directory to force fresh calls.

## What to expect from the data

Coverage comes from cached round-trip fares, and it is thin. Measured on
2026-09-18 for `SJJ`, 24 Dec 2026 – 5 Jan 2027:

| Request | Result |
|---|---|
| 5–7 nights | 5 fares in window, **1 destination** (Yerevan, €296/person) |
| 3–4 nights | 7 fares in window, 3 destinations (Istanbul €109, Rome €153, Yerevan €208) |

Across the whole window the provider held **no** 5–7 night round trips to
Western Europe. An empty or one-line result is therefore a real answer about
this data source, not a failure — and the counts say which constraint removed
what. Widening `--flex`, changing `--nights`, or waiting for the cache to
refresh are the levers.

This is a property of the current discovery source, not of the destination
universe (ADR 0008). One-way composition and further providers widen it in
later phases.
