# Project specification — Multimodal Trip Optimizer

## 0. Product goal

Build a web application that answers:

> **"Given where I am, when I can travel, how long I want to stay, and how much I want to spend, what are the best complete trips I can actually take?"**

The application must optimize **trips**, not merely individual flights.

A trip may consist of:

```text
Flight
→ Hotel
→ Train
→ Hotel
→ Flight
```

or:

```text
Flight
→ Train
→ Flight
```

or:

```text
Flight
→ Hotel
→ Flight
```

The system must support:

- round trips
- one-way trips
- open-jaw trips
- multi-city trips
- multiple transport modes
- flexible dates
- alternative airports
- multiple destinations
- accommodation
- total-trip cost optimization

The initial origin should be **Sarajevo (SJJ)**, but the architecture must be generic.

---

# 1. Core product differentiation

Do **not** position this as:

> "A better Google Flights."

Google Flights already handles conventional round-trip, one-way and multi-city flight searches, flexible dates and alternative airports.

The product's central abstraction is:

> **Search for a complete journey rather than a ticket.**

Example:

```text
SJJ
 ↓ flight €75
FMM
 ↓ train €25
MUC
 ↓ train €30
SZG
 ↓ flight €60
SJJ

Hotels:
FMM 1 night  €55
MUC 2 nights €180
SZG 2 nights €160

TOTAL: €585
```

The optimizer should discover this automatically.

---

# 2. Primary user experience

The home screen should be extremely simple.

### Search

```text
From
[ Sarajevo ]

To
[ Anywhere ]

When
[ Flexible ]

Duration
[ 5–7 nights ]

Budget
[ €700 / person ]

Travelers
[ 2 ]

Transport
[x] Flights
[x] Trains
[x] Buses

[x] Alternative airports
[x] Open-jaw / multi-city
```

Optional preferences:

```text
Maximum transfers
Maximum travel time
Direct flights preferred
Countries
Regions
Beach
Mountains
Cities
```

The user presses:

**Explore trips**

---

# 3. Search modes

The backend must support three fundamentally different modes.

## Mode A — Destination discovery

Input:

```text
origin = SJJ
dates = flexible
budget = €X
```

Output:

```text
FMM €75
IST €66
STO €93
BER €138
...
```

This is primarily powered by cached/observed flight-price data.

---

## Mode B — Fixed destination

Example:

```text
SJJ
→
Vienna
Dec 26 – Jan 2
```

The optimizer searches:

- flights
- alternative airports
- trains
- buses
- open-jaw variants
- accommodation

---

## Mode C — Full trip exploration

Example:

```text
From: Sarajevo
Dates: Dec 26 – Jan 3
Duration: 5–7 nights
Budget: €700/person
Destination: Anywhere
```

The optimizer is allowed to construct:

```text
SJJ → Vienna → Prague → SJJ
```

or:

```text
SJJ → Milan → Zurich → SJJ
```

or:

```text
SJJ → Memmingen → Munich → Salzburg → SJJ
```

etc.

This is the **core product**.

---

# 4. Open-jaw must be first-class

Do **not** model the system around:

```text
origin → destination → origin
```

That will make future development painful.

The fundamental model should be:

```ts
Trip {
  origin: Location
  legs: TripLeg[]
  stays: Stay[]
  totalCost: Money
}
```

A `TripLeg` can be:

```ts
FlightLeg
TrainLeg
BusLeg
GroundTransferLeg
```

Therefore these are equally valid:

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
SJJ → FMM
MUC → SJJ
```

---

# 5. Open-jaw optimization

The optimizer should explicitly generate these patterns.

### Pattern 1

```text
SJJ → A
A → SJJ
```

### Pattern 2

```text
SJJ → A
B → SJJ
```

### Pattern 3

```text
SJJ → A
A → B
B → SJJ
```

### Pattern 4

```text
SJJ → A
A → B
C → SJJ
```

The latter is effectively a multi-city trip.

The system should **not brute-force every possible combination**.

Use candidate generation and pruning.

---

# 6. Optimization strategy

Use the existing GitHub project as a **reference implementation**:

[multimodal-travel-optimizer on GitHub](https://github.com/meehhmett/multimodal-travel-optimizer?utm_source=chatgpt.com)

Its README describes exactly the concepts we want:

- alternative airports
- flexible dates
- flight + train
- flight + bus
- multimodal routes
- cost/duration/transfer comparison

But its data is explicitly demo-scale and its future-work section lists real-time APIs and hotel integration. :chatgpt-content-reference{index="2"}

Therefore:

**Do not fork its dataset as production infrastructure.**

Instead:

```text
Existing repository
        ↓
