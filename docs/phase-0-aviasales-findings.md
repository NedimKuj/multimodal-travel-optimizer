# Phase 0 findings — Aviasales Flights Data API

Observed on **2026-09-18** from this repository, using the probe in
`packages/providers/src/aviasales/probe.ts` (21 live calls over two rounds, all
HTTP 200). Raw captures are in the gitignored `.probe/` directory.

Everything below is what the API **actually returned**, not what documentation
claims. The public documentation could not be read: the Travelpayouts support
article returns 403 to automated requests and the endpoint returns 401 without a
token, which is why the schemas are derived from observation.

---

## 1. Response envelope

Every endpoint returns:

```json
{ "success": true, "data": ..., "currency": "eur" }
```

`data` is an array (v3 `prices_for_dates`, `get_latest_prices`) or an object
keyed by date (`grouped_prices`) or by destination (`v1/city-directions`).

## 2. `aviasales/v3/prices_for_dates` — the record we normalize

Exact field list observed (one-way query):

```text
origin, destination                 city codes (e.g. SJJ, ROM)
origin_airport, destination_airport airport codes (e.g. SJJ, FCO)
departure_at                        local time with UTC offset at the origin
airline, flight_number
price                               number, in the requested currency
gate                                booking agency name (Kiwi.com, Clickavia, …)
duration, duration_to, duration_back  minutes
transfers, return_transfers
link                                relative Aviasales search path
```

A round-trip query (`one_way=false`) adds **`return_at`**, the return
departure in **local time at the destination**, and `duration_back` becomes
non-zero. `duration` is the sum of both directions.

Example (round trip, 2026-12-30 → 2027-01-08, SJJ↔IST, €79):

```json
{
  "departure_at": "2026-12-30T13:50:00+01:00",
  "return_at": "2027-01-08T12:45:00+03:00",
  "duration": 240, "duration_to": 115, "duration_back": 125,
  "transfers": 0, "return_transfers": 0,
  "origin_airport": "SJJ", "destination_airport": "SAW", "price": 79
}
```

**One record with `return_at` is a single price covering two flights.** This is
exactly the case ADR 0002 separates: it becomes one `TransportOffer` over two
`TransportSegment`s, and the fare is never split per leg.

### What is missing

- **No arrival times.** Arrival is **derived**, never presented as
  provider-reported: the absolute departure instant plus the elapsed duration
  (`duration_to`, and `duration_back` for the return), resolved in the
  destination airport's time zone. It is an inference, recorded as such in
  ADR 0006.
- **No `expires_at`** on v3 records, and no observation timestamp. `fetchedAt`
  is our own request time and `expiresAt` stays unset, which means **the
  provider supplied no expiry, so freshness is unknown** — not that the price
  never expires.
- **No passenger parameter**, so the price cannot be for a party. The generated
  search links end in a passenger count of 1 (`/search/SJJ3012IST08011`), which
  is strong but not contractual evidence that the price is per adult passenger.

## 3. Destination coverage from SJJ — the important result

| Query | Records | Distinct destinations |
|---|---|---|
| Exact date `departure_at=2026-12-26`, one-way | 1 | 1 |
| Exact date, round trip (`return_at=2027-01-02`) | 0 | 0 |
| Month `2026-12`, one-way, `limit=1000` | 30 | 7 |
| Month `2026-12`, one-way, **`unique=true`** | 48 | 48 |
| Month `2026-12` → `2027-01`, round trip | 35 | 15 |
| Month `2027-01` / `2027-03`, one-way | 26 / 25 | 14 / 9 |
| `grouped_prices` (by departure date) | 213 | 34 |
| `get_latest_prices`, round trip, `limit=100` | 100 | 13 |
| `v1/city-directions` | 30 | 30 |

Union across every probe: **73 distinct destination airports**.

Three consequences for the optimizer:

1. **`docs/implementation-plan.md` §20 Stage 1 expects "100–500 candidate
   destinations". That is not available from SJJ.** The realistic figure is a
   few dozen per month. The funnel still works, but it starts narrower, and
   pruning matters less than coverage does.
2. **Exact-date queries are nearly empty** (1 record for 2026-12-26, unchanged
   with `market=gb` and `limit=100`). Date flexibility cannot be implemented by
   querying each date in the window. It must query **month granularity** and
   filter locally by `departure_at`.
