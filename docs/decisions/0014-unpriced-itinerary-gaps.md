# 0014 — Unpriced itinerary gaps

- Status: Accepted
- Date: 2026-09-18

## Context

An open jaw flies into A and home from B. The `A → B` sector is a real part of
the journey, and we have no price for it: Phase 2 established that no rail or
bus source is licence-cleared (`docs/provider-compliance.md`), so unless that
sector happens to be a flight we retrieved, nothing can price it.

Three ways to handle that, two of them wrong:

- **Omit the sector silently.** The itinerary then looks cheaper than any
  complete trip, and a user comparing totals is misled.
- **Estimate it** with the airport-access model (ADR 0011). That model is
  calibrated for a short hop to a city centre; applying it to 250 km of
  intercity travel would produce a number with a plausible face and no basis.
- **Discard the candidate.** This deletes the pattern the product exists to
  find: fly into Vienna, home from Prague, take the train in between.

## Decision

An `A → B` sector we cannot price is recorded as an **itinerary gap**.

### 1. A gap is not a segment

```ts
interface ItineraryGap {
  id: string
  from: Location
  to: Location
  distanceKm?: number
  status: "unpriced"
  reason: "no_licensed_source"
}
```

It carries no departure, no arrival, no duration and no price, because we know
none of them. Modelling it as a segment would require inventing times; modelling
it as an offer would require inventing a price.

What we do know is kept: both endpoints, the distance between them, and why it
is unpriced.

### 2. The total excludes it, and says so

The gap contributes nothing to any amount. The cost scope becomes
`excludes_unpriced_segment`, and the amount is presented as a **known cost**,
never as the trip's total. Output must make the exclusion impossible to miss.

### 3. Such itineraries rank in their own class

A candidate containing an unpriced gap is never ranked as directly comparable
with a fully priced one. Complete itineraries are ordered first, among
themselves by total; gapped itineraries follow, among themselves by known cost.
Comparing the two on the same number would reward the itinerary for the sector
it omits.

### 4. A retrieved `A → B` is not a gap

If the connecting sector is itself a fare we retrieved, it is an ordinary offer
with ordinary provenance, and the itinerary is complete.

### 5. Gaps do not create connections

A pair of segments separated by a gap is not a connection: the traveler is
making their own way between A and B, so minimum connection times (ADR 0012)
do not apply across it. They still apply on either side.

## Consequences

- Three states are now distinct across the system, and must stay so:
  **retrieved** (a provider's price), **estimated** (a modelled price, ADR
  0011), and **unpriced** (no source, excluded).
  **Unknown price is not zero price and is not an estimate.**
- `TripCost` reports `exclusions`, so "excludes a sector" and "excludes
  accommodation" remain separable reasons a number is not complete.
- Trip validation gains a rule: consecutive segments that do not share a
  location must be explained by a ground transfer or a declared gap. An
  unexplained discontinuity is now an error rather than something no one
  noticed.
- Open-jaw pairs are limited to a configurable distance
  (`maxUnpricedGapKm`, default 800 km) so the gap stays a journey a traveler
  could plausibly arrange. Beyond it, the pairing is not offered at all rather
  than offered with a caveat.
- When a licensed rail or bus source clears, those sectors become ordinary
  priced segments and the gap disappears without any change to the optimizer.