study algorithm/data structures
        ↓
implement production domain model
        ↓
replace demo data with provider adapters
```

---

# 7. Recommended architecture

Use a monorepo.

```text
trip-optimizer/
│
├── apps/
│   └── web/
│
├── packages/
│   ├── domain/
│   ├── optimizer/
│   ├── providers/
│   ├── geo/
│   ├── pricing/
│   └── ui/
│
├── services/
│   ├── ingestion/
│   └── search-worker/
│
├── prisma/
│
└── docs/
```

Recommended tooling:

```text
Frontend:
Next.js
React
TypeScript
Tailwind
shadcn/ui

Backend:
Next.js API routes / server actions initially
Node.js
TypeScript

Database:
PostgreSQL
PostGIS

ORM:
Prisma

Cache:
Redis

Jobs:
BullMQ

Validation:
Zod

Testing:
Vitest
Playwright

Deployment:
Vercel
Postgres provider
Redis provider
```

Don't introduce microservices initially.

Start as a modular monolith.

---

# 8. Domain model

## Location

```ts
type Location = {
  id: string
  type: "city" | "airport" | "station"
  name: string
  countryCode: string
  latitude: number
  longitude: number
  iataCode?: string
}
```

---

## Transport segment and transport offer

> Amended by `docs/decisions/0002-separate-transport-offers-from-segments.md`.
> A segment is a physical movement without a price. An offer is a commercial
> fare covering one or more segments. `docs/optimizer-spec.md` §4 is authoritative.

```ts
type TransportSegment = {
  id: string
  mode: "flight" | "train" | "bus"
  provider: string
  providerReference?: string

  origin: Location
  destination: Location

  departureAt: string
  arrivalAt: string

  durationMinutes: number
  transfers: number
}
```

```ts
type TransportOffer = {
  id: string
  segmentIds: string[]

  price: Money
  priceBasis: { kind: "perTraveler" } | { kind: "total"; travelers: number }

  bookingUrl?: string

  provider: string
  providerReference?: string
  sourceType: "cached" | "recent" | "live" | "estimated"
  fetchedAt: string
  expiresAt?: string
}
```

---

## Stay

```ts
type Stay = {
  propertyId: string
  city: Location

  checkIn: string
  checkOut: string

  nights: number

  price: Money

  roomDescription?: string

  cancellationPolicy?: string

  source: string
  fetchedAt: string
}
```

Duffel's current Stays model is structured around accommodation → room → rate, with the rate carrying price and booking conditions. :chatgpt-content-reference{index="3"}

---

# 9. TripCandidate

This is the most important object in the entire application.

> Amended by `docs/decisions/0004-trip-candidate-and-budget-shape.md`.
> The stored shape is the ordered sequence of segments, offers and stays.
> Dates, destinations, costs, durations, transfers and confidence are derived.
> Confidence uses `cached | recent | live | estimated`, not `cached | verified`.

```ts
type TripCandidate = {
  id: string

  origin: Location
  travelers: number

  segments: TransportSegment[]
  offers: TransportOffer[]

  stays: Stay[]
}

