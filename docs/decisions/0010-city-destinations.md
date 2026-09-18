# 0010 — Destinations are cities; candidates keep their airports

- Status: Accepted
- Date: 2026-09-18

## Context

The provider's `unique=true` returns unique **destination airports**, which is
not the same as unique destinations for a traveler. FCO and CIA are both Rome;
London has seven airports in the reference dataset, New York seven.

Presenting airports as destinations would show the same city repeatedly and
make results hard to compare. Discarding the airport would be worse: the fare,
the flight times and every later itinerary decision (ground transfer, onward
leg, alternative airport comparison) depend on which airport it actually is.

The Travelpayouts cities dataset (`/data/en-GB/cities.json`, 9,652 records) has
the same shape as the airports file, and every one of the 9,269 airports
resolves to a city through the airport record's `city_code`.

## Decision

Normalize `airport → city → destination`:

- A **destination** is a city. Results are grouped and ranked by city.
- Each candidate underneath keeps its **airport identity**: segments are always
  built from `origin_airport`/`destination_airport`, never from city codes.
- City lookup goes through a `CityRepository` port in the domain, alongside
  `AirportRepository`. The optimizer never learns which dataset resolved it.
- An airport with no resolvable city yields a **counted data-quality issue**,
  and the candidate still stands on its airport identity. No city is invented.

## Consequences

- "Rome from €58" can aggregate FCO and CIA fares while the itinerary still says
  which airport, which is what Phase 2 needs for ground transfers and Phase 5
  for alternative-airport comparisons.
- The cities snapshot follows the airports one: fetched locally by
  `pnpm geo:fetch`, not committed while redistribution terms are unverified,
  with a committed provenance sidecar (ADR 0007).
- City-level grouping is presentation and ranking only. Nothing in cost,
  feasibility or connection validation uses a city code.
