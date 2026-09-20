# 0015 — Multi-city composition

- Status: Accepted
- Date: 2026-09-19

## Context

Phase 3 composes two one-way fares into a round trip or an open jaw. Multi-city
adds a third leg — `SJJ → A → B → SJJ`, and its open-jaw tail `SJJ → A → B`,
`C → SJJ` — which forces three questions Phase 3 never had to answer:

1. A third leg needs a third query. Return legs and onward legs now compete for
   one budget of 12 provider calls.
2. A trip with two stays has two places the traveler sleeps, so "nights" stops
   being a single number.
3. Two stays mean two airports that may be far from their cities, and the
   existing transfer code assumes exactly one.

The third question exposed a latent bug. `buildAccessTransfers` derives both
transfers from the **arrival** airport, then anchors the second to the inbound
departure. For a round trip that is right. For an open jaw it produces "bus into
A's town, bus back to A's airport, then teleport to B." It never surfaced live
only because Dalaman's airport is close to its town.

## Decision

### 1. Budget: minimum return coverage first, then alternate

The first **2 return-leg query units** are guaranteed, then the allocator
alternates `return → onward → return → onward` until the budget is exhausted.

An itinerary with no way home does not exist, while an itinerary with no onward
leg is simply a shorter trip — so returns earn the floor. Alternating afterwards
adapts to how many candidates each stage actually has; a fixed proportion (60/40
or any other) would starve whichever stage happened to have more.

The guarantee binds **onward discovery**, not the global budget. Three origins
over a two-month window already cost 6 calls, and two guaranteed return units at
2 calls each make 10. Where the budget cannot cover the guarantee, the search
proceeds with fewer returns rather than exceeding 12.

A **logical query** costs one provider call per calendar month its range spans,
because this provider is queried at month granularity (ADR 0006). The budget is
counted in provider calls, and the 12 remains an application-level safety limit
of ours, not the provider's quota, which is still unverified
(`docs/provider-compliance.md`).

Every query that could not run is recorded with its stage and reason. Exhausting
the budget never fails a search: the candidates already found are returned.

### 2. Transfers attach per stay

Each stay gets its own transfers, derived from the airport the traveler actually
arrives at and the airport they actually leave from:

```text
arrive A_apt → A_city        when A_apt is beyond the access threshold
A_city       → A_apt'        before the next departure, from that stay's airport
```

For a round trip this is identical to Phase 3's behaviour. For an open jaw it is
the fix: the gap now runs `A city → B city`, which is where the traveler is.

### 3. Gaps are derived during assembly

Phase 3 built the gap in `composeItineraries`, before assembly, and applied the
plausibility ceiling there. With per-stay transfers that is no longer possible —
whether a gap runs `A_apt→B_apt`, `A_city→B_apt`, `A_apt→B_city` or
`A_city→B_city` depends on which sides cleared the access threshold and which
city lookups resolved, all decided inside assembly.

Assembly therefore derives a gap at every junction where consecutive legs do not
share a location, and applies the ceiling to **that same distance** — the one
reported to the user. Composition passes policy (`allowOpenJaw`,
`maxUnpricedGapKm`) rather than a prebuilt gap.

An **asymmetric gap is correct** where the geography is asymmetric. An arrival
airport far from its city paired with a departure airport inside one yields
`A city → B airport`, and forcing symmetry would misstate the journey.

### 4. At least one night per city

Every intermediate city requires at least one night, configurable. A city passed
through in an afternoon is a connection, governed by ADR 0012, not a
destination — and a "multi-city trip" that never stops in the middle city is a
one-stop flight described dishonestly.

### 5. Nights are a metric, not a stay

Nights are counted per stay, the total still satisfies `[minNights, maxNights]`,
and each stay satisfies the per-city minimum.

`TripCandidate.stays` stays **empty**. A night we cannot price is not
accommodation: populating `stays` would move accommodation coverage off zero
(ADR 0005) and make a transport-only cost look like a complete-trip cost, when
accommodation is blocked on provider credentials entirely.

### 6. Temporal chaining is validated before assembly