// Derived, never stored independently:
//   departureDate, returnDate, destinations
//   transportCost, accommodationCost, totalCost, perPersonCost
//   totalDurationMinutes, travelTimeMinutes, transfers
//   sourceType (weakest of all prices), sources
```

The UI should consume **TripCandidate**, not provider-specific data.

---

# 10. Provider architecture

Every external source must be behind an adapter.

> Amended by `docs/decisions/0002-separate-transport-offers-from-segments.md`:
> transport providers return segments and offers separately, and every provider
> returns a result envelope that can express partial failure.

```ts
interface FlightProvider {
  search(request: FlightSearchRequest): Promise<ProviderResult<TransportSearchResult>>
}
```

```ts
interface RailProvider {
  // offers may be empty for timetable-only data
  search(request: RailSearchRequest): Promise<ProviderResult<TransportSearchResult>>
}
```

```ts
interface BusProvider {
  search(request: BusSearchRequest): Promise<ProviderResult<TransportSearchResult>>
}
```

```ts
type TransportSearchResult = {
  segments: TransportSegment[]
  offers: TransportOffer[]
}
```

```ts
interface AccommodationProvider {
  search(request: StaySearchRequest): Promise<Stay[]>
}
```

This is critical.

The optimizer must never know whether an offer came from Aviasales, Duffel, DB, SNCF, etc.

---

# 11. Flight data — MVP source

## Aviasales Data API

This is the first provider to implement.

You already have a working token and have demonstrated that:

```text
SJJ → IST
```

returns live API JSON with cached fare data.

More importantly, you successfully queried the cheap-prices endpoint and got dozens of destinations from SJJ:

```text
FMM €75
IST €66
STO €93
BER €138
...
```

This proves the discovery layer works.

The data includes:

```text
destination
airline
departure_at
return_at
price
duration
duration_to
duration_back
transfers
expires_at
```

This is excellent candidate-generation data.

### Important limitation

It is **not a guaranteed live fare inventory**.

Treat it as:

```text
discovery / cached intelligence
```

not:

```text
final booking price
```

Every serious result must eventually be verified against a live provider.

---

# 12. Aviasales prerequisites

The agent must create:

```env
AVIASALES_API_TOKEN=
```

Prerequisite:

1. Travelpayouts account
2. Join/connect the Aviasales program
3. Obtain API token
4. Store token server-side
5. Never expose token to browser

The application must have a provider config:

```ts
{
  provider: "aviasales",
  enabled: true
}
```

so the provider can later be disabled without changing optimizer code.

---

# 13. Aviasales implementation

Create:

```text
packages/providers/src/aviasales/
```

with:

```text
client.ts
mapper.ts
types.ts
provider.ts
```

Example:

```ts
class AviasalesFlightProvider implements FlightProvider {
  async search(
    request: FlightSearchRequest
  ): Promise<FlightOffer[]> {
    // API call
    // validation
    // mapping
    // return normalized domain objects
  }
}
```

Never allow Aviasales JSON to escape the provider layer.

---

# 14. Second flight provider

Implement a second provider for **live verification**.

Candidate:

**Duffel Flights API**

Duffel provides live flight offers and supports pricing/offer verification before booking. Its current API documentation explicitly provides offer-price actions for getting accurate prices before payment. :chatgpt-content-reference{index="4"}

Use Duffel primarily for:

```text
candidate verification
```

rather than:

```text
mass destination discovery
```

because the product may perform enormous numbers of searches.

This separation is intentional.

---

# 15. Accommodation

Initial provider:

**Duffel Stays**

Duffel currently provides accommodation search, rooms/rates and final quote/booking flows. :chatgpt-content-reference{index="5"}

Implement:

```text
DuffelAccommodationProvider
```

Search only after transport candidate generation.

Do **not** search thousands of hotels for every possible destination.

Instead:

```text
1000 possible flight destinations
        ↓
cheapness filter
        ↓
100 candidate destinations
        ↓
transport feasibility
        ↓
20 trip candidates
        ↓
hotel search
        ↓
top 10 complete trips
```

This dramatically reduces API usage.

---

# 16. Rail data

Rail should initially be divided into:

### Network/timetable data

Used to answer:

> "Can I get from A to B?"

Potential sources:

- DB timetable/open data
- SNCF open data
- GTFS / GTFS-RT where available

### Fare data

Separate.

Timetable availability does **not** imply current bookable price.

The normalized model must therefore allow network-only edges without a price.

Per `docs/decisions/0002-separate-transport-offers-from-segments.md`, these are
`TransportSegment`s with no associated `TransportOffer`.

Those edges can still be useful during route construction.

---

# 17. Bosnia/regional bus data

Investigate:

```text
redvoznje.ba
```

as a regional source.

Do not couple the optimizer directly to it.

Create:

```text
RedVoznjeBusProvider
```

only if its current API/licensing terms permit the intended commercial use.

For every external data source, the implementation agent must document:

```text
API access requirements
commercial-use restrictions
rate limits
attribution requirements
caching restrictions
booking restrictions
```

before production use.

---

# 18. Static geographic data

We need a canonical geographic dataset.

At minimum:

```text
Countries
Cities
Airports
Rail stations
Bus stations
Airport ↔ city relationships
Airport ↔ airport relationships
Station ↔ city relationships
Coordinates
IATA codes
```

The optimizer needs this independently of flight providers.

For example:

```text
FMM
→ Memmingen
→ Munich region
→ Bavaria
```

and:

```text
SAW
→ Istanbul
→ Turkey
```

This is essential for evaluating alternative airports.

---

# 19. Alternative airports

Create an airport graph.

Example:

```text
Munich
 ├── MUC
 ├── FMM
 └── NUE
