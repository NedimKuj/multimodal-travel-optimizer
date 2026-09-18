# Provider Compliance

## Purpose

This document records the commercial, licensing, attribution, caching, rate-limit, and usage restrictions associated with external travel-data providers.

Technical API access does not automatically mean that the data may be used commercially or stored indefinitely.

No provider integration should assume permissions that have not been verified.

---

## Rules

### 1. Do not scrape providers unless explicitly permitted

Do not implement scraping of:

- airline websites
- hotel websites
- booking platforms
- aggregator websites
- search-engine result pages

unless the relevant terms explicitly permit the intended use.

Prefer official APIs, licensed datasets, or explicitly permitted feeds.

---

### 2. Do not assume API access equals commercial permission

Before using provider data in production, verify:

- commercial usage rights
- redistribution rights
- caching/storage rights
- attribution requirements
- affiliate requirements
- booking/deep-link requirements
- rate limits
- geographic restrictions
- user-volume restrictions
- required application registration
- required contracts or approvals

Record the result in this document.

---

### 3. Provider record

Each provider should eventually have a section containing:

```text
Provider:
API:
Purpose:
Environment:
Access status:
Commercial use:
Caching allowed:
Redistribution allowed:
Attribution required:
Booking/deep links:
Rate limits:
Data freshness:
Known restrictions:
Documentation:
Last verified:
```

---

## Aviasales / Travelpayouts

Status:

```text
Research / integration candidate
```

Intended use:

- flight destination discovery
- cached price discovery
- flight price intelligence
- potentially flight search depending on approved access

Important considerations:

- distinguish cached Data API data from real-time search data
- do not present cached data as live availability
- verify current commercial/API eligibility before production use
- respect rate limits
- retain source timestamps
- verify affiliate/deep-link requirements
- verify storage/caching permissions

The implementation must not hard-code assumptions about data freshness.

### Verification record

```text
Provider:              Aviasales (Travelpayouts affiliate network)
API:                   Flights Data API (aviasales/v3/*, legacy v1/v2)
Purpose:               cached flight price discovery
Environment:           production endpoints only (no sandbox known)
Access status:         API token held locally; program eligibility UNVERIFIED
Commercial use:        UNVERIFIED
Caching allowed:       UNVERIFIED
Redistribution:        UNVERIFIED — assume not allowed
Attribution required:  UNVERIFIED — affiliate marker assumed required for links
Booking/deep links:    redirect only, via affiliate link with marker
Rate limits:           UNVERIFIED for Data API
Data freshness:        cached fares from recent user searches; treat as `cached`
Last verified:         2026-09-18 (attempted; see below)
```

### Why these are unverified

Verification was attempted on 2026-09-18 from this repository. The Travelpayouts
support centre (`support.travelpayouts.com`), which hosts both the affiliate
agreement and the Data API reference, returns **HTTP 403 to automated
requests**, and `api.travelpayouts.com/aviasales/v3/prices_for_dates` returns
**401 without a token**. No terms text could therefore be read and confirmed
here. Nothing above may be treated as approved until a human confirms it while
signed in to the partner dashboard.

### Questions to answer from the partner dashboard

1. Does the account's program membership permit commercial use of Data API
   prices in a metasearch-style product?
2. May normalized prices be stored, and for how long? Is there a required
   maximum cache age or a mandatory refresh?
3. May prices be shown to end users without an affiliate link, and must every
   displayed price carry a marker-bearing link?
4. What attribution or branding must accompany displayed prices?
5. What are the Data API rate limits and the consequences of exceeding them?
6. May the published reference datasets (`/data/airports.json` and similar) be
   stored in a source repository, or only fetched at deploy/run time?
7. Does the real-time Flight Search API (the only one offering open-jaw) require
   separate approval, and do its conversion obligations apply to us?

### Restrictions applied until those answers exist

These are deliberately conservative; they are engineering constraints, not
claims about what the terms say.

- Raw API responses are **never committed**; captures stay in a gitignored
  directory and test fixtures are synthetic.
- Reference datasets are fetched locally and **not committed**; only a
  provenance record (source, timestamp, checksum, record count) is committed.
- Every price is labelled `cached` with its `fetchedAt`, and is never presented
  as live or bookable.
