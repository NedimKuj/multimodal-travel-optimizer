# 0012 — Connection time rules

- Status: Accepted
- Date: 2026-09-18

## Context

`docs/optimizer-spec.md` §12 gives minimum connection times and calls them
"initial configurable defaults, not immutable constants":

```text
airport → airport:   120 minutes
airport → station:   150 minutes
station → airport:   150 minutes
station → station:    30 minutes
same station:          15 minutes
```

Our segments are separately sold journeys, not a carrier's own connection: when
two of them meet, the traveler is making the change, with bags to collect and a
new check-in. That is why the airport figure is two hours rather than the
40 minutes an airline might allow on a through ticket.

`packages/domain/src/trip-candidate.ts` already states that connection-time
rules belong to the optimizer, since they are configuration rather than a
structural property of a trip.

## Decision

### 1. Instants, never local clocks

A connection is `next.departureAt - previous.arrivalAt` measured on absolute
instants. Local clock arithmetic would mis-handle a connection across a
time-zone or DST boundary — which is exactly where a mistake is dangerous.

### 2. Classification by node type, with cities treated as stations

- both airports (the same one or two different ones): **120**
- airport and station, in either direction: **150**
- both stations: **15** at the same station, **30** at different stations

A city node is treated as a station. Cities only appear as the endpoint of a
transfer we scheduled ourselves, so they never need a class of their own, and
inventing one would be inventing numbers.

A pair the rules cannot classify is **rejected**, not allowed by default.

### 3. Connections, not stays

The rules apply to a pair of consecutive segments the traveler connects
between. A long gap at a destination is a stay, not a connection: it is
governed by nights and accommodation, not by minimum connection time. The
threshold between the two is configurable.

### 4. A transfer we schedule uses the same rules

When the optimizer inserts an access transfer it takes its buffer **from these
rules**, rather than a fixed figure. A bus arriving at an airport terminal must
still leave the airport's 120 minutes before the flight; assuming 30 would
produce itineraries that validate but cannot be travelled.

## Consequences

- Connection validation is a pure function of segments plus a config object,
  so every rule in the table is directly testable at its boundary.
- Tightening a rule for a specific airport later means extending the config,
  not changing the optimizer.
- An itinerary whose connection is even a minute short is rejected and counted,
  never rounded into feasibility.