```

The system must be able to calculate:

```text
airport flight price
+
airport → city ground cost
+
airport → city ground time
```

Therefore:

```text
FMM €75
```

should not automatically beat:

```text
MUC €100
```

if getting from FMM to the actual destination costs €50 and two hours.

---

# 20. Candidate-generation algorithm

Do **not** immediately run a complete graph search over every airport/city/hotel.

Use a funnel.

### Stage 1

Generate cheap flight destinations.

```text
SJJ
 ↓
Aviasales
 ↓
100–500 candidate destinations
```

### Stage 2

Filter:

```text
date compatibility
price
duration
geographic region
```

### Stage 3

Expand each destination:

```text
airport
→ city
→ nearby airports
→ nearby train stations
```

### Stage 4

Generate possible second destinations.

### Stage 5

Generate return possibilities.

### Stage 6

Add ground transport.

### Stage 7

Add accommodation.

### Stage 8

Score.

---

# 21. Graph model

Represent the transportation network as a **time-dependent directed graph**.

Nodes:

```text
Airport
Station
City
```

Edges:

```text
Flight
Train
Bus
Ground transfer
```

Each edge has:

```ts
{
  origin
  destination

  departureAt
  arrivalAt

  duration

  mode
  transfers

  source
}
```

Price and confidence are not edge properties. They belong to the
`TransportOffer`s covering an edge, and an edge may have none
(see `docs/decisions/0002-separate-transport-offers-from-segments.md`).

This allows:

```text
SJJ
 ↓
VIE
 ↓ train
PRG
 ↓ train
BER
 ↓
SJJ
```

to be treated as a path through the graph.

---

# 22. Time constraints

The graph must be **time-aware**.

You cannot simply say:

```text
VIE → PRG = €20
```

You must know whether the train departs after arrival at VIE.

Connection validity:

```ts
next.departureAt >=
previous.arrivalAt + minimumConnectionTime
```

Define configurable minimum connection times:

```text
airport → airport: 120 min
airport → station: 150 min
station → station: 30 min
same station: 15 min
```

These should be configuration, not hard-coded assumptions.

---

# 23. Open-jaw candidate generation

For each promising destination A:

```text
SJJ → A
```

find candidate destinations B reachable from A.

Then find:

```text
B → SJJ
```

Candidate:

```text
SJJ → A → B → SJJ
```

For two-city open-jaw:

```text
SJJ → A
B → SJJ
```

Add:

```text
A → B
```

using:

1. train
2. bus
3. flight

in that order of preference only if the user permits all modes.

---

# 24. Pruning

Without pruning, combinations explode.

Use hard constraints first:

```text
total budget
maximum trip duration
maximum travel time
maximum transfers
allowed countries
minimum stay
maximum stay
```

Then dominance pruning.

If:

```text
Route A:
€200
8h
2 transfers

Route B:
€180
6h
1 transfer
```

A dominates B? No — B dominates A.

Discard A.

More formally, candidate X can be removed when another candidate is:

```text
≤ cost
≤ duration
≤ transfers
```

with at least one strict improvement.

---

# 25. Scoring

Do **not** expose an arbitrary opaque score to users initially.

Internally use a cost function such as:

```text
score =
    transportCost
  + accommodationCost
  + timePenalty
  + transferPenalty
  + airportAccessPenalty
```

But UI should initially explain results using actual dimensions:

```text
€512 total
6 nights
8h 20m total travel
2 transfers
```

rather than:

```text
Score: 87.4
```

---

# 26. Accommodation optimization

Accommodation should be attached to **city stays**, not transport legs.

Example:

```text
SJJ → Vienna
Dec 27

Vienna
Dec 27–29
2 nights

Vienna → Prague
Dec 29

Prague
Dec 29–Jan 2
4 nights

