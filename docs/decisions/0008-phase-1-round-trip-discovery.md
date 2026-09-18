# 0008 — Phase 1 discovery uses round-trip fares only

- Status: Accepted
- Date: 2026-09-18

## Context

Phase 0 measured two ways to discover destinations from SJJ with the Aviasales
Data API (`docs/phase-0-aviasales-findings.md` §3):

- **Round-trip records** (`one_way=false`): one provider fare covering both
  directions. Observed ~15 destinations for December 2026.
- **One-way records with `unique=true`**: observed ~48 destinations, but a trip
  needs a return, so each destination then needs its own return query — roughly
  one call per destination.

Those figures are **observations of this source on that date**, not product
targets and not constants.

## Decision

Phase 1 discovers destinations using **provider-returned round-trip fares
only**. It does not compose a trip from two separately-queried one-way fares.

Reasons:

1. Every result is a fare the provider actually returned for that pair of
   dates, rather than a pairing we assembled.
2. The call budget stays small and predictable (one call per departure-month ×
   return-month pair, typically 1–4 for a single window).
3. Runs stay reproducible: no per-destination fan-out whose coverage depends on
   how many calls were left when a destination came up.

This is a **Phase 1 strategy choice, not a domain or adapter limitation.** The
`FlightProvider` port, the query type and the Aviasales mapper all handle
one-way searches today, and the domain already represents a trip as two offers
over two segments.

One-way composition is deferred to the open-jaw/optimization phase, where it is
required anyway (`SJJ→A`, `B→SJJ` cannot be one fare) and where it can be
introduced together with an explicit caching strategy.

## Consequences

- Phase 1 coverage is bounded by round-trip availability from the origin. That
  is a property of this discovery source, not a statement about how many
  destinations exist. A second provider, or one-way composition later, widens it
  without changing the optimizer.
- No code branches on an expected destination count. The pipeline consumes
  whatever valid records come back within the call budget; zero results is a
  valid, reported outcome.
- The call budget is explicit and enforced. Exceeding it **refuses the query**
  with an actionable message rather than truncating it, since a truncated search
  would quietly narrow the user's request.
