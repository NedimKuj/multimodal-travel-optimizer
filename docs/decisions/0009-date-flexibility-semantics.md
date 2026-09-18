# 0009 — What date flexibility means

- Status: Accepted
- Date: 2026-09-18

## Context

`docs/optimizer-spec.md` §8 gives the example "December 26 → January 3, ±2
days" and, separately, "nights 5–7". It never says what the two dates are: the
exact travel dates, or the outer bounds of a period the traveler is free.

The two readings differ materially. Taking `from`/`to` as anchored dates, a
departure on 24 December for 7 nights (returning 31 December) would be excluded
for falling outside the return window `[Jan 1, Jan 5]`, even though it is seven
nights inside the period the user described.

This was deferred at Milestone 1. Phase 1 must resolve it, because it decides
which dates are queried and which results are kept.

## Decision

Flexibility depends on whether a nights range is given.

**With a nights range — travel window plus duration:**

```text
window W = [departureDate - flexibilityDays, returnDate + flexibilityDays]
valid trip: departs on or after W.from
            returns on or before W.to
            nights within [minNights, maxNights]
```

`from`/`to` describe the period the traveler could be away; nights describe how
long the trip is.

**Without a nights range — anchored dates:**

```text
departure ∈ [departureDate - flexibilityDays, departureDate + flexibilityDays]
return    ∈ [returnDate    - flexibilityDays, returnDate    + flexibilityDays]
```

The dates are the trip, with a tolerance on each end.

A window that cannot contain `minNights` is an **explicit issue** on the request
(the search reports it), not a search that silently returns nothing.

## Consequences

- The reference scenario (SJJ, 26 Dec → 3 Jan, ±2, 5–7 nights) admits any 5–7
  night trip inside 24 Dec → 5 Jan.
- Constraints are still never relaxed: results outside the resolved window are
  rejected and counted, not shown as near-matches. Labelled near-matches remain
  possible future behaviour (spec §8), not current behaviour.
- The rule lives in one place (`packages/optimizer/src/travel-window.ts`) and is
  reported in the search trace, so any result set can be explained.
- `docs/optimizer-spec.md` §8 was amended to state these semantics.
