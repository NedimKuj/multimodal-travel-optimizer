# 0002 — Separate transport offers from transport segments

- Status: Accepted
- Date: 2026-09-17

## Context

`docs/optimizer-spec.md` §4 originally placed a required `price: Money` on every
`TransportSegment`.

This conflicts with two real requirements:

1. `docs/implementation-plan.md` §16 requires timetable/network-only rail edges
   that have no known fare (`price: undefined`). Such edges are still useful for
   route construction.
2. Providers frequently sell a single fare covering several physical movements:
   - Aviasales Data API returns round-trip prices covering outbound and return.
   - Duffel offers contain multiple slices/segments priced as one offer.

If price lives on the segment, a multi-segment fare can only be represented by
inventing per-segment prices, which violates the rule against fabricating
prices, or by double-counting the fare on every segment.

## Decision

The domain separates physical movement from commercial offer.

- **`TransportSegment`** represents a physical movement: mode, origin,
  destination, departure/arrival timestamps, duration, transfers, carrier and
  the data source that described it. It **does not contain a price**.
- **`TransportOffer`** represents a commercial offer. It references **one or
  more** segments and carries **exactly one** price with its provenance
  (provider, provider reference, source type, fetchedAt, expiresAt, currency)
  and the basis of that price (per traveler or total for N travelers).
- A segment may exist **without any offer** (timetable-only data). Such a
  segment is usable for route construction but has no known cost.
- Trip cost is computed from the **selected offers**, never from segments.
  Each segment in a priced trip must be covered by exactly one selected offer,
  so a fare covering several segments is counted once.
- A provider fare covering multiple segments must **never be split into
  artificial per-segment prices**.

## Consequences

- Provider adapters return `{ segments, offers }` rather than priced segments.
- A trip candidate containing a segment not covered by any offer is not a
  fully priced trip and must not be presented as one.
- Optimizer cost comparisons operate on offer combinations. Choosing between a
  round-trip fare and two one-way fares is a choice between offer sets over the
  same segments.
- `docs/optimizer-spec.md` §4, §19 and §21 and `docs/implementation-plan.md`
  §8, §10, §16 and §21 were amended accordingly.
