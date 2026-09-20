# 0016 — Accommodation coverage and the finalist shortlist

- Status: Accepted
- Date: 2026-09-20

## Context

Every cost the optimizer produces is transport only. Attaching accommodation is
what turns a fare comparison into the complete-trip comparison this product
exists to make — but it forces four questions that have honest answers and
tempting dishonest ones.

1. An open jaw arrives in one city and departs from another, with an unpriced
   sector between them that carries no times. How many nights belong to each?
2. Searching accommodation for every transport candidate is prohibitive. Which
   candidates are worth a call?
3. Not every search returns a price. What does a trip cost then?
4. Accommodation is a different provider with different economics. Whose budget
   pays for it?

The tempting answers — split the nights evenly, price the cheapest N, treat a
missing price as zero, share the transport budget — each produce a number that
looks like a total and is not one.

## Decision

### 1. Accommodation is modelled per stay

A trip has one accommodation stay per period on the ground, not a trip-level
price. A multi-city trip has several independent stays.

The intervals are **not new**: they are the `StayBoundary` list
`assembleCandidate` already builds, one per junction between consecutive legs,
with `reached`/`left` already accounting for access transfers. A late arrival
therefore cannot book a night the traveler cannot use, and nothing needs to be
recomputed.

A night belonging to a transport gap is assigned to neither adjacent city.

### 2. Four coverage states

```text
priced        a query ran and returned at least one usable offer
not_searched  no accommodation query was performed
unpriced      a query was attempted; no usable price was obtained
unresolved    no valid search can be constructed at all
```

The state is primary; a reason explains it without replacing it.

`not_searched` claims only that no query ran — being outside the shortlist and
having no provider configured are both "we did not ask", and the reason
separates them. It does not assert that skipping was deliberate.

`unpriced` keeps `provider_no_results` apart from `provider_unavailable`.
**A failed call is not zero availability.** In neither case do we hold a price,
so both are `unpriced` — but "this city is full" and "we could not reach the
provider" are different facts about the world, and collapsing them would let an
outage read as an answer.

Only `priced` contributes an amount. This is the same invariant that governs
fares and gaps: **unknown ≠ zero ≠ estimated** (ADR 0014).

### 3. The open-jaw split is never invented

For `SJJ → A`, `B → SJJ` with `A → B` unpriced, the optimizer cannot determine
how many nights belong to A and how many to B, because the sector that would
say so has no times. It must not split the nights arbitrarily, attribute them
all to one city, or interrupt an automated search to ask.

The stay is `unresolved`, names **every city it spans**, and contributes no
amount. It is reported separately from the unpriced-transport-gap exclusion,
because they are different holes:

```text
Cost scope: excludes unpriced transport + unresolved accommodation
```

When a licensed rail or bus source later supplies the `A → B` timing, the
ordinary stay-splitting rules resolve this with no change to the domain model.

### 4. The type system enforces the states

`AccommodationStay` is a Zod discriminated union on `state`, matching how every
other domain type is defined. Two invariants are structural, not conventional:

- an `unresolved` stay carries `cities` (at least two) and **no** singular
  `city`, so the model cannot express the guess decision 3 forbids;
- a `priced` stay cannot exist without a priced `Stay`, so an absent price
  cannot be summed as zero.

A union with an optional `price` would permit both mistakes.

`Stay` itself is unchanged: it remains the priced thing, with `price` and
`provenance` required, so existing stay validation is untouched.

### 5. The finalist shortlist reserves before it fills

```text
eligible → rank → reserve one per eligible pattern → fill globally
         → dedupe stay searches → search → attach → rank by class
```

Eligibility requires a transport-valid candidate with a complete transport cost,
no unpriced sector, and every stay resolvable.

Reserving before filling matters: an approach that takes the top N and then
swaps in missing patterns can evict a pattern it just guaranteed, and its result
depends on the order patterns are iterated in. Reserving first evicts nothing.

The four transport patterns are **mutually exclusive** — the classification is a
total function of two independent booleans (more than one stay; any unpriced
gap) — so one candidate reserves at most one slot and the reserved set cannot
contain a duplicate.

Whenever the shortlist is at least as large as the number of eligible patterns,
every eligible pattern is represented. Below that, the patterns dropped are
recorded rather than silently lost.

Destination diversity is deliberately not guaranteed: it is secondary to
transport cost, and stratifying by `pattern × destination` would multiply calls.

### 6. Gapped candidates get no accommodation call

A candidate whose transport cost already excludes a sector is incomplete in a
way that makes accommodation ranking misleading, so no call is spent on it by
default — and it is not made eligible merely to fill a pattern slot. Such
candidates are preserved with their exclusions and provenance intact, as
secondary results.

### 7. Accommodation has its own budget

Configurable, and wholly independent of the 12-call transport budget (ADR 0015):
a different source with different quotas. The transport budget is never read or
increased to pay for accommodation. Identical searches — city, dates, occupancy,
currency — are deduplicated across the shortlist, so five candidates sharing one
stay cost one query.

### 8. Ranking is by class, then amount

`comparisonClass` widens from two classes to three; `compareCandidates` is
unchanged:

```text
0  complete                    transport and accommodation both fully priced
1  accommodation incomplete    a stay is unpriced, unresolved or not searched
2  unpriced transport sector   a leg has no price
```

A cheaper known cost never outranks a fuller one. `not_searched` and `unpriced`
share a class because in neither case do we hold the price; their states and
reasons carry the difference.

No new arithmetic is needed for "known cost only": the total already sums priced
components exclusively, so a trip with one stay priced and another unpriced
contributes just the priced stay.

## Consequences

- Ranking after accommodation may differ substantially from the transport
  ranking that built the shortlist. This is expected and documented.
- Every open jaw carries an unpriced sector while no licensed surface transport
  source exists, so `open_jaw` and `multi_city_open_jaw` are currently
  ineligible for the pattern floor, which operates over `round_trip` and
  `multi_city` alone. No coverage is manufactured to change that.
- With no provider configured, every candidate is `not_searched / no_provider`
  and lands in class 1 together, so the relative order of transport candidates
  is exactly what it was before this phase. Nothing is promoted to complete and
  no zero is added.
- Accommodation coverage is reported for every candidate whether or not a
  provider exists, because the need for a bed is a property of the trip rather
  than of our configuration. This adds a field to the serialized trace; no
  byte-for-byte output contract exists, and the regression guarantee is
  behavioural.
- Still open (ADR 0005): a trip whose last segment does not return to the origin
  has no closing departure, so nights after the final arrival fall outside the
  ground-time model and cannot carry a stay. Must be settled before one-way
  itineraries are generated.
