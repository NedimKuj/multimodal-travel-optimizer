# 0006 — Aviasales Data API semantics

- Status: Accepted
- Date: 2026-09-18

## Context

Phase 0 probed the Flights Data API live (21 calls, all HTTP 200). The observed
behaviour is recorded in `docs/phase-0-aviasales-findings.md`. Several mapping
decisions follow from it, and each one risks either fabricating data or
mislabelling it, so they are fixed here rather than left to the adapter.

## Decisions

### 1. Discovery only, always `cached`

v3 `prices_for_dates` records carry no `expires_at` and no observation
timestamp. Every offer from this adapter is `sourceType: "cached"`, with
`fetchedAt` set to our request time and **no `expiresAt`**.

An absent `expiresAt` means **the provider supplied no expiry, so freshness is
unknown**. It must never be read as "this price does not expire": these are
cached fares that can go stale at any moment. `priceFreshness` reports
`unknown` for them, and no price from this provider may be presented as live or
bookable; that requires the separate verification stage.

### 2. One record with `return_at` is one offer over two segments

A round-trip record is a single fare covering an outbound and a return flight.
It maps to one `TransportOffer` whose `segmentIds` list both segments. The fare
is never divided between them (ADR 0002).

### 3. Arrival times are derived, and the derivation is recorded

The API returns no arrival time. Arrival is computed as
`departure_at + duration_to` (return: `return_at + duration_back`). This is an
inference from provider data, not an observation. A record without a usable
duration is **dropped as a data-quality failure**, never completed by guessing.

### 4. Prices are per traveler

The API has no passenger parameter and its search links carry a passenger count
of 1. Offers are therefore `priceBasis: { kind: "perTraveler" }`. This is
inferred from observed behaviour, not from documentation; it must be re-checked
when booking links are verified, and it is listed in
`docs/provider-compliance.md` as an open question.

### 5. Segments use airport codes, not city codes

`origin`/`destination` are city codes (`ROM`), while
`origin_airport`/`destination_airport` are the actual airports (`FCO`).
Segments are built from the airport fields, resolved through the
`AirportRepository` (ADR 0007). An unresolvable code drops the record.

### 6. A provider offset conflicting with the airport's zone drops the record

`departure_at` is local at the origin airport and `return_at` is local at the
destination. Both are validated against the airport's IANA zone in the
reference data. One record in 415 conflicted (`CIT` at `+06:00`, where
`Asia/Almaty` resolves to UTC+5 at that instant).

We do not determine which source is correct. Where the provider-supplied offset
and the authoritative airport time zone disagree, the record is **rejected and
counted**, because silently preferring either one would corrupt connection
validation.

### 7. Discovery is month-granular, with `unique=true`

Exact-date queries return almost nothing (1 record for 2026-12-26), while month
queries with `unique=true` return 48 destinations. The adapter therefore queries
by month and filters to the requested dates locally. This also serves API
economics: one call per month covers a whole flexibility window.

### 8. No open-jaw from this API

A query has one origin/destination pair. Open-jaw itineraries are composed by
the optimizer from separate one-way queries, each with its own offer. The
real-time Flight Search API is not used (`docs/provider-compliance.md`).

### 9. Booking links require a marker

`link` is a relative path (`/search/SJJ3012IST08011?…`). An absolute booking URL
is emitted **only** when an affiliate marker is configured; otherwise the offer
carries no `bookingUrl` rather than an unattributed one.

## Consequences

- `docs/implementation-plan.md` §20's "100–500 candidate destinations" from SJJ
  is not achievable with this provider; expect tens. The funnel still applies,
  but coverage, not pruning, is the binding constraint at Stage 1.
- Every candidate built purely from this data is `cached` end to end, so the
  weakest-source rule (ADR 0004) makes whole trips `cached` until verification
  exists.
- Dropped records must surface as structured failures in the provider result,
  so a thin result is visibly thin rather than quietly wrong.
