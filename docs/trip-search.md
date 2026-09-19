# `trip-search` — flight exploration

Runs a real search from the command line, so the optimizer can be exercised
without a UI (`docs/implementation-plan.md` §51).

It searches **flights**, plus the ground transfers needed to reach them. With
`--open-jaw` it composes itineraries that fly home from another city, and with
`--multi-city` itineraries that stop in a second city on the way. No
accommodation, no trains or buses. Fares are **cached** and not guaranteed
bookable; transfer costs are **estimates from a distance model**, never quotes.

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

`--multi-city` allows a second city on the way, and implies `--compose`:

```text
2. Rome → Milan (multi-city) — CIA, MXP
   127.00 EUR / person · 254.00 EUR total · transport only
   3 nights Rome · 3 nights Milan · 7h 46m travelling · direct on every leg
   fly      2026-12-27 10:00 SJJ → 2026-12-27 11:30 CIA · direct
   fly      2026-12-30 10:00 CIA → 2026-12-30 11:15 MXP · direct
   fly      2027-01-02 18:00 MXP → 2027-01-02 19:45 SJJ · direct
```

Nights are reported **per city**, and every city gets at least one: a place the
trip passes through in an afternoon is a connection, not a destination, and such
itineraries are rejected and counted.

Combining `--multi-city` with `--open-jaw` also allows flying home from a third
city, with that last sector unpriced exactly as above.

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
   3 nights · 5h 37m travelling · direct both ways
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
- **Nights are per city** on a multi-city trip, and a night spent crossing
  between two cities belongs to neither, so the per-city nights can sum to less
  than the days away.
- **Transfers attach per stay.** The itinerary carries the traveler in from the
  airport they land at and back out to the airport they leave from, which on an
  open jaw are different airports in different cities.
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
Stage 2   a return-leg query per destination, cheapest outbound fare first
Stage 3   an onward-leg query per destination, with --multi-city only
```

A **logical query** — one question, such as "how do I get home from Rome?" —
costs one provider call per calendar month its dates span. A two-month window
therefore makes each return-leg query cost two calls.

Stages 2 and 3 share what stage 1 leaves. The first **two** return-leg queries
are guaranteed, because an itinerary with no way home does not exist, and then
the two stages alternate: return, onward, return, onward, until the budget is
gone. The output names which stage ran short:

```text
Calls planned: 12 of 12 budget · budget-limited: 3 onward leg queries not made
```

The output also says how many destinations were checked for a way home, how many
had one, and how many were never checked. Return legs are genuinely sparse —
many destinations have no retrieved way back — so that line is usually the
explanation for a short result.

Return legs are only queried for the destinations stage 1 found, so a **second
city** reached by an onward leg may have no retrieved way home at all. The
output reports that too:

```text
Second cities reachable onward: 4 (3 with no retrieved way home)
```

Alternative origins draw on the **same** budget: three origins over a two-month
window spend 6 calls before any return leg is queried, which leaves room for the
two guaranteed ways home and nothing else.

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

### Multi-city rarely composes today

Measured 2026-09-19 for `SJJ`:

| Request | Second cities reached | With a retrieved way home |
|---|---|---|
| 26 Dec – 3 Jan, 5–7 nights, two-month window | 8 | **0** |
| 5–20 Dec, 5–7 nights, one-month window | 34 | **0** |

Onward legs are found readily. What is missing is a way home *from* them: return
legs are only queried for the destinations stage 1 found, and the budget funds
three to six of those. The second cities an onward leg reaches are almost never
among them, so a third leg home cannot be retrieved and no three-leg itinerary
can be built.

The search says so rather than returning nothing without explanation:

```text
Second cities reachable onward: 34 (34 with no retrieved way home)
```

Closing this needs an allocation change — feeding second cities back into the
return queue so a query can be spent on one — which is a decision about the
funnel, not a defect in composition. Until then `--multi-city` costs budget that
would otherwise find more ways home, so it is off by default.
