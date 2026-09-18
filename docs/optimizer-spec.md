# Travel Optimizer Specification

## 1. Purpose

The optimizer finds complete, feasible, cost-aware travel itineraries rather than optimizing individual transport tickets.

A result is a complete trip consisting of:

- origin
- one or more destinations
- transport between locations
- dates
- accommodation
- total cost
- travel time
- transfers
- price provenance
- verification or booking links where available

The optimizer must consider the trip as a whole.

It must not assume that a traditional round trip is always optimal.

---

## 2. Core Principle

The optimization unit is the **complete trip**, not an individual ticket.

For example, all of the following are valid candidate structures:

```text
SJJ → VIE → SJJ
```

```text
SJJ → VIE → PRG → SJJ
```

```text
SJJ → VIE
PRG → SJJ
```

```text
SJJ → FMM → MUC → SZG → SJJ
```

The optimizer must be capable of discovering open-jaw and multi-city structures when they satisfy the user's constraints.

---

## 3. Domain Model

The core domain consists of:

```text
Location
TransportSegment
Stay
TripLeg
TripCandidate
SearchRequest
Money
```

### Location

A location can represent:

- city
- airport
- railway station

Minimum information:

```ts
interface Location {
  id: string
  type: "city" | "airport" | "station"
  name: string
  countryCode: string
  latitude: number
  longitude: number
  timeZone: string // IANA, e.g. "Europe/Sarajevo"
  iata?: string
}
```

`timeZone` is required so that local dates can be derived correctly
(see `docs/decisions/0003-zoned-timestamps.md`).

The domain must not depend directly on provider-specific location types.

---

## 4. Transport

Transport modes initially supported:

```text
flight
train
bus
```

Transport is modeled as two separate concepts (see
`docs/decisions/0002-separate-transport-offers-from-segments.md`):

- a **segment** is a physical movement and carries no price
- an **offer** is a commercial fare covering one or more segments

A normalized transport segment contains at minimum:

```ts
interface TransportSegment {
  id: string
  mode: "flight" | "train" | "bus"

  origin: Location
  destination: Location

  departureAt: ZonedTimestamp
  arrivalAt: ZonedTimestamp

  durationMinutes: number
  transfers: number

  provider: string
  providerReference?: string
}
```

A normalized transport offer contains at minimum:

```ts
interface TransportOffer {
  id: string

  segmentIds: string[] // one or more, chronological

  price: Money
  priceBasis: { kind: "perTraveler" } | { kind: "total"; travelers: number }

  provenance: PriceProvenance

  bookingUrl?: string
}

interface PriceProvenance {
  provider: string
  providerReference?: string
  sourceType: "cached" | "recent" | "live" | "estimated"
  fetchedAt: string  // ISO-8601 UTC instant
  expiresAt?: string // ISO-8601 UTC instant
}
```

A total price quoted for one party size must not be rescaled to another.

Rules:

- a segment may exist without an offer (for example timetable-only rail data)
- a single fare covering multiple segments is one offer with one price
- never split a multi-segment fare into artificial per-segment prices
- trip cost is computed from selected offers, never from segments
- every segment of a fully priced trip is covered by exactly one selected offer

Provider-specific response models must be normalized before entering the optimizer.

---

## 5. Money

Money must never be represented as an unqualified floating-point number.

Use:

```ts
interface Money {
  amountMinor: number
  currency: string
}
```

Example:

```text
EUR 123.45
```

becomes:

```text
{
  amountMinor: 12345,
  currency: "EUR"
}
```

Rules:

- never use floating-point arithmetic for monetary calculations
- never compare amounts in different currencies without conversion
- currency conversion must be explicit
- retain the original provider currency where useful for provenance
- final displayed totals must identify the currency

---

## 6. Time

All transport timestamps represent absolute instants.

They must retain the relevant local timezone.

Never compare naive local date/time strings.

Connection validation must operate on actual instants.