Prague → SJJ
Jan 2
```

The optimizer needs to determine:

```text
number of nights per city
```

rather than simply:

```text
hotel for entire trip
```

This is essential for multi-city travel.

---

# 27. Accommodation cost approximation

For the initial MVP:

```text
hotelCost =
cheapest reasonable room
```

subject to:

```text
2 travelers
1 room
reasonable rating
reasonable location
```

Do not optimize:

```text
€19 hostel 40km from city center
```

against:

```text
€90 central hotel
```

without accounting for ground transport.

---

# 28. Total trip price

Always display:

```text
Transport
Accommodation
Ground transport
Estimated extras
----------------
Total
```

For example:

```text
Flights             €180
Trains               €55
Hotels              €310
Airport transfers    €30
────────────────────────
Total               €575
```

Per-person:

```text
€287.50
```

---

# 29. Price confidence

Every price must carry provenance.

```ts
type PriceConfidence =
  | "cached"
  | "recent"
  | "live"
  | "estimated"
```

Example:

```text
€75 flight
Cached fare · checked 12 min ago
```

versus:

```text
€82
Live verified
```

Never present cached data as guaranteed bookable price.

---

# 30. Search lifecycle

The backend should execute:

```text
REQUEST
  ↓
Normalize user input
  ↓
Generate candidate destinations
  ↓
Generate flight candidates
  ↓
Generate open-jaw candidates
  ↓
Expand ground transport
  ↓
Validate time constraints
  ↓
Prune dominated routes
  ↓
Generate accommodation candidates
  ↓
Calculate total costs
  ↓
Rank candidates
  ↓
Return top N
```

---

# 31. Caching

This is extremely important.

Cache provider responses.

Redis keys:

```text
flight:sjj:2026-12-26:2027-01-02
hotel:vienna:2026-12-26:2026-12-29
train:vienna:prague:2026-12-29
```

Also store normalized provider data in PostgreSQL where appropriate.

Every record needs:

```text
fetched_at
expires_at
provider
provider_request_hash
```

---

# 32. Search deduplication

If 50 users ask:

```text
SJJ → anywhere
Dec 26–Jan 3
```

do **not** send 50 identical API requests.

Use:

```text
request fingerprint
```

and shared cache.

---

# 33. API endpoints

Initial internal API:

```text
POST /api/trips/search
```

Request:

```json
{
  "origin": "SJJ",
  "destination": null,
  "departureDate": "2026-12-26",
  "returnDate": "2027-01-03",
  "flexibilityDays": 2,
  "minNights": 5,
  "maxNights": 7,
  "travelers": 2,
  "budget": 700,
  "currency": "EUR",
  "transportModes": [
    "flight",
    "train",
    "bus"
  ],
  "allowOpenJaw": true,
  "allowMultiCity": true
}
```

Response:

```json
{
  "searchId": "...",
  "results": [
    {
      "totalCost": 523,
      "currency": "EUR",
      "confidence": "cached",
      "legs": [],
      "stays": []
    }
  ]
}
```

---

# 34. Asynchronous search

Eventually the search should be asynchronous.

```text
POST /api/trips/search
        ↓
searchId
        ↓
worker
        ↓
progress
        ↓
results
```

Frontend:

```text
Finding flights...
Finding alternative airports...
Checking trains...
Building open-jaw combinations...
Checking accommodation...
Optimizing...
```

This makes a complex search feel intentional rather than slow.

---

# 35. Search stages exposed to frontend

Return:

```ts
type SearchProgress = {
  stage:
    | "destinations"
    | "flights"
    | "ground_transport"
    | "open_jaw"
    | "accommodation"
    | "optimization"
    | "complete"

  progress: number
}
```

---

# 36. MVP result UI

Each result should look like:

```text
┌─────────────────────────────────────────────┐

🇦🇹 Vienna + 🇨🇿 Prague

€523 / person
6 nights

Sarajevo → Vienna
✈️ €58

Vienna
🏨 2 nights · €92

Vienna → Prague
🚆 €21

Prague
🏨 4 nights · €128

Prague → Sarajevo
✈️ €74

────────────────────────────────────────────

Travel time: 7h 40m
3 legs · 0 stops · 0 connections

[ View trip ]

└─────────────────────────────────────────────┘
```

---

# 37. Why users should trust the results

Every result needs:

```text
Price checked:
17 Sep 2026, 16:42

Flight source:
Aviasales

Hotel source:
Duffel

Train source:
DB

