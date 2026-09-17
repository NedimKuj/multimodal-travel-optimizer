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

---

## Bus Data

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