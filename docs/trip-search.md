# `trip-search` — flight exploration

Runs a real search from the command line, so the optimizer can be exercised
without a UI (`docs/implementation-plan.md` §51).

It searches **flights**, plus the ground transfers needed to reach them, and
with `--open-jaw` composes itineraries that fly home from another city. No
accommodation, no trains or buses, no multi-city (that is Phase 3b). Fares are
**cached** and not guaranteed bookable; transfer costs are **estimates from a
distance model**, never quotes.

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

`--compose` builds trips from **one-way fares** instead of the provider's
round-trip fares. That reaches far more destinations (51 against 15, measured
2026-09-18) at the cost of more provider calls, and it works on its own: a
composed round trip flies out and home from the same city.

`--open-jaw` allows flying home from a *different* city, and implies
`--compose`, since an open jaw can only be built from one-way fares. The sector between the
two cities is **not priced** — no licensed rail or bus source exists
(`docs/provider-compliance.md`) — so it is shown as a gap, excluded from the
amount, and the output says so:

```text
1. Dalaman → Ankara (open jaw) — DLM, ESB
   Known cost: 147.00 EUR / person · 294.00 EUR · transport only
   DLM → ESB: 526 km, UNPRICED — arrange separately
   The amount above EXCLUDES DLM → ESB
```

A **known cost** is not a total. Itineraries with a gap are ranked in their own
class, always below fully priced ones, so a trip never looks cheap because of
the sector it leaves out (ADR 0014).

`--alternative-airports` also searches nearby origin airports (off by default).
Each one costs provider calls against the search budget, so the CLI prints which
alternatives it used and which it skipped, and why. A trip leaving from an
alternative origin carries the estimated journey to that airport, so it is
judged as a whole trip rather than on fare alone.

## Reading the output

```text
Provider calls: 3 (cache hit) · fares returned: 7
Filtered out: 2 wrong length
Candidates: 5 across 3 destination(s)

1. Istanbul (TR) — SAW
   127.02 EUR / person · 254.04 EUR total · transport only
   Fare: cached · includes estimated access transfer (36.04 EUR)
   3 nights in Istanbul · 5h 37m travelling · direct both ways
   fly      2027-01-01 16:10 SJJ → 2027-01-01 20:00 SAW · 1h 50m · direct · PC 294
   transfer 2027-01-01 20:45 SAW → 2027-01-01 21:41 IST · 56m · estimated
   transfer 2027-01-04 12:24 IST → 2027-01-04 13:20 SAW · 56m · estimated
   fly      2027-01-04 15:20 SAW → 2027-01-04 15:15 SJJ · 1h 55m · direct · PC 294
   cached price · checked 2026-09-18 16:57Z · aviasales · no provider expiry (freshness unknown)
```

- **Times are local** to each airport. A return that appears to land before it
  departs is a time-zone difference, not an error.
- **`transfer` legs are estimates**, shown when an airport is far enough from
  its city to matter (default: more than 25 km in a straight line). Their time
  and cost come from a distance model (ADR 0011), and the `Fare:` line names
  what is retrieved and what is estimated, so a cached fare is never relabelled.
- **Connections are validated** against minimum connection times (ADR 0012); a
  fare whose connection cannot be made is rejected and counted, not shown.
- **"no provider expiry (freshness unknown)"** means this API supplied no
  expiry, not that the price lasts forever (ADR 0006).
- **"transport only"** means flights and their transfers, but no
  accommodation, so it is not yet a complete-trip cost.
- The **filtered-out counts** explain a thin result. Nothing is dropped
  silently.
- `--json` prints the whole search trace: `searchId`, request fingerprint,
  provider metrics, every count, and the candidates.

Exit codes: `0` success (including no matches), `1` usage or configuration
problem, `2` the provider failed outright.

## How a search spends its calls

With `--compose` (and therefore with `--open-jaw`), the search runs a two-stage
funnel inside a hard budget of **12 provider calls**:

```text
Stage 1   one call per departure month: origin → anywhere, one-way
Stage 2   a return-leg query per destination, cheapest outbound fare first,
          while budget remains
```

The output says how many destinations were checked for a way home, how many
had one, and how many were never checked because the budget ran out. Return
legs are genuinely sparse — many destinations have no retrieved way back — so
that line is usually the explanation for a short result.

Alternative origins draw on the **same** budget: three origins over a two-month
window spend 6 calls before any return leg is queried.

The 12 is an application-level safety limit of our own, not the provider's
quota, which remains unverified (`docs/provider-compliance.md`).

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
