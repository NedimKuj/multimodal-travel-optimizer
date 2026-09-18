# 0007 — Airport reference data

- Status: Accepted
- Date: 2026-09-18

## Context

Mapping a provider response to the domain needs more than the provider gives.
`Location` requires a name, country, coordinates and an IANA time zone (ADR
0003), while flight records carry only IATA codes. Something must resolve
`FCO` → Rome Fiumicino, `Europe/Rome`, 41.80/12.25.

The Travelpayouts published dataset (`/data/en-GB/airports.json`, fetched
2026-09-18) contains 10,377 records, **every one** with an IANA `time_zone` and
coordinates, and it uses the same code space as the flight data we are
normalizing. Independent datasets either lack time zones (OurAirports) or are
less current (OpenFlights).

## Decision

- Travelpayouts' dataset is the **initial** reference source, not a permanent
  architectural dependency.
- Consumers depend on the `AirportRepository` port in the domain, never on the
  dataset or its schema. Replacing the source means replacing one adapter.
- The snapshot is **not committed** while redistribution terms are unverified
  (`docs/provider-compliance.md`). `pnpm geo:fetch` fetches it locally; only a
  provenance sidecar (`packages/geo/data/airports.meta.json`: source, fetch
  time, record count, SHA-256) is committed.
- Loading verifies the snapshot against the recorded checksum and fails loudly
  on a mismatch, so a search is always tied to known reference data.
- Records that cannot be represented are **counted as issues**, never coerced:
  of 10,377 records, 10,184 load, 52 are harbours (no domain type) and 141 are
  rejected by domain validation (mostly non-IATA Cyrillic codes).
- An unknown IATA code is a structured data-quality failure. Coordinates, zones
  and countries are never inferred for a code the dataset lacks.

Place types map as: `airport`/`heliport` → `airport`; `railway`/`bus` →
`station`; `harbour` → unsupported.

## Consequences

- Provider adapters can build complete `Location`s without inventing geography.
- Reference data has provenance, so a reproducible search can record exactly
  which snapshot it used.
- The rail and bus stations already present in the dataset give Phase 2 a head
  start, though station coverage has not been assessed.
- If the terms review permits redistribution, committing the snapshot becomes a
  one-line `.gitignore` change plus a compliance note.
