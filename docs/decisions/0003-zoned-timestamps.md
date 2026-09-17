# 0003 — Zoned timestamps and local dates

- Status: Accepted
- Date: 2026-09-17

## Context

`docs/optimizer-spec.md` §6 requires two things from transport timestamps:

1. connection validation on **absolute instants**
2. **local dates** for itinerary presentation and stay allocation, correct
   across DST changes, midnight and year boundaries

The spec's `departureAt: string` does not say how the time zone is carried. An
ISO string with a UTC offset (`2026-12-26T22:30+01:00`) identifies the instant,
but an offset is not a time zone: it cannot say which offset applies at another
instant (for example after a DST change), so local-date arithmetic derived from
it is unreliable. `Location` also had no time zone.

The TC39 `Temporal` API would be the natural fit, but it is not available in
the project runtime (Node 26.8.2: `globalThis.Temporal` is undefined), and the
polyfill is pre-1.0.

## Decision

- A transport timestamp is a **`ZonedTimestamp`**:
  ```ts
  interface ZonedTimestamp {
    instant: string   // ISO-8601 UTC, e.g. "2026-12-26T21:30:00.000Z"
    timeZone: string  // IANA zone, e.g. "Europe/Sarajevo"
  }
  ```
- Comparisons and durations use `instant` only.
- Local date/time/offset are derived from `instant` + `timeZone` using the
  built-in `Intl.DateTimeFormat` (ICU time-zone data). No third-party date
  library is used in the domain.
- Parsing from providers accepts only strings **with an explicit UTC offset or
  `Z`**. Naive local strings are rejected. When a zone is supplied alongside an
  offset string, the offset must match the zone's offset at that instant;
  a mismatch is a validation error, not silently corrected.
- Calendar dates without time (search dates, stay check-in/check-out) are
  **`LocalDate`** strings (`YYYY-MM-DD`) with integer day arithmetic that never
  involves a time zone.
- `Location` gains a required IANA `timeZone`.

## Consequences

- Connection validation cannot accidentally compare wall-clock strings.
- Stay nights are derived from local dates in the destination's zone.
- Resolving a naive local wall time to an instant (for providers that only
  supply local times) is not supported yet. An adapter needing it must add an
  explicit, tested resolution strategy for ambiguous and skipped DST times.
- The implementation is isolated in `packages/domain/src/time/`, so it can move
  to `Temporal` once the runtime supports it.
- `docs/optimizer-spec.md` §3, §4 and §6 were amended.