Assembly sorts every segment by instant. A set of legs that is temporally out of
order therefore sorts into a spatially broken chain and is rejected as an
unexplained discontinuity — a reason that tells the user nothing. Three legs have
two junctions, so each consecutive pair is validated first and rejected with its
own counter, exactly as `rejectedReturnBeforeArrival` already does for two.

### 7. Mixed return-candidate discovery

Return legs were queried only for the destinations stage 1 found. That
structurally prevented most multi-city itineraries from ever completing:
measured 2026-09-19 from Sarajevo, of 72 onward destinations from Rome exactly
one was also a stage-1 destination, and it was not among the cheapest few that
composition keeps. A second city could be reached and never asked about.

A way home is therefore wanted from **every place an itinerary could end**. One
pool holds both, ranked together.

**Keyed by the return airport, not the city.** `FCO -> SJJ` and `CIA -> SJJ` are
different commercial searches, and an itinerary ending at Ciampino must not
quietly acquire a fare leaving from Fiumicino because both are called Rome. Both
airports may enter the pool and each consumes its own query if selected; they
remain grouped under one destination city for presentation (ADR 0010). Airports
enter only from real candidate paths, never by enumerating a city's airports,
and the budget caps how many are actually asked about.

Should a licensed ground link between two airports of one city ever clear, the
itinerary `CIA -> Rome -> FCO -> SJJ` is built explicitly as legs and a
transfer, rather than hidden inside a city-level deduplication.

**Ranked by known reach cost**, the fares already retrieved:

```text
reachCost(A) = outboundFare(SJJ -> A)                        stage 1
reachCost(B) = outboundFare(SJJ -> A) + onwardFare(A -> B)   second city
```

The `B -> SJJ` fare is precisely what the query would discover, so it can play
no part in deciding whether to make it, and is never estimated in its place.
Ties break on reach cost, then leg count (a direct destination ahead of one
reached through another city), then city, then airport: a total order, so a run
repeats exactly.

Where several paths reach the same airport, the cheapest is kept with its own
provenance. An airport is decided once — never queried twice, and never
re-queued after the budget has already refused it.

**Only the onward legs composition will pair are admitted.** Discovery and
composition share one selection (`one-way-legs.ts`), so a provider call is never
spent on a second city the optimizer then prunes. Because every onward leg from
one airport shares the same already-known `SJJ -> A` cost, ranking those legs by
fare is identical to ranking them by reach cost, so the cap does not distort the
order.

**Onward discovery still starts only from stage-1 destinations.** That fixes the
depth of a trip at `SJJ -> A -> B -> SJJ` rather than opening an unconstrained
traversal; a deeper search is a separate phase with its own budget model.

This changes **which candidates are selected**, not how the budget is allocated.
The two-query floor and the `return -> onward -> return -> onward` alternation
are untouched. One consequence follows from the pool being fed as the search
runs: an onward query refills it, so the alternation ends when a whole round
runs nothing, rather than when the pool happens to be empty.

## Consequences

- `assembleCandidate` takes N legs. Two-leg callers are unchanged, so provider
  round trips (ADR 0008) and Phase 3 composition keep their behaviour apart from
  the transfer fix.
- `evaluateTrip` takes a list of stays instead of one ground interval, and a
  candidate carries a nights breakdown rather than a single number.
- Skipped queries are reported in one vocabulary, shared by origin expansion,
  return enrichment and onward discovery, so one condition is never named twice.
- Onward discovery is opt-in (`--multi-city`). A search that skips anything
  reports `partial`, and there will always be more cities than budget, so
  enabling it by default would degrade the status of every search.
- Ranking is unchanged: a multi-city itinerary with a gap still ranks below a
  complete one, in the class ADR 0014 established.
- A way-home query now carries its provenance — the city, the path that reached
  it, its known reach cost and whether stage 1 or onward discovery found it — so
  the output can say why a call was spent where it was.
- Second cities and stage-1 destinations compete for the same queries, so
  enabling multi-city can mean fewer stage-1 destinations are checked for a way
  home. That is the intended trade, and the counts report it.
