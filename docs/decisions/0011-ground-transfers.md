# 0011 — Ground transfers are segments with estimated cost

- Status: Accepted
- Date: 2026-09-18

## Context

`docs/optimizer-spec.md` §14 requires the time of an airport transfer to be
accounted for, and §19 requires ground transfers in the complete-trip cost.
Without both, the spec's own example is undecidable: FMM at €75 plus a €50
transfer should lose to MUC at €100, but on fare alone FMM wins.

No provider prices ground transfers, and none is licence-cleared
(`docs/provider-compliance.md`). Two things could go wrong here: inventing a
price and presenting it as real, or omitting the cost and quietly recommending
a cheap flight to a far-away airport.

## Decision

### 1. A ground transfer is a transport segment

`ground_transfer` joins `flight`, `train` and `bus` as a transport mode. A
transfer is therefore a normal segment: it occupies time between two places, it
is subject to connection validation, and it can carry a price. Nothing new is
needed in `TripCandidate`, cost calculation or the summary.

It is not, however, a mode a traveler selects. A search chooses between
flights, trains and buses; the optimizer inserts transfers where an itinerary
needs one. The domain keeps the two lists apart (`TRANSPORT_MODES` for
segments, `SELECTABLE_TRANSPORT_MODES` for requests).

### 2. Its cost is estimated, and labelled `estimated`

The estimate comes from a documented, configurable model:

```text
roadDistanceKm  = greatCircleKm x roadDetourFactor   (default 1.3)
durationMinutes = baseMinutes + roadDistanceKm x minutesPerKm
cost            = baseCost    + roadDistanceKm x costPerKm
```

with per-pair overrides for cases we know better. A straight line between two
points is not a road, so the measured distance is inflated by a detour factor
before anything is estimated from it. The result is approximate by
construction, and is never presented otherwise:

- `sourceType: "estimated"`, with the estimating model named as the source
  rather than a provider,
- shown on its own line in output, never folded into a verified total,
- a trip containing one aggregates to `estimated` under the weakest-source rule
  (ADR 0004), which is the honest label for the whole trip.

An estimated price is never a bookable price and never a verified one.

### 3. Access transfers are attached only when material

An airport further from its city than a configured threshold (default 20 km)
gets an explicit transfer leg; one inside it does not.

The threshold is compared against **estimated road distance**, because that is
the journey the traveler makes. Against the real reference data this matters:
Fiumicino is 23 km from Rome in a straight line but about 30 km by road, so a
straight-line threshold of 25 km would have excluded the very example this
decision exists for (spec §19). Ciampino, at 15 km straight-line and about
20 km by road, still does not qualify.

The alternative — attaching a transfer to every candidate — would make every
trip `estimated` and bury the distinction the estimate exists to draw.

## Consequences

- Alternative airports can be compared honestly: the transfer's time and cost
  are part of the itinerary, not a footnote.
- A trip using an alternative origin or a distant destination airport reads as
  `estimated`, so it is never confused with a fare we actually retrieved.
- When a real transfer provider is cleared, it replaces the model behind the
  same segment shape, and those segments become `cached` or `live` without any
  change to the optimizer.
- `docs/optimizer-spec.md` §4 and §13 were amended.