Price status:
Cached / Live
```

And:

**Check price**

should trigger live verification where possible.

---

# 38. Booking model

Do **not** build booking in MVP.

The first version should be:

```text
Discover
→ compare
→ verify
→ redirect/book
```

Later:

```text
Discover
→ verify
→ book
```

This keeps the first implementation dramatically simpler.

---

# 39. Data-source strategy

Use a hierarchy:

### Discovery

```text
Aviasales Data API
```

### Live flight verification

```text
Duffel
```

### Accommodation

```text
Duffel Stays
```

### Rail

```text
DB / SNCF / GTFS
```

depending on geography.

### Bus

```text
regional APIs / GTFS
```

where legally and technically usable.

### Geographic reference

```text
airport/station/city datasets
```

---

# 40. Provider requirements matrix

The agent should create:

```text
docs/providers.md
```

with this table:

| Provider | Purpose | Live? | Cost | Rate limit | Commercial use | Booking |
|---|---|---|---|---|---|---|
| Aviasales Data | Flight discovery | Cached | TBD | TBD | Verify terms | Redirect |
| Duffel Flights | Flight verification | Yes | Paid | Account-specific | Yes, subject to terms | Yes |
| Duffel Stays | Hotels | Yes | Paid | Account-specific | Yes, subject to terms | Yes |
| DB | Rail network | Mostly timetable | Depends | Depends | Verify | No/varies |
| SNCF | Rail | Timetable/realtime | Depends | Depends | Verify | No/varies |
| Regional bus | Bus | Varies | Varies | Varies | Verify | Varies |

**Do not hard-code prices/rate limits from this document.** The agent must verify them against current provider documentation before implementation.

---

# 41. Important commercial/API constraint

The agent must explicitly separate:

```text
API technical availability
```

from:

```text
commercial permission
```

An API being technically accessible does **not** automatically mean we can build a commercial metasearch product on top of it.

Create:

```text
docs/provider-compliance.md
```

and record:

- attribution
- caching rules
- search-volume restrictions
- affiliate requirements
- redistribution restrictions
- booking requirements
- price-display requirements

---

# 42. Database schema

Initial tables:

```text
locations
airports
stations
cities

transport_edges
transport_offers

accommodations
accommodation_rates

provider_requests
provider_responses

searches
search_results

trip_candidates

