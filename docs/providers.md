# Providers

Required by `docs/implementation-plan.md` §40. This is a status register, not an
approval. `docs/provider-compliance.md` holds the detail and the open questions.

**Nothing here may be read as permission.** A cell says what has been verified,
by whom and when. "Unverified" means exactly that: not checked, not assumed.

| Provider | Purpose | Live? | Cost | Rate limit | Commercial use | Booking | Status | Last verified |
|---|---|---|---|---|---|---|---|---|
| Aviasales Data API | Flight discovery | No — cached fares from recent user searches | Unverified | Unverified | Unverified | Redirect via affiliate link | Token held; integration in progress (Phase 0) | 2026-09-18 (attempt; docs return 403) |
| Travelpayouts reference data (`/data/*.json`) | Airport/city/airline reference | Static dataset | Unverified | Unverified | Unverified | n/a | Initial source for airport reference data, fetched locally, not committed | 2026-09-18 (attempt) |
| Aviasales Flight Search API | Real-time search, open-jaw capable | Yes | Unverified | Documented publicly as ~200 requests/hour per IP | Carries conversion obligations | Redirect | Investigated only; not implemented | 2026-09-18 |
| Duffel Flights | Live flight verification | Yes | Unverified | Unverified | Unverified | Yes | Not started | — |
| Duffel Stays | Accommodation | Yes | Unverified | Unverified | Unverified | Yes | Not started | — |
| DB / SNCF / GTFS | Rail timetable, fares vary | Mostly timetable | Unverified | Unverified | Unverified | Varies | Not started | — |
| Regional bus (e.g. redvoznje.ba) | Bus | Unverified | Unverified | Unverified | Unverified | Unverified | Not started | — |

## How a provider becomes usable

1. Terms read and recorded in `docs/provider-compliance.md`, with a date.
2. Access confirmed against the real API.
3. Adapter behind a domain port; provider DTOs never escape the adapter.
4. Provenance retained on every price (`provider`, `sourceType`, `fetchedAt`).
5. Rate limits and caching rules implemented, not just documented.

A provider that fails any step stays in this table with its gaps visible,
rather than being used anyway.