Local departure and arrival dates are used for itinerary presentation and stay allocation.

Representation (see `docs/decisions/0003-zoned-timestamps.md`):

```ts
interface ZonedTimestamp {
  instant: string  // ISO-8601 UTC
  timeZone: string // IANA zone
}
```

A UTC offset alone is not a time zone. Transport `departureAt`/`arrivalAt` are
`ZonedTimestamp`s. Timestamps without an explicit offset must be rejected at the
provider boundary. Calendar dates without time use `YYYY-MM-DD` local dates.

Example:

```text
SJJ departure: 2026-12-26T22:30+01:00
VIE arrival:   2026-12-26T23:35+01:00
```

The implementation must correctly handle:

- timezone differences
- daylight saving changes
- overnight journeys
- journeys crossing midnight
- journeys crossing calendar years

---

## 7. Search Request

A search request may contain:

```ts
interface SearchRequest {
  origin: string
  destination?: string | null

  departureDate?: string
  returnDate?: string

  flexibilityDays?: number

  minNights?: number
  maxNights?: number

  travelers: number

  budget?:
    | { kind: "total"; amount: Money }
    | { kind: "perPerson"; amount: Money }

  transportModes: Array<"flight" | "train" | "bus">

  allowOpenJaw: boolean
  allowMultiCity: boolean

  alternativeAirports?: boolean
}
```

The exact public API may evolve, but the optimizer must preserve these concepts.

The budget is a tagged union so that total and per-person budgets can never be
confused or both be set (see `docs/decisions/0004-trip-candidate-and-budget-shape.md`).

---

## 8. Date Flexibility

If the user specifies:

```text
December 26 → January 3
±2 days
```

the optimizer may evaluate dates within the permitted flexibility window.

The window's meaning depends on whether a nights range is given
(`docs/decisions/0009-date-flexibility-semantics.md`):

**With a nights range — travel window plus duration.** The dates bound the
period the traveler could be away:

```text
window = [departureDate - flexibilityDays, returnDate + flexibilityDays]
valid:   departs on or after window.from
         returns on or before window.to
         nights within [minNights, maxNights]
```

**Without a nights range — anchored dates.** Each date carries its own
tolerance:

```text
departure ∈ [departureDate ± flexibilityDays]
return    ∈ [returnDate    ± flexibilityDays]
```

A window that cannot contain `minNights` is an explicit issue on the request,
not a search that silently returns nothing.

It must not silently expand beyond the user's requested range.

If a result is outside the requested date constraints, it must not be presented as a normal valid result.

Potential future behavior may expose "near matches", but these must be explicitly labeled.

---

## 9. Nights

For a trip with multiple destinations, nights belong to destinations/stays rather than individual transport segments.

Example:

```text
Dec 26: SJJ → VIE
Dec 26–29: Vienna
Dec 29: VIE → PRG
Dec 29–Jan 2: Prague
Jan 2: PRG → SJJ
```

The optimizer must ensure:

- every night on the ground is either covered by a stay or reported as an
  uncovered night (see
  `docs/decisions/0005-trip-metrics-and-accommodation-coverage.md`); a trip with
  uncovered nights must not be presented as a complete-trip cost
- accommodation dates align with the transport itinerary
- no accommodation is booked after the traveler has departed
- no destination stay overlaps another stay incorrectly

---

## 10. Open-Jaw Trips

Open-jaw routing is a first-class concept.

Basic structure:

```text
Origin → Destination A
Destination B → Origin
```

Example:

```text
SJJ → VIE
PRG → SJJ
```

The optimizer may optionally insert internal transport:

```text
SJJ → VIE
VIE → PRG
PRG → SJJ
```

The optimizer must not assume that the outbound and return airports are identical.

---

## 11. Multi-City Trips

A multi-city itinerary contains three or more transport legs.

Example:

```text
SJJ → VIE
VIE → PRG
PRG → SJJ
```

