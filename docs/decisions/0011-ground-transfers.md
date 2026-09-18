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
durationMinutes = baseMinutes + distanceKm x minutesPerKm
cost            = baseCost     + distanceKm x costPerKm
```

with per-pair overrides for cases we know better. Distance is great-circle, so
the estimate is approximate by construction, and is never presented otherwise:

- `sourceType: "estimated"`, with the estimating model named as the source
  rather than a provider,
- shown on its own line in output, never folded into a verified total,
- a trip containing one aggregates to `estimated` under the weakest-source rule
  (ADR 0004), which is the honest label for the whole trip.

An estimated price is never a bookable price and never a verified one.

### 3. Access transfers are attached only when material

An airport further from its city than a configured threshold (default 25 km)
gets an explicit transfer leg; one inside it does not. FCO (~30 km) and
FMM→Munich (~110 km) qualify; CIA (~15 km) does not.

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