price_snapshots
```

Don't persist every raw API response forever.

Raw responses should have TTL/retention.

---

# 43. Observability

Add:

```text
structured logging
request IDs
provider latency
provider errors
search duration
candidate counts
pruning counts
```

Metrics:

```text
searches/day
average search duration
provider error rate
cache hit rate
candidates generated
candidates discarded
hotel API calls/search
flight API calls/search
```

This will become extremely important when API costs appear.

---

# 44. Testing strategy

## Unit tests

Test:

```text
date flexibility
open-jaw generation
connection validation
airport substitution
currency conversion
dominance pruning
budget filtering
stay allocation
total-cost calculation
```

## Integration tests

Mock:

```text
Aviasales
Duffel
rail providers
hotel provider
```

Never make tests depend on live API availability.

## End-to-end

Test:

```text
Sarajevo
→ Anywhere
→ flexible dates
→ 2 people
→ €700
→ open-jaw enabled
```

and verify a complete result is rendered.

---

# 45. Critical algorithm tests

Create fixed fixtures.

### Test 1

```text
SJJ → VIE → SJJ
```

must beat an expensive alternative when appropriate.

### Test 2

```text
SJJ → VIE
PRG → SJJ
```

must be recognized as valid open-jaw.

### Test 3

```text
SJJ → VIE
VIE → PRG
PRG → SJJ
```

must be recognized as multi-city.

### Test 4

A flight arriving after the connecting train must be rejected.

### Test 5

An airport that is technically cheaper but impossible within the user's time window must be rejected.

### Test 6

A €50 cheaper trip with €100 additional hotel cost must lose to the genuinely cheaper total trip.

---

# 46. AI usage

Do **not** make the AI responsible for route optimization.

Use deterministic algorithms for:

```text
availability
dates
prices
connections
optimization
```

AI can be used later for:

```text
natural-language search
destination descriptions
trip explanations
preference interpretation
```

Example:

> "I want somewhere romantic with Christmas markets, mountains nearby and no more than two flights."

AI translates this into structured constraints.

The optimizer does the actual computation.

---

# 47. Future natural-language interface

Eventually:

```text
"Find me somewhere from Sarajevo for New Year,
5–7 nights, under €800 each.
I'd like Christmas markets and mountains,
and I'd rather move between two cities than stay in one."
```

becomes:

```json
{
  "origin": "SJJ",
  "dates": {
    "from": "2026-12-26",
    "to": "2027-01-03"
  },
  "nights": [5, 7],
  "budgetPerPerson": 800,
  "preferences": {
    "christmasMarkets": true,
    "mountains": true,
    "multiCity": true
  }
}
```

Then deterministic optimization happens.

---

# 48. MVP phases

## Phase 0 — Data feasibility

Before building UI:

- obtain Aviasales credentials
- implement Aviasales adapter
- retrieve SJJ destination data
- verify multiple months
- test date flexibility
- test destination coverage
- investigate open-jaw API capability
- document response semantics

**Deliverable:** normalized flight dataset.

---

## Phase 1 — Flight exploration

Build:

```text
SJJ → anywhere
```

with:

- destination cards
- price
- date
- duration
- stops
- airline

No hotels yet.

Delivered as the `trip-search` CLI (§51), not a UI. Usage and measured
coverage: `docs/trip-search.md`.

Strategy, from the Phase 0 measurements
(`docs/phase-0-aviasales-findings.md`):

- discovery uses provider **round-trip fares only**; composing two one-way
  fares is deferred to the open-jaw phase
  (`docs/decisions/0008-phase-1-round-trip-discovery.md`)
- provider calls are planned at **month granularity**, then results are
  filtered locally to the user's actual dates
- `--from`/`--to` with `--nights` bound a travel window; without `--nights`
  they are anchored dates (`docs/decisions/0009-date-flexibility-semantics.md`)
- destinations are reported as **cities**, while each candidate keeps its
  airport identity (`docs/decisions/0010-city-destinations.md`)
- costs are transport-only and labelled as such; they are not complete-trip
  costs until accommodation exists (Phase 4)

---

## Phase 2 — Graph

Add:

- cities
- airports
- alternative airports
- trains
- buses
- connection validation

### Scope boundary

Phase 2 delivers the **provider-independent** layer: airport/station/city
relationships, ground transfers, configurable connection times, and opt-in
alternative-origin expansion. It does not depend on a licensed rail or bus
provider.

Rail and bus **ports and fixtures** exist so the graph can be built and tested.
A production rail/bus adapter is written only when all four hold:

1. the source is identified,
2. its applicable terms/licence are documented,
3. our intended use is permitted,
4. the source supplies data sufficient for our requirements.

No scraping, and no inferred or fabricated timetables. If nothing clears, the
adapter stays unimplemented and the blocker is recorded in
`docs/provider-compliance.md`.

**Finish line:** geography, ground transfers and connection validation
implemented and tested against provider-independent fixtures, and the rail
source investigation carries a documented compliance decision. If a source
clears, its implementation is **Phase 2b** rather than an extension of Phase 2.

### Airport breadth vs origin expansion

These are different things and are budgeted differently:

- **Destination** airport breadth comes from the discovery provider. An
  "anywhere" search already returns every destination airport, so it costs no
  extra calls.
- **Origin** expansion is an optional, budgeted search dimension: each extra
  origin consumes provider calls. It is off by default, enabled per search, and
  capped (`docs/decisions/0013-alternative-origin-expansion.md`).

---

## Phase 3 — Open-jaw

Implement, from **independently priced one-way fares**:

```text
SJJ → A → SJJ          composed round trip
SJJ → A
B → SJJ                open jaw, with A → B as an unpriced gap
```

Deferred to **Phase 3b**:

```text
SJJ → A → B → SJJ      multi-city
SJJ → A → B
C → SJJ
```

Phase 3 is done when composed round trips and open jaws are deterministic,
budget-bounded, correctly costed, connection-valid, and clearly distinguish a
complete cost from a known cost that excludes an unpriced sector.

### Two-stage funnel and the call budget

```text
Stage 1   one discovery call per departure month (SJJ → anywhere, one-way)
Stage 2   return-leg queries for destinations chosen deterministically
          (cheapest outbound fare, then IATA), spending only what remains
```

`providerCalls <= 12` is an invariant for the whole search, shared with
alternative-origin expansion. Destinations skipped for budget are recorded with
their reason. The 12 is **our application-level safety budget**, not the
provider's quota, which is still unverified
(`docs/provider-compliance.md`).

Measured 2026-09-18: one discovery call returns 51 destinations from SJJ, but
return legs are sparse — of the eight cheapest destinations, three (ROM, DTM,
FRA) had no January return fares at all. Composition must show that, not hide
it.

---

## Phase 4 — Accommodation

Add hotel provider.

Generate complete trip cost.

---

## Phase 5 — Optimization

Add:

- dominance pruning
- budget constraints
- duration constraints
- transfer penalties
- airport access
- accommodation cost

---

## Phase 6 — Live verification

Add Duffel or another live flight source.

Flow:

```text
cached discovery
      ↓