Multi-city candidates are valid when:

- every transport leg is feasible
- dates are compatible
- stay allocation is valid
- the complete trip satisfies user constraints
- total cost is within budget when a budget exists

---

## 12. Connection Validation

Transport segments can only be connected when the next departure occurs after the previous arrival plus the required connection time.

Conceptually:

```text
next.departureAt >= previous.arrivalAt + minimumConnectionTime
```

Initial minimum connection times:

```text
airport → airport:   120 minutes
airport → station:   150 minutes
station → airport:   150 minutes
station → station:    30 minutes
same station:          15 minutes
```

These are initial configurable defaults, not immutable constants.

The implementation should allow future provider- or location-specific rules.

---

## 13. Airport and Station Transfers

Airport and station substitutions are allowed when explicitly supported by the geography/network model.

Examples:

```text
VIE airport → Vienna city
Vienna Hbf → Vienna city
MUC airport → Munich Hbf
```

Ground transfer time must be considered when connecting different transport nodes.

A connection must not be considered valid merely because the calendar times overlap.

---

## 14. Alternative Airports

Alternative airports may be considered when:

- they are within the configured geographic radius
- ground transportation to/from the destination is feasible
- the additional transfer time is accounted for
- the resulting complete itinerary remains valid

Example:

```text
Munich:
  MUC
  FMM
```

The optimizer may discover:

```text
SJJ → FMM
FMM → Munich
Munich → SZG
SZG → SJJ
```

if the complete itinerary is feasible.

---

## 15. Candidate Generation

The optimizer must not brute-force every possible combination.

Candidate generation should use a funnel:

```text
1. Discover potentially cheap destinations
2. Apply coarse constraints
3. Expand relevant airports/cities
4. Generate return possibilities
5. Generate second-destination possibilities
6. Generate ground transport
7. Validate temporal feasibility
8. Prune dominated candidates
9. Search accommodation for finalists
10. Produce final candidates
```

The exact implementation may evolve, but expensive provider calls should happen as late as reasonably possible.

### Phase 1 subset

Phase 1 implements steps 1, 2 and 10 only, using provider round-trip fares
(`docs/decisions/0008-phase-1-round-trip-discovery.md`). Steps 3–6 and 9 arrive
with ground transport, open-jaw and accommodation; step 8 with pruning.

Provider calls are planned at **month granularity** and results are filtered to
the user's actual dates locally, because exact-date queries return almost
nothing from this source (`docs/phase-0-aviasales-findings.md` §3). The number
of calls per search is bounded, and a query that would exceed the budget is
refused rather than truncated.

Destinations are reported as cities while candidates keep their airports
(`docs/decisions/0010-city-destinations.md`).

---

## 16. Cheap Destination Discovery

For searches where the destination is unspecified:

```text
destination = null
```

the optimizer should first identify promising destinations using cached or provider-supplied price data.

It should not immediately perform exhaustive searches across every city.

Destination discovery may use:

- cached flight prices
- grouped prices
- price ranges
- known cheap routes
- previously observed provider data

The source and age of the price data must be retained.

---

## 17. Candidate Pruning

Dominance pruning should eliminate candidates that are strictly worse than another candidate.

Candidate A dominates candidate B when:

- A costs no more than B, within the same cost scope
- A takes no longer than B
- A has no more changes than B (`stops + connections`, see
  `docs/decisions/0005-trip-metrics-and-accommodation-coverage.md`)
- and A is strictly better in at least one dimension

Dominated candidate B may be discarded.

The exact dominance dimensions may evolve as the optimizer gains additional objectives.

Do not use an opaque score as the sole mechanism for pruning.

---

## 18. Budget

When the user specifies a budget, valid candidates must satisfy it.

For example:

```text
budget = €700
travelers = 2
budget mode = per person
```

means the complete trip should cost no more than:

```text
€1,400 total
```

