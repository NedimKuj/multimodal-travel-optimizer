# 0013 — Alternative origin expansion

- Status: Accepted
- Date: 2026-09-18

## Context

Travellers do drive to another airport for a cheaper fare: a live check on
2026-09-18 showed Tuzla (71 km from Sarajevo) returning fares Sarajevo did not.
`SearchRequest` has carried an `alternativeAirports` flag since Milestone 1
with nothing behind it.

Two sides of this are not alike:

- **Destination** breadth is free. An "anywhere" search already returns every
  destination airport, and city grouping (ADR 0010) presents them sensibly.
- **Origin** breadth is not. Each additional origin multiplies provider calls,
  against a hard budget of 12 per search.

## Decision

### 1. Off by default, enabled per search

Origin expansion happens only when the request asks for it
(`alternativeAirports`, `--alternative-airports`). A search that did not ask
never spends calls on it.

### 2. Deterministic selection

```text
exclude the primary origin
filter to flightable airports within alternativeOriginRadiusKm
sort by distance, then IATA code
take the first maxAlternativeOrigins
```

Sorting by distance alone is not a total order — two airports can sit the same
distance away — so IATA breaks ties and the same request always produces the
same search.

### 3. The call budget is authoritative

```text
callsPerOrigin = |departure months x return months, return >= departure|
spend          = callsPerOrigin                 # the primary origin, always first
for each alternative, in order:
    if spend + callsPerOrigin <= budget: include it, spend += callsPerOrigin
    else:                                skip it, recording the reason
```

Alternatives that do not fit are **recorded as skipped**, with their distance
and the reason, and surfaced in the trace and CLI output. A budget-limited
search says so rather than looking thorough.

### 4. Nearby is not equivalent

An alternative origin is only usable if the traveller can get there, so every
candidate from one carries a ground transfer leg (ADR 0011) with its estimated
time and cost, and is judged as a complete trip. Every candidate keeps the
airport it actually departs from, so an itinerary never silently claims to
start where the traveller asked.

## Consequences

- Enabling alternatives can halve the destinations a search covers when the
  budget binds, because calls are shared. That trade is visible in the trace.
- The radius and cap are configuration, so widening them is a decision about
  provider spend rather than a code change.
- Origin expansion is an **optional, budgeted search dimension**; destination
  breadth is a property of discovery. `docs/optimizer-spec.md` §14 and
  `docs/implementation-plan.md` §48 record the distinction.
