# 0018 — One-way trips

- Status: Accepted
- Date: 2026-09-21
- Resolves the open item in `docs/decisions/0005-trip-metrics-and-accommodation-coverage.md`

## Context

The product goal lists one-way trips among the shapes the system must support,
but they were unreachable: `resolveTravelWindow` rejected any request without a
return date, and the CLI required `--to`.

The reason was not an oversight. ADR 0005 recorded it precisely:

> a trip whose last segment does not return to the origin has no closing
> departure, so nights after the final arrival are outside the model. Such trips
> cannot carry a stay after that arrival yet. To be decided before one-way trips
> are generated.

Time on the ground was derived **only** between consecutive segments. A round
trip's final departure bounds its last stay; a one-way has nothing in that
position. So a one-way could reach a city and then, as far as the model was
concerned, cease to exist — no nights, no accommodation, no trip end.

## Decision

### 1. The trip end is declared, never invented

A one-way request carries an explicit `endDate`: the checkout boundary.

```text
round trip   departureDate -> returnDate
one-way      departureDate -> endDate
```

`returnDate` and `endDate` are **mutually exclusive**. They answer the same
question for different trip shapes, and accepting both would leave two answers
to when the trip ends. A request with both is refused rather than one silently
winning.

**No fictional return segment is created.** A one-way itinerary has one
transport path and a final arrival. Inventing a closing leg to satisfy the
model would put a journey in the itinerary that the traveler is not taking —
the same fabrication the unpriced-gap rules exist to prevent (ADR 0014).

### 2. The candidate carries its own end

`TripCandidate` gains an optional `endsAt`. This is the whole structural change,
and it is what makes the rest follow.

Validation takes only the candidate — `validateTripCandidate(trip)` has no
access to the request — so an end boundary living only in the request could
never be checked. With `endsAt` on the candidate, `groundGaps` gains one final
period, `[last arrival, endsAt]`, and everything downstream works unchanged:
`nightsInGap`, `nightIsCovered`, `validateStays`, `uncoveredNights`,
`deriveStayIntervals` and accommodation coverage all operate on the periods
`groundGaps` produces, whatever produced them.

`endsAt` is absent on every round trip, open jaw and multi-city trip, which are
bounded by their own last departure. Their behaviour is unchanged.

### 3. A trip that ends is not a trip that returns

`TripSummary.returnDate` becomes optional and is **absent** for a one-way. It is
never filled with the outbound departure: that would report a trip as returning
on the day it left.

A new `tripEndDate` is always present — the final departure for a round trip,
the declared end for a one-way — so the trip's actual end is available whatever
its shape, and separately from its departure.

### 4. The declared end is a hard ceiling, never flexed

`--flex` widens the departure as it always has. It does **not** widen `endDate`.

Flexing it later would book nights past the boundary the traveler set; flexing
it earlier would check out before the date they asked for. The end is the one
date in a one-way request that is not a preference.

A departure flexed past the end is clamped to it: a departure after the trip
ends is not a trip.

### 5. Accommodation runs from the final arrival to the end

The final stay's check-in is when the traveler **reaches the city** — after the
access transfer, if the airport is far out — and its checkout is `endDate`
exactly. Nights are counted by the existing machinery, so a distant airport
still shortens the stay rather than being ignored.

### 6. A one-way asks fewer questions

There is no way home to look for, so the discovery funnel's return and onward
stages do not run: stage 1's fares are already whole itineraries. The provider
query omits `returnDates`, which the Aviasales adapter already reads as a
one-way search — no provider change was needed.

Only the ride **out** to an alternative origin applies; pairing it with a
journey home from an arrival that never happens would invent a leg.

## Consequences

- One-way candidates are single-leg. The model is general — N legs ending at a
  declared boundary — so a multi-leg one-way would fall out of the same code if
  composition later produced one. None is generated now.
- `--one-way <date>` implies `--compose`: a one-way itinerary *is* a one-way
  fare, and the provider's round-trip fares cannot express one.
- `WINDOW_ENDS_BEFORE_DEPARTURE` was written and then removed as unreachable:
  the request model already rejects `departureDate > endDate`, and flexing only
  moves the earliest departure earlier.
- ADR 0005's known limitation is resolved. Its stay-validation rule now reads:
  time on the ground is bounded by the next departure, **or by the trip's
  declared end**.
- Accommodation for a one-way is still `not_searched / no_provider`, as for
  every other shape: this phase added no provider (ADR 0016).