if the budget is explicitly per person.

The distinction between:

- total budget
- per-person budget

must be preserved in the domain.

Do not silently interpret one as the other.

---

## 19. Complete Trip Cost

Total trip cost includes, where available:

```text
transport
+ internal transport
+ airport/station transfers
+ accommodation
+ other explicitly modeled required costs
```

Do not compare a €300 flight-only itinerary against a €500 complete itinerary and claim that the former is cheaper.

The comparison must use equivalent cost scope.

Transport cost is the sum of the selected transport offers. A fare covering
several segments contributes once. A trip containing a segment not covered by
any selected offer has no complete transport cost and must not be presented as
fully priced.

---

## 20. Accommodation

Accommodation should be searched after transport candidates have been reduced to a manageable finalist set.

This avoids unnecessary provider calls.

A stay must be associated with:

- destination city
- check-in
- check-out
- number of nights
- price
- currency
- cancellation information when available
- provider
- provider reference
- source timestamps

Accommodation cost must be included in final trip cost.

---

## 21. Price Provenance

Every externally sourced price must retain provenance.

Provenance belongs to the priced object: a `TransportOffer`, a `Stay`, or an
exchange rate. Transport segments carry their data source but no price.

At minimum:

```text
provider
providerReference
sourceType
fetchedAt
expiresAt
currency
```

Supported source types:

```text
cached
recent
live
estimated
```

The UI must eventually distinguish these states.

A cached price must never be presented as a live verified price.

An estimated price must never be presented as an exact bookable price.

---

## 22. Verification

Final candidates should be verifiable through provider links or booking links where available.

The optimizer may use cached data for discovery.

Before presenting a candidate as verified/bookable, the system must perform the appropriate live verification.

Discovery and verification are separate stages.

---

## 23. Provider Failures

A failure from one provider should not necessarily fail the entire search.

Examples:

```text
Flight provider unavailable
→ continue using other available sources

Hotel provider timeout
→ retain transport candidate but mark accommodation unavailable

Bus provider unavailable
→ continue with flights/trains
```

The result must clearly communicate incomplete data where applicable.

Never fabricate missing prices or availability.

---

## 24. Determinism

The core optimizer must be deterministic given:

- the same normalized search request
- the same provider data
- the same optimizer version
- the same configuration

LLMs must not be used to determine:

- route feasibility
- connection validity
- budget compliance
- candidate pruning
- date validity
- itinerary construction

An LLM may later be used for:

- natural-language request parsing
- explanations
- summarization
- presentation

but not for the core optimization logic.

---

## 25. Explainability

Every final candidate should be explainable in terms of concrete data.

For example:

```text
Vienna + Prague

Transport: €312
Accommodation: €184
Total: €496 (cost scope: complete)
Duration: 7 nights
Legs: 3
Stops: 0
Connections: 0
Outbound: SJJ → VIE
Internal: VIE → PRG
Return: PRG → SJJ
```

The optimizer should retain enough metadata to explain why a candidate exists and how its total was calculated.

---

## 26. Search Stages

The search pipeline should expose meaningful stages:

```text
destinations
flights
ground_transport
open_jaw
accommodation
optimization
complete
```

This supports:

- progress reporting
- observability
- debugging
- performance analysis

---

## 27. Performance and API Economics

External provider calls are expensive and must be minimized.

The optimizer should:

- cache reusable data
- deduplicate identical searches
- filter candidates before expensive calls
- prune candidates before accommodation searches
- avoid unnecessary provider calls
- retain provider timestamps
- avoid repeatedly requesting identical data

Do not trade correctness for arbitrary optimization.

---

## 28. Future Extensions

The architecture should leave room for:

- more flight providers
- more rail providers
- more bus providers
- more accommodation providers
- additional transport modes
- user preference weighting
- natural-language search
- carbon information
- booking
- price alerts

These are not required for the initial MVP.

Do not implement them prematurely.