# 0017 — Dominance pruning

- Status: Accepted
- Date: 2026-09-21

## Context

Composition produces several ways to reach the same place: the same city, the
same shape of trip, differing only in fare, timing and changes. Some of those
are simply worse than others on every axis a traveler would weigh, and showing
them is noise.

Spec §17 already sketched dominance — cost, travel time, `stops + connections`,
one strictly better — but left two things unsaid, and both turn out to decide
whether pruning is useful or destructive.

1. **What may be compared.** Nothing said whether a cheap trip to Rome could
   eliminate a dearer one to Milan. For a product whose first question is
   "where can I go?", it obviously must not.
2. **What "same cost scope" means once accommodation exists.** `cost.total`
   sums priced components only, so two candidates in one class can differ in
   how much of their cost is *known*.

## Decision

### 1. Dominance is a redundancy boundary, not a ranking preference

It removes alternatives that offer nothing another alternative does not already
offer. It never expresses that one destination or one trip shape is preferable
to another — that is ranking's job, and ranking deletes nothing.

### 2. Comparability requires five things to match

```text
destination                 the existing DestinationResult grouping
transport pattern           ADR 0016 §5, the four exclusive shapes
comparison class            ADR 0016 §8
cost scope                  §19
accommodation coverage      the multiset of stay states
```

**Destination.** A cheaper, faster, simpler trip to Rome must not eliminate
Milan. Destination discovery is a product output (spec §16, Mode A); pruning may
thin the routes to one place, never the set of places.

**Transport pattern.** A round trip to Milan must not eliminate a multi-city
trip to Milan. The four patterns are different products, which ADR 0016 already
recognised by reserving a shortlist slot for each. Dominance honours the same
boundary.

**Comparison class and cost scope.** These are two views of one fact:
`comparisonClass` and `costScopeFor` are both computed from the same
`exclusions` array with identical branch structure, so they agree by
construction. Both are checked because they are *specified* independently and
could later diverge; neither is redundant defensively, and the code says so.

**Accommodation coverage profile.** The one that is not obvious. Consider two
class-1 multi-city candidates:

```text
A  stay 1 priced EUR 200, stay 2 unpriced  ->  exclusions ["accommodation"]
B  both stays unpriced                     ->  exclusions ["accommodation"]
```

Both are class 1 with the same scope, yet `cost.total` includes A's priced stay
and nothing of B's. Comparing them on total lets **B win because more of its
cost is unknown** — which is the failure the whole provenance model exists to
prevent. So comparability requires the same multiset of coverage states.

Different accommodation *amounts* with the same profile are fine: that is what
the cost dimension is for. Different *completeness* is not comparable at all.

This produces no behaviour change today, because no accommodation provider is
configured and every candidate therefore has zero priced stays. It is recorded
now rather than discovered later.

### 3. The dimensions are cost, travel time, and changes

A dominates B when A is no worse on all three and strictly better on at least
one. `stops + connections` is used as ADR 0005 defined it, and is **not**
collapsed into a single `transfers` field — the domain distinguishes stops
inside a journey from changes between journeys, and so does this.

### 4. Nights are not a dimension

Two trips of different length are not interchangeable. Duration is product
intent, and it changes what accommodation is worth. `[minNights, maxNights]`
already bounds what the traveler will accept; dominance has no business
preferring shorter or longer within that.

### 5. Ties survive

Candidates equal on all three dimensions do not dominate one another, and both
are kept. Dominance requires a strict improvement, so equality is not
redundancy, and nothing is deleted on a coin toss.

### 6. Pruning is order-independent by construction

The relation is a strict partial order: irreflexive (strictness), antisymmetric
(A no worse and strictly better on one axis means B is worse on that axis), and
transitive (all three comparisons are numeric `<=`). The surviving set is
therefore the set of maximal elements, which is the same whatever order the
candidates arrive in.

The implementation keeps a candidate when **no other candidate dominates it**,
which evaluates the same predicate for every candidate. It never uses first-wins,
iteration order, insertion order or provider response order.

## Consequences

- Pruning is pure: no provider calls, no side effects, and it runs before
  accommodation is searched (spec §15 step 8 precedes step 9), so it can reduce
  the work the shortlist has to do.
- Counts are reported separately from every other reduction — budget skips,
  invalid candidates, the accommodation shortlist, provider failures — and
  reconcile exactly: `entered = pruned + remaining`.
- With results as sparse as they are today (2–3 live candidates), pruning will
  rarely fire. It is correct rather than impactful, and the counts will say so.
- Should dominance later gain an objective, the comparability boundary above is
  the part to leave alone: it is what keeps pruning from deleting products.
