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
CURRENT FLIGHT DISCOVERY PROVIDER
Provisionally cleared for development use (2026-09-21).
Not cleared for public launch — see "Remaining caveat".
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
Access status:         PROVISIONALLY VERIFIED — registration with Travelpayouts,
                       connection to the Aviasales program, and an API token are
                       all required, and are the only stated prerequisites
Commercial use:        PROVISIONALLY VERIFIED — permitted for public-facing
                       commercial travel discovery
Caching allowed:       PROVISIONALLY VERIFIED — required to cache for 24 hours
Redistribution:        PROVISIONALLY VERIFIED — display of prices to end users
                       permitted as part of discovery results
Attribution required:  PROVISIONALLY VERIFIED — less restrictive for Data API
                       than for Search API; exact wording/placement UNVERIFIED
Booking/deep links:    redirect only, via affiliate link with marker.
                       Booking is NOT required; discovery-only is permitted
Rate limits:           VERIFIED — 600 rpm for /v3/prices_for_dates
Data freshness:        cached fares from recent user searches; treat as `cached`.
                       Provider retains 7 days; endpoint returns fares found in
                       the last 48h; our cache must not exceed 24h
Last verified:         2026-09-21 (Aviasales AI agent response; see below)
```

### Evidence — Aviasales AI agent response, 2026-09-21

The clarification below was obtained from the **Aviasales AI support agent** on
**2026-09-21**, as reported by the project owner. Recorded verbatim as received:

```text
- Commercial public-facing travel discovery is permitted.
- Registration with Travelpayouts and connection to Aviasales are required.
- Use of an API token is required.
- Data API results should be cached for 24 hours.
- Expired prices should be avoided.
- The stricter Search API rules do NOT apply to Data API output.
- Attribution/display requirements are less restrictive for Data API usage.
- The product can remain discovery-only; booking is not required.
```

**This is provider evidence, not a contract.** It was given by an automated
support agent, not issued as written terms and not countersigned. It is strong
enough to move these fields off UNVERIFIED and to govern implementation, and it
is **not** strong enough to rely on at public launch. See *Remaining caveat*
below.

### Data API rules vs Search API rules

The two APIs carry **different obligations**, and this distinction is now
confirmed by the provider rather than inferred from documentation layout. It was
previously recorded here as an open question; it is answered.

| | **Data API** (what we use) | **Flight Search API** (not used) |
|---|---|---|
| Endpoint | `aviasales/v3/prices_for_dates` | real-time search |
| User-initiated search required | **No** | Yes — *"each search query must be initiated by the user"* |
| Conversion obligation | **None** | 9% Buy-link conversion floor |
| Automated collection | **Permitted** | *"forbidden to automatically collect data from search results"* |
| Rate limit | 600 rpm | 200 queries/hour per IP |
| Attribution | Less restrictive (exact form UNVERIFIED) | Stricter |
| Booking required | **No** | Conversion obligation applies |

Our automated, non-user-initiated discovery funnel is therefore **not** governed
by the Search API restrictions. Nothing in this table licenses use of the Search
API; if that API is ever adopted, its stricter rules apply in full.

### The 24-hour cache requirement

**A concrete provider constraint, binding on implementation.**

```text
Maximum cache age for Data API results: 24 hours
```

Two distinct mechanisms are in scope, and both must respect it:

1. **Response cache** — `createFileResponseCache` / `createInMemoryResponseCache`
   (`packages/providers/src/cache.ts`), currently driven by `CACHE_TTL_MS` in
   `packages/cli/src/run.ts`, presently **1 hour**. Already inside the 24h
   ceiling; compliant today, and must never be raised above 24h.
2. **Offer provenance** — `expiresAt` on each `TransportOffer`.

### Provenance mapping (NOT YET IMPLEMENTED)

The provider's instruction to avoid expired prices cannot currently be honoured
literally: `v3/prices_for_dates` **does not return `expires_at`**, so
`packages/providers/src/aviasales/mapper.ts` leaves `expiresAt` absent on every
offer. The 24-hour rule supplies the missing boundary.

```text
expiresAt = fetchedAt + 24h        (when the provider gives no expires_at)
```

Where the provider *does* return `expires_at` (legacy endpoints), that value
continues to win — a provider-stated expiry is always preferred to a derived one.

**Not implemented.** Recorded here as the agreed mapping only. Until it is
implemented, Aviasales offers carry no `expiresAt` and the CLI correctly reports
them as having no expiry.

**Freshness caveat that the 24h rule does not solve.** The endpoint returns fares
found in the **last 48 hours**, so data may already be up to 48h old on arrival.
A 24h cache on top means a displayed price can be up to **72 hours** old. The
derived `expiresAt` bounds *our* retention, not the upstream age. Prices must
continue to be labelled `cached`, never `live`.

### Remaining caveat — confirm through the written support channel

The clarification came from an **AI support agent**. For engineering purposes it
is sufficient and is treated as authoritative here. For **contractual and legal**
purposes it is not:

- it is not written terms, and no clause of the affiliate agreement was amended;
- the affiliate agreement (Travelspark Ltd, HK) remains **silent** on commercial
  use, caching and redistribution — the agent's answer does not change that text;
- cl. 4.5 still permits termination *"at their own discretion at any time without
  prior notice"*.

**Before public launch**, obtain written confirmation from Travelpayouts' human
support channel covering the same four questions (commercial use, redistribution
and display, attribution wording and placement, Data-API scope). The draft ticket
exists and is ready to send. Until that reply arrives, these fields stay
**PROVISIONALLY VERIFIED**, not VERIFIED.

### Still UNVERIFIED

- **Exact attribution wording and placement.** "Less restrictive" is a direction,
  not a specification. Whether every displayed price needs a marker-bearing link,
  or a single general provider attribution suffices, is not established.
- **Whether provider offer identifiers may be exposed** in our output.
- **Written/contractual confirmation** of everything in the agent response.

### Superseded

The 2026-09-18 attempt recorded below is retained for history. The support centre
(`support.travelpayouts.com`) returns **HTTP 403 to automated requests** and
still does; `api.travelpayouts.com/aviasales/v3/prices_for_dates` returns **401
without a token**. Those access findings stand. The *conclusions* drawn from them
— that commercial use, caching, redistribution and attribution were all
unverifiable — are superseded by the 2026-09-21 agent response above, except
where listed under *Still UNVERIFIED*.

### Questions to answer from the partner dashboard

Status as of 2026-09-21. "Agent" means answered by the AI support agent and
therefore **provisionally** answered — see *Remaining caveat*.

1. ~~Does the account's program membership permit commercial use of Data API
   prices in a metasearch-style product?~~ — **Agent: yes**, subject to
   registration, Aviasales connection and a token.
2. ~~May normalized prices be stored, and for how long? Is there a required
   maximum cache age or a mandatory refresh?~~ — **Agent: cache for 24 hours.**
3. May prices be shown to end users without an affiliate link, and must every
   displayed price carry a marker-bearing link? — **Partially.** Display is
   permitted and requirements are "less restrictive" for the Data API, but the
   marker-per-price question is **still open**.
4. What attribution or branding must accompany displayed prices? — **Still open.**
   Direction known, exact wording and placement unknown.
5. ~~What are the Data API rate limits and the consequences of exceeding them?~~
   — **Documented: 600 rpm**, `X-Rate-Limit*` headers, HTTP 429 on breach.
6. May the published reference datasets (`/data/airports.json` and similar) be
   stored in a source repository, or only fetched at deploy/run time? — **Still
   open.** The conservative restriction below stays in force.
7. ~~Does the real-time Flight Search API (the only one offering open-jaw) require
   separate approval, and do its conversion obligations apply to us?~~ — **Agent:
   Search API rules do not apply to Data API output.** Whether the Search API
   itself needs separate approval remains open, and is moot while unused.

### Restrictions applied

These are deliberately conservative; they are engineering constraints, not
claims about what the terms say. All remain in force.

- Raw API responses are **never committed**; captures stay in a gitignored
  directory and test fixtures are synthetic.
- Reference datasets are fetched locally and **not committed**; only a
  provenance record (source, timestamp, checksum, record count) is committed.
  *(Question 6 is still open, so this stays.)*
- Every price is labelled `cached` with its `fetchedAt`, and is never presented
  as live or bookable. *(Reinforced: a displayed fare may be up to 72h old.)*
- Booking links are emitted only when an affiliate marker is configured;
  otherwise no link is produced rather than an unattributed one. *(Stays until
  questions 3–4 are answered precisely.)*
- **Cache age for Data API results must never exceed 24 hours.**
- **No public deployment** until attribution (questions 3–4) is specified and the
  agent clarification is confirmed in writing by human support.

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
Access status:   no source cleared (investigated 2026-09-18, see outcome below)
Implementation:  NOT PERMITTED
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

### Investigation outcome — 2026-09-18: NO SOURCE CLEARED

Scope investigated: GTFS ecosystem and German open data, per the agreed order.
Findings from public sources only; nothing below was confirmed with a licence
holder, and no feed was downloaded.

**1. There is no open rail feed for our origin.** No GTFS feed for Bosnia and
Herzegovina rail could be found. ŽFBH publishes a timetable on its website
only, and ŽRS likewise. Reading those pages programmatically would be scraping,
which rule 1 forbids. **This alone blocks rail for journeys starting at SJJ.**

**2. German feeds exist and look usable, but cover the wrong geography.**
`gtfs.de` republishes the public DELFI dataset as GTFS, including a
long-distance rail feed, and states **Creative Commons 4.0** (CC BY 4.0; the
realtime stream is stated as CC BY-SA 4.0). Attribution would be required. They
cover Germany, while the destinations discovery actually returns from SJJ
(Rome, Istanbul, Yerevan) are not served by them.

**3. Fares are not established.** Neither the feed pages nor the licence page
document whether `fare_attributes`/`fare_rules` are present. German GTFS feeds
typically carry no fares. A timetable-only feed yields segments with **no
offer** — representable (ADR 0002) but unable to price a trip.

**4. Licence terms could not be read in full.** `gtfs.de/en/licence/` does not
state the terms in its page body, so the CC claim comes from the feed listing
rather than a licence document. The CC BY-SA element on realtime data needs
legal review before derived results are published.

### Decision

Rail and bus adapters stay **unimplemented**. Conditions 1 (source identified)
and 2 (terms documented) are partly met for German data; conditions 3
(permitted for our use) and 4 (sufficient data) are **not met**, and for our
origin no source exists at all.

Phase 2 therefore ships the provider-independent layer only. There is no
Phase 2b at this time.

**If rail is revisited, start here:** confirm whether DELFI/gtfs.de feeds carry
fares by downloading one; obtain the licence text in writing; and find out
whether any Balkan operator publishes machine-readable timetables at all. Until
then, a multimodal trip from Sarajevo cannot include a train leg without
inventing data, and we will not invent it.

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

```text
2026-09-21
Provider: Aviasales / Travelpayouts
Change:   Commercial use, caching, redistribution and booking-independence moved
          from UNVERIFIED to PROVISIONALLY VERIFIED. Data API confirmed as not
          governed by Search API restrictions. A 24-hour maximum cache age is
          recorded as a binding provider constraint.
Source:   Aviasales AI agent response, 2026-09-21 (reproduced verbatim in the
          Aviasales section). Provider evidence, not a contract.
Impact:   Aviasales Data API becomes the current flight discovery provider for
          development. Provenance mapping fetchedAt + 24h -> expiresAt is agreed
          but NOT YET IMPLEMENTED. Attribution wording remains unspecified, so
          the no-public-deployment restriction stands. Written human-support
          confirmation required before public launch. No code changed.
```

```text
2026-09-17
Provider:
Change:
Source:
Impact:
```