# 0005 — Trip metrics and accommodation coverage

- Status: Accepted
- Date: 2026-09-17

## Context

Two things were under-specified, and both produce numbers a downstream
optimizer would trust.

### Transfers

`docs/optimizer-spec.md` §17 uses transfers as a dominance dimension, but the
word covers three different things:

- intermediate stops inside one priced journey (a flight with one stop)
- changing vehicle between two legs on the same day
- continuing a trip after staying somewhere overnight

The worked examples in `docs/optimizer-spec.md` §25 and
`docs/implementation-plan.md` §36 both show `SJJ → VIE`, `VIE → PRG`,
`PRG → SJJ` with a hotel between each leg and report `Transfers: 2`, that is,
`legs - 1`. With that rule a direct round trip would report 1 transfer, which no
traveler would call a transfer, and it would penalize round trips against
one-way options during pruning. A single number cannot carry all three meanings.

### Nights without accommodation

Stay validation rejected stays outside the time on the ground, but nothing
checked the converse. A trip with a seven-night gap and one one-night stay
validated cleanly and produced an unqualified `total`, which
`docs/optimizer-spec.md` §19 forbids comparing against a fully covered trip.

## Decision

### Trip metrics

`TripSummary` reports three explicit numbers instead of one `transfers` field:

- `legs`: number of transport segments
- `stops`: intermediate stops inside segments (summed `segment.transfers`)
- `connections`: changes between consecutive segments with no stay in between

Dominance compares `stops + connections`: the changes a traveler actually makes
in one go. A night in a city is a destination, not a transfer.

For the Vienna + Prague example: `legs: 3`, `stops: 0`, `connections: 0`. For a
direct round trip: `legs: 2`, `stops: 0`, `connections: 0`. The `Transfers: 2`
lines in spec §25 and plan §36 were rewritten to these metrics.

### Accommodation coverage

A trip stays valid when nights on the ground have no stay, because
flight-only exploration (plan Phase 1) is legitimate. But the summary states it:

- `uncoveredNights`: the local dates of nights on the ground with no stay
- `costScope`: `"complete"` when every such night is covered, otherwise
  `"transport_and_partial_accommodation"`

Only totals with the same `costScope` may be compared. A total whose scope is
not `complete` must never be presented as a complete-trip cost.

## Consequences

- Dominance pruning and result display use these fields; there is no `transfers`
  field to misread.
- The optimizer must compare candidates of equal `costScope`, or complete the
  accommodation before comparing.
- A night spent on an overnight train is not a night on the ground and so is
  never counted as uncovered.
- Still open: a trip whose last segment does not return to the origin (one-way)
  has no closing departure, so nights after the final arrival are outside the
  model. Such trips cannot carry a stay after that arrival yet. To be decided
  before one-way trips are generated.
