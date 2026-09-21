# `trip-search` — flight exploration

Runs a real search from the command line, so the optimizer can be exercised
without a UI (`docs/implementation-plan.md` §51).

It searches **flights**, plus the ground transfers needed to reach them. With
`--open-jaw` it composes itineraries that fly home from another city, and with
`--multi-city` itineraries that stop in a second city on the way. No trains or
buses. Fares are **cached** and not guaranteed bookable; transfer costs are
**estimates from a distance model**, never quotes.

**No accommodation is priced.** No licensed accommodation provider is available
(`docs/provider-compliance.md`), so every stay is reported as *not searched*
with the reason. That is a true statement about the trip rather than a gap in
the output: a six-night stay needs a bed whether or not we can price one.

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
- **"known cost"** means the amount covers only what is priced. The label
  beside it says what it leaves out, and each stay says what is known about it:

  ```text
  127.00 EUR / person · 254.00 EUR known cost · excludes some accommodation
  Accommodation Belgrade: not searched — 5 nights · no accommodation provider
  The amount above EXCLUDES accommodation that is not priced
  ```

  A stay reads **priced**, **not searched**, **unpriced** or **unresolved**.
  They are different facts, and the reason keeps them apart — a provider that
  answered with nothing is not the same as one we could not reach, and neither
  is the same as never having asked (ADR 0016).
- **An open jaw's accommodation is unresolved.** Flying into one city and home
  from another, with an unpriced sector between them, leaves no way to know how
  many nights belong to each. The optimizer does not guess, split evenly, or
  attribute the whole stay to one city. It says the allocation is undeterminable
  and prices none of it.
- **A complete trip outranks a cheaper incomplete one.** Candidates are ordered
  by what their amount covers before they are ordered by the amount, so a
  cheaper known cost never beats a fuller one.
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

With `--compose` (and therefore with `--open-jaw`), the search runs a staged
funnel inside a hard budget of **12 provider calls**:

```text
Stage 1   one call per departure month: origin → anywhere, one-way
Stage 2   a way-home query per candidate, cheapest known reach cost first
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

The output also says how many **places** were checked for a way home, how many
had one, and how many were never checked. That count covers both destinations
and second cities, which is why it is not labelled "destinations". Return legs
are genuinely sparse — many places have no retrieved way back — so that line is
usually the explanation for a short result.

A way home is sought from **every place a trip could end** — the destinations
stage 1 found and the second cities stage 3 reaches — ranked together by what it
is already known to cost to get there (ADR 0015 §7):

```text
reach cost of a destination   the outbound fare
reach cost of a second city   the outbound fare plus the onward fare
```

The way home itself is never part of that ranking: it is exactly what the query
would find out. Candidates are keyed by the **airport** a return would leave
from, so Fiumicino and Ciampino are two separate questions even though both are
Rome, and a trip ending at one never borrows a fare from the other.

Where a second city still has no retrieved way home, the output says so:

```text
Second cities reachable onward: 4 (3 with no retrieved way home)
```

Alternative origins draw on the **same** budget: three origins over a two-month
window spend 6 calls before any return leg is queried, which leaves room for the
two guaranteed ways home and nothing else.

The 12 is an application-level safety limit of our own, not the provider's
quota, which remains unverified (`docs/provider-compliance.md`).

## Redundant alternatives

Several fares often reach the same place in the same shape, and some of them
are simply worse than another on every axis: no cheaper, no quicker, and no
simpler. Those are removed before accommodation is priced, and the output says
how many:

```text
Redundant alternatives removed: 3 of 11 · 8 distinct
```

**Only truly interchangeable candidates are compared.** A candidate may be
removed only by another to the **same destination**, in the **same trip shape**,
with the **same cost scope** and the **same accommodation completeness**. So a
cheaper trip to Rome never eliminates Milan, a round trip never eliminates a
multi-city trip, and a known cost that omits a sector never eliminates a fully
priced trip by looking cheaper (`docs/decisions/0017-dominance-pruning.md`).

The dimensions are cost, travel time, and changes (`stops + connections`). A
candidate must be no worse on all three and better on at least one; two
candidates that tie are both kept.

**Trip length is deliberately not a dimension.** A five-night trip and a
seven-night trip are different products, not better and worse versions of one —
`--nights` already bounds what is acceptable.

This line is separate from the filtered-out counts, which explain candidates
that were never viable. These were viable and merely redundant.

## Accommodation

Nothing is priced, and the search says so per stay rather than staying silent:

```text
1. Milan → Belgrade (multi-city) — BGY, BEG
   215.72 EUR / person · 431.44 EUR known cost · excludes some accommodation
   Accommodation Milan: not searched — 5 nights · no accommodation provider
   Accommodation Belgrade: not searched — 2 nights · no accommodation provider
   The amount above EXCLUDES accommodation that is not priced
```

Stay dates come from the itinerary itself, not from the requested dates: a stay
begins when the traveler *reaches the city*, so a ride in from a distant airport
delays it, and ends when they leave for their next departure. A night spent
crossing between two cities belongs to neither and is never booked.

When a provider is licensed, only a **finalist shortlist** is priced — pricing
every candidate would be prohibitive. The shortlist takes the cheapest
candidates by transport cost but reserves one slot for each trip shape first, so
a slightly dearer multi-city trip is not crowded out by a run of near-identical
round trips. Identical searches are asked once: five candidates wanting the same
city, dates and party cost one query, not five.

Accommodation has its own provider budget, entirely separate from the 12
transport calls. Candidates whose transport cost already excludes a sector get
no accommodation call at all — they are already incomplete in a way that would
make the comparison misleading — and are kept as secondary results.

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

### Multi-city coverage

Onward legs are found readily. What used to be missing was a way home *from*
them: return legs were once queried only for the destinations stage 1 found, and
the second cities an onward leg reaches are a different set. Measured from Rome
over 26 Dec – 5 Jan 2026: 72 onward destinations, of which exactly **one** was
also a stage-1 destination.

Way-home candidates are now drawn from both (ADR 0015 §7), ranked by what it is
already known to cost to reach them. A second city can take a query a dearer
stage-1 destination would have had, and the output says when it did:

```text
Way home sought from London (LTN) · reached SJJ → BEG → LTN · known reach cost 80.00 EUR · 1 found
Way home sought from Hamburg (HAM) · reached SJJ → BEG → HAM · known reach cost 88.00 EUR · 1 found
```

**Known reach cost is not a trip total.** It is the fares already retrieved to
get there; the way home is exactly what the query would discover, so it is never
guessed at in advance.

Results remain thin, and for a different reason now. Measured 2026-09-20 for
`SJJ`, 5–20 Dec, 5–7 nights, two travelers: 12 of 12 calls, one three-leg
itinerary returned (`SJJ → Bergamo → Belgrade → SJJ`, 5 nights Milan and 2 in
Belgrade), with a further 10 combinations rejected for total nights outside the
requested range. Second cities do now receive way-home queries and do return
fares; whether a given pair also fits the requested dates is a property of the
data.

Enabling `--multi-city` means second cities compete with stage-1 destinations
for the same queries, so fewer of the latter are checked for a way home. That is
the intended trade, and the counts report it.

Coverage is sensitive to the request. `--nights` and `--flex` change how the
travel window is derived, which changes what each query costs and therefore
which places get asked about at all — so two searches over the same dates with
different night ranges can reach entirely different second cities.