top candidates
      ↓
live verification
      ↓
updated price
```

---

## Phase 7 — UX

Polish:

- map
- timeline
- trip cards
- filters
- price breakdown
- source transparency
- save/share trip

---

# 49. MVP definition of done

The MVP is **not done** when it can search flights.

It is done when a user can enter:

```text
From: Sarajevo
To: Anywhere
Dates: Dec 26 – Jan 3
Flexible: ±2 days
Nights: 5–7
People: 2
Budget: €700/person
```

and receive at least several **complete trip candidates** containing:

```text
✓ transport
✓ dates
✓ destinations
✓ open-jaw/multi-city where applicable
✓ accommodation
✓ total cost
✓ per-person cost
✓ travel time
✓ transfers
✓ price provenance
✓ booking/verification links
```

---

# 50. What NOT to build initially

Explicitly tell the coding agent:

Do **not** build:

```text
mobile app
user accounts
payments
booking engine
loyalty programs
AI itinerary generation
social features
reviews
carbon scoring
recommendation chatbot
```

until the optimizer itself works.

The hard problem is:

> **finding cheap valid complete trips.**

Solve that first.

---

# 51. First technical milestone

The first thing the agent should produce should be a CLI:

```bash
pnpm trip-search \
  --origin SJJ \
  --from 2026-12-26 \
  --to 2027-01-03 \
  --nights 5:7 \
  --budget 700 \
  --people 2
```

Output:

```text
Searching SJJ...

Flight candidates: 143
Alternative airports: 37
Ground connections: 812
Open-jaw candidates: 1,284

After pruning: 87

Accommodation candidates: 261

Final candidates:

1. Vienna → Prague
   €523/person
   6 nights

2. Milan → Zurich
   €571/person
   5 nights

3. Berlin
   €594/person
   6 nights
```

**Only after this works should the UI be built.**

The Phase 1 CLI produces the transport part of this output: destinations with
price, dates, duration, stops and airline. Accommodation counts, open-jaw and
pruning lines appear in the phases that implement them, rather than being
printed as zeros.

Phase 1 flags:

```bash
pnpm trip-search \
  --origin SJJ \
  --from 2026-12-26 \
  --to 2027-01-03 \
  --nights 5:7 \
  --flex 2 \
  --budget 700 \
  --budget-basis per-person \
  --people 2 \
  --currency EUR \
  [--destination IST] [--limit 10] [--json]
```

---

# 52. Final architecture

The complete system should ultimately look like this:

```text
                    ┌──────────────────────┐
                    │      Web UI          │
                    │      Next.js         │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │    Search API        │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Search Orchestrator  │
                    └──────────┬───────────┘
                               │
             ┌─────────────────┼─────────────────┐
             ▼                 ▼                 ▼
       Flight discovery    Rail/Bus         Accommodation
             │                 │                 │
             ▼                 ▼                 ▼
        Aviasales          DB/SNCF/etc       Duffel Stays
             │
             ▼
       Candidate Generator
             │
             ▼
       Multimodal Graph
             │
             ▼
       Open-Jaw Generator
             │
             ▼
       Constraint Filter
             │
             ▼
       Dominance Pruning
             │
             ▼
       Trip Optimizer
             │
             ▼
       Live Verification
             │
             ▼
       Complete TripCandidate
             │
             ▼
          Web UI
```

---

## The strategic conclusion

I would **not** start by trying to compete with Google Flights on flight search.

The experiment you've just run is actually encouraging because Aviasales already gives us a very useful **cheap-destination discovery layer** from SJJ. The GitHub project gives us a useful conceptual starting point for multimodal optimization, but its demo dataset is far too small to be the actual product backend. :chatgpt-content-reference{index="6"}

The product we're building is effectively:

> **A constraint-based travel optimizer that searches the space of possible trips, rather than the space of individual tickets.**

And **open-jaw should be a fundamental property of the graph**, not a feature bolted onto a round-trip flight search.

That distinction is important enough that I'd make it the first architectural rule in the agent's instructions:

```text
RULE #1:

Never assume that a trip returns to its departure destination
using the same airport, the same city, or even the same transport
mode.

A trip is an ordered sequence of locations and transport segments.
```

That gives you room to discover exactly the kind of "weird but much cheaper" itineraries you're interested in.