- Booking links are emitted only when an affiliate marker is configured;
  otherwise no link is produced rather than an unattributed one.
- No public deployment of this data until questions 1–4 are answered.

---

## Amadeus

Status:

```text
Research / integration candidate
```

Potential use:

- flight search
- flight inspiration
- airport/city data
- hotel-related APIs where applicable

Important considerations:

- verify current Self-Service carrier/data coverage
- do not assume it represents the complete low-cost-carrier market
- verify production/commercial terms
- distinguish test environment from production access

---

## Duffel

Status:

```text
Research / integration candidate
```

Potential use:

- live flight offers
- flight verification
- stays/accommodation where applicable
- eventual booking infrastructure

Important considerations:

- verify current API capabilities
- verify commercial requirements
- verify booking obligations
- verify caching and offer-expiration behavior
- treat offers as time-sensitive

Duffel should primarily be considered a live verification/booking-oriented provider rather than the sole discovery source.

---

## Rail Data

Potential sources may include:

- official railway APIs
- public timetable datasets
- GTFS/GTFS-like feeds
- DB timetable/open data
- SNCF/open transport data

For every source verify:

- license
- commercial use
- redistribution
- update frequency
- fare availability
- booking availability

Timetable availability does not imply fare or booking availability.

### Status: blocked, under investigation (Phase 2)

```text
Access status:   no source cleared
Implementation:  NOT PERMITTED until the conditions below are met
Last updated:    2026-09-18
```

A production rail (or bus) adapter may be implemented only when **all four**
hold, each recorded here:

1. the source is identified by name and endpoint/dataset,
2. its applicable terms or licence are documented,
3. our intended use — a commercial multimodal trip optimizer — is permitted,
4. the data is sufficient for our requirements (see below).

Until then the `RailProvider` and `BusProvider` ports stay unimplemented.
Fixtures exist for tests only. **No scraping, and no inferred or fabricated
timetables.** If nothing clears, that is the recorded outcome and rail stays
unimplemented.

### What the investigation must establish

Scope: **GTFS and DB open data first.** GTFS is a data format and an ecosystem,
not a single provider, so each feed carries its own publisher and licence and
must be assessed individually.

- which specific feeds cover journeys relevant to our origin (Sarajevo) and the
  destinations discovery actually returns
- the licence of each feed, and whether commercial use and redistribution of
  derived results are permitted
- update frequency, and whether static schedules are enough or real-time is
  required
- whether fares are included at all; a timetable-only feed yields segments with
  no offer, which the domain supports (ADR 0002) but which cannot produce a
  priced trip
- attribution obligations
- any registration, contract or approval prerequisite

### Sufficiency bar

A cleared source must let us build a normalized `TransportSegment`: both
endpoints resolvable to stations we can locate, departure and arrival with
usable time zones, and a duration. Anything less cannot enter the domain
without inventing data, and therefore does not clear.

---

## Bus Data

Same status as rail: **blocked, under investigation**. The conditions, the
sufficiency bar and the prohibition on scraping or inferred timetables in the
Rail Data section apply identically here.

Potential regional sources may include:

- official operator APIs
- licensed aggregators
- public timetable datasets

For each source verify:

- license
- commercial use
- redistribution
- update frequency
- fare availability
- booking availability

Do not scrape bus websites without confirming permission.

---

## Accommodation

Potential providers:

- Booking.com Demand API
- Expedia Rapid
- Duffel Stays
- other licensed accommodation providers

For each provider verify:

- search access
- price usage
- caching
- availability freshness
- booking/deep-link requirements
- attribution
- affiliate requirements
- commercial eligibility

Accommodation should generally be queried only for shortlisted transport itineraries to control API usage.

---

## Data Freshness

Every provider response must retain:

```text
fetchedAt
expiresAt
```

When the provider gives an explicit validity period, use it.

When freshness is unknown, mark the source appropriately rather than pretending it is live.

---

## Production Rule

No provider should be treated as production-ready until:

1. API access has been confirmed
2. intended use has been reviewed
3. commercial terms have been checked
4. caching/storage rules are understood
5. rate limits are understood
6. attribution requirements are understood
7. implementation behavior matches those restrictions

---

## Change Log

Record significant provider-policy changes here.

Example:

```text
2026-09-17
Provider:
Change:
Source:
Impact:
```