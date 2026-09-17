# 0004 — Trip candidate shape, price confidence, and budget

- Status: Accepted
- Date: 2026-09-17

## Context

Three points in the documentation conflict or are under-specified:

1. `docs/implementation-plan.md` §9 stores `departureDate` and `returnDate` on
   `TripCandidate`. That is a round-trip shape. `AGENTS.md` rule 4 and
   `docs/optimizer-spec.md` §2/§10 require open-jaw and multi-city to be
   first-class, not special cases of a round trip.
2. `docs/implementation-plan.md` §9 uses `confidence: "cached" | "verified"`,
   while `AGENTS.md` rule 9 and `docs/optimizer-spec.md` §21 use
   `cached | recent | live | estimated`.
3. `docs/optimizer-spec.md` §7 has two optional fields, `budget` and
   `budgetPerPerson`. That allows both to be set, or an ambiguous meaning, while
   §18 forbids interpreting one as the other.

## Decision

### Trip candidate

The stored truth of a `TripCandidate` is:

```ts
interface TripCandidate {
  id: string
  origin: Location
  travelers: number
  segments: TransportSegment[] // chronological
  offers: TransportOffer[]     // selected offers covering the segments
  stays: Stay[]
}
```

Everything else is **derived**, never stored independently, so it cannot drift:

- `departureDate`: local date of the first segment's departure
- `returnDate`: local date of the last segment's arrival
- `destinations`: the ordered stay cities
- transport, accommodation and total cost, and per-person cost
- travel time, total duration and transfers
- the aggregate source type

There is no stored `score`. `docs/optimizer-spec.md` §17 forbids an opaque score
as the sole pruning mechanism, and ranking is added with the optimizer.

A structurally invalid candidate (segments out of order, a segment covered by no
offer or by two offers, overlapping stays, a stay outside the time on the
ground) is reported with explicit errors, never repaired silently.

### Price confidence

Use the four source types `cached | recent | live | estimated` everywhere.

The aggregate source type of a candidate is the **weakest** of its priced parts,
ordered `estimated < cached < recent < live`. A trip is only `live` when every
price in it is `live`.

### Budget

```ts
type Budget =
  | { kind: "total"; amount: Money }
  | { kind: "perPerson"; amount: Money }
```

`SearchRequest.budget?: Budget` replaces `budget` and `budgetPerPerson`. A
per-person budget is converted to a total only by explicit multiplication by
`travelers`.

Per-person cost display divides a total with a deterministic largest-remainder
allocation, so the per-person amounts always sum to the total.

## Consequences

- Open-jaw, multi-city and one-way trips need no special fields.
- `docs/implementation-plan.md` §9 and `docs/optimizer-spec.md` §7 were amended.
- The HTTP request shape in `docs/implementation-plan.md` §33 (`"budget": 700`)
  is a public API sketch, not the domain type. It must be mapped explicitly when
  that API is built.