3. **`unique=true` is what produces breadth** (48 vs 7 destinations). Without
   it, the API returns the cheapest records per date, repeating destinations.

## 4. Open-jaw

The Data API takes a single origin/destination pair, and `return_at` belongs to
that same pair. **It cannot express an open jaw.** Open-jaw itineraries must be
composed by us from separate one-way queries (`SJJ→A`, `B→SJJ`), which is what
the domain model already supports: two offers, each covering its own segment.

The real-time Flight Search API does support multi-segment searches, but it
requires a marker, a signature and carries conversion obligations
(`docs/provider-compliance.md`). It is **not** used.

## 5. Time zones — the strict check pays off

Across 415 collected records, resolved against the airport snapshot:

```text
unknown origin airport:       0
unknown destination airport:  0
non-integer price:            0
missing duration:             0
offset conflicts with zone:   1
```

The single conflict is a genuine data disagreement, not a bug in our
validation: `CIT` (Shymkent) was returned as `2027-01-10T22:25:00+06:00`, while
`Asia/Almaty` in the reference data resolves to UTC+5 at that instant.

We do not adjudicate which source is right. Such records are rejected as a
data-quality failure and counted, rather than silently re-interpreted, because
picking either side would corrupt connection validation.

## 6. Other endpoints worth keeping in mind

- **`v1/city-directions`** — 30 destinations, each a round-trip pair, and it is
  the only endpoint observed to carry **`expires_at`**. Useful for discovery
  when the dates are flexible, but the dates are whatever was cheapest, not a
  requested window.
- **`v1/prices/cheap`** — carries `expires_at` too, keyed destination → index.
- **`v3/get_latest_prices`** — different shape (`depart_date`, `return_date`,
  `value`, `number_of_changes`, `found_at`, `distance`, `actual`). `found_at`
  is a real observation timestamp, which is better provenance than v3
  `prices_for_dates` offers.
- **`v3/grouped_prices`** — same record shape as `prices_for_dates`, grouped by
  date; a cheap way to see a month at a glance.

## 7. `get_latest_prices` — investigated, not adopted

Probed again on 2026-09-18 while designing Phase 1, to decide whether its
`found_at` timestamp and coverage make it a better discovery source.

| Query | Records | Destinations | All with return |
|---|---|---|---|
| `period_type=year`, `one_way=false`, `limit=1000` | 100 | 13 | yes |
| `period_type=month`, `beginning_of_period=2026-12-01` | 51 | 19 | yes |

The month form honours the period: departures stayed inside December. One call.

**What it offers over `prices_for_dates`:** a real observation timestamp
(`found_at`, spanning roughly the previous week in this sample), an `actual`
flag, `distance`, and slightly wider destination coverage.

**What it lacks, and why that is disqualifying for building candidates:**

```text
origin_airport / destination_airport   absent — city codes only (SJJ → IST)
airline, flight_number                 absent
link                                   absent — no booking or verification URL
duration_to / duration_back            absent — only a single total duration
transfers                              only number_of_changes, whole trip
```

Without airport identity we cannot tell SAW from IST, and without per-direction
durations we cannot derive either arrival time. Building a segment from this
record would mean inventing both. So it is **not used in Phase 1**.

It remains a plausible **discovery hint** for a later phase: one cheap call to
learn which routes are currently cheap, followed by targeted
`prices_for_dates` calls that produce real segments. That is a Phase 2+
decision, not an assumption Phase 1 relies on.

## 8. Not established by this probe

Two things the adapter depends on that the probe did **not** test:

- **Only `currency=eur` was ever requested.** Whether the API honours other
  currencies is unknown. The adapter refuses a response whose currency differs
  from the request (rather than mislabelling money), so if the API silently
  answers in EUR for a `bam` request, that search fails outright. Worth probing
  before any non-EUR search is offered.
- **A query carries one departure month and one return month.** A return window
  spanning two months therefore needs one call per month pair; the adapter plans
  them and drops impossible pairs (return before departure).

## 9. Verdict

The Data API **is** a usable discovery layer for cached fares, with three firm
limits: coverage is tens of destinations rather than hundreds, useful queries
are month-granular rather than per-date, and prices carry no expiry so they can
only ever be labelled `cached`. Anything presented to a user as bookable will
need the live verification stage (Phase 6) regardless.

Nothing here confirms commercial permission. See `docs/provider-compliance.md`,
which still lists the terms as unverified.
