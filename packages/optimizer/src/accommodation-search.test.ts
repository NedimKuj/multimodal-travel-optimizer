import {
  failedResult,
  okResult,
  parseUtcInstant,
  type AccommodationProvider,
  type Stay,
  type StaySearchQuery,
  type TransportSegment,
} from "@travel-optimizer/domain";
import { describe, expect, it } from "vitest";

import {
  applyAccommodation,
  searchAccommodation,
  stayQueryKey,
} from "./accommodation-search.js";
import { createAccommodationBudget, createSearchBudget, spend } from "./budget.js";
import { DEFAULT_CONNECTION_RULES } from "./connection-rules.js";
import {
  assembleCandidate,
  compareCandidates,
  comparisonClass,
  type CandidateContext,
  type RankedCandidate,
} from "./flight-exploration.js";
import { DEFAULT_GROUND_TRANSFER_CONFIG } from "./ground-transfer.js";
import { resolveTravelWindow } from "./travel-window.js";
import {
  cityRepository,
  CIA,
  fixtureGeography,
  metrics,
  MILAN,
  MXP,
  offer,
  request,
  ROME,
  segment,
  SJJ,
} from "./test-fixtures.js";

/*
 * Pricing the shortlist (ADR 0016 §7). Stays here are test inputs from a
 * fixture provider; no licensed accommodation source exists yet.
 */

const context: CandidateContext = {
  requestedOrigin: SJJ,
  cities: cityRepository,
  geography: fixtureGeography,
  connectionRules: DEFAULT_CONNECTION_RULES,
  groundTransfer: DEFAULT_GROUND_TRANSFER_CONFIG,
  fetchedAt: parseUtcInstant("2026-09-18T09:00:00Z"),
};

const overrides = { allowOpenJaw: true, allowMultiCity: true };

function windowFor() {
  const result = resolveTravelWindow(request(overrides));
  if (!result.ok) throw new Error("expected a window");
  return result.window;
}

const leg = (id: string, from: typeof CIA, to: typeof CIA, departure: string, arrival: string) =>
  segment({ id, origin: from, destination: to, departure, arrival });

const OUT_CIA = leg("out-cia", SJJ, CIA, "2026-12-27T10:00+01:00", "2026-12-27T11:30+01:00");
const OUT_MXP = leg("out-mxp", SJJ, MXP, "2026-12-27T10:00+01:00", "2026-12-27T11:30+01:00");
const ONWARD = leg("cia-mxp", CIA, MXP, "2026-12-30T10:00+01:00", "2026-12-30T11:15+01:00");
const HOME_CIA = leg("home-cia", CIA, SJJ, "2027-01-02T18:00+01:00", "2027-01-02T19:30+01:00");
const HOME_MXP = leg("home-mxp", MXP, SJJ, "2027-01-02T18:00+01:00", "2027-01-02T19:45+01:00");

function candidate(id: string, legs: readonly TransportSegment[]): RankedCandidate {
  const outcome = assembleCandidate({
    id,
    legs: [...legs],
    offers: legs.map((entry, index) => offer(`${id}-${entry.id}`, [entry.id], 3000 + index)),
    request: request(overrides),
    window: windowFor(),
    context,
  });
  if (!outcome.ok) throw new Error(`${id}: ${outcome.counter}`);
  const { attempt } = outcome;
  return {
    candidate: attempt.candidate,
    summary: attempt.summary,
    nights: attempt.nights,
    nightsByStay: attempt.nightsByStay,
    stayIntervals: attempt.stayIntervals,
  };
}

const rome = candidate("rome", [OUT_CIA, HOME_CIA]);
const romeAgain = candidate("rome-again", [OUT_CIA, HOME_CIA]);
const viaMilan = candidate("via-milan", [OUT_CIA, ONWARD, HOME_MXP]);
const openJaw = candidate("open-jaw", [OUT_MXP, HOME_CIA]);

function stayFor(query: StaySearchQuery, amountMinor: number): Stay {
  return {
    id: `stay-${query.city.id}-${String(amountMinor)}`,
    propertyId: `property-${query.city.id}`,
    city: query.city,
    checkIn: query.checkIn,
    checkOut: query.checkOut,
    nights: 6,
    guests: query.guests,
    rooms: query.rooms,
    price: { amountMinor, currency: "EUR" },
    provenance: {
      provider: "fixture-stays",
      providerReference: query.city.id,
      sourceType: "cached",
      fetchedAt: parseUtcInstant("2026-09-18T09:00:00Z"),
    },
  };
}

/** A provider that answers from a table, recording what it was asked. */
function provider(
  answers: (query: StaySearchQuery) => readonly Stay[] | "fail",
  asked: StaySearchQuery[] = [],
): AccommodationProvider {
  return {
    descriptor: {
      id: "fixture-stays",
      kind: "accommodation",
      enabled: true,
      sourceTypes: ["cached"],
    },
    search: (query) => {
      asked.push(query);
      const result = answers(query);
      return Promise.resolve(
        result === "fail"
          ? failedResult("fixture-stays", [
              { kind: "unavailable", message: "down", retryable: true },
            ], metrics)
          : okResult("fixture-stays", result, metrics),
      );
    },
  };
}

const budgetOf = (max: number) => createAccommodationBudget(max);
const base = { travelers: 2, currency: "EUR" } as const;

describe("with no provider", () => {
  it("reports every stay as not searched, naming why", async () => {
    const result = await searchAccommodation([rome, viaMilan], {
      ...base,
      budget: budgetOf(10),
    });
    for (const entries of result.byCandidate.values()) {
      expect(entries.every((entry) => entry.state === "not_searched")).toBe(true);
      expect(entries.every((entry) => "reason" in entry && entry.reason === "no_provider")).toBe(
        true,
      );
    }
    expect(result.queriesMade).toBe(0);
  });

  it("spends nothing", async () => {
    const budget = budgetOf(10);
    await searchAccommodation([rome], { ...base, budget });
    expect(budget.usedProviderCalls).toBe(0);
  });
});

describe("searching", () => {
  it("prices a single-city trip with one search", async () => {
    const asked: StaySearchQuery[] = [];
    const result = await searchAccommodation([rome], {
      ...base,
      budget: budgetOf(10),
      provider: provider((query) => [stayFor(query, 30000)], asked),
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ city: ROME, guests: 2, rooms: 1, currency: "EUR" });
    const [entry] = result.byCandidate.get("rome") ?? [];
    expect(entry?.state).toBe("priced");
  });

  it("searches once per resolved stay of a multi-city trip", async () => {
    const asked: StaySearchQuery[] = [];
    await searchAccommodation([viaMilan], {
      ...base,
      budget: budgetOf(10),
      provider: provider((query) => [stayFor(query, 30000)], asked),
    });
    expect(asked.map((query) => query.city)).toEqual([ROME, MILAN]);
  });

  it("uses the stay intervals already derived, transfers included", async () => {
    const asked: StaySearchQuery[] = [];
    await searchAccommodation([rome], {
      ...base,
      budget: budgetOf(10),
      provider: provider((query) => [stayFor(query, 30000)], asked),
    });
    expect(asked[0]).toMatchObject({ checkIn: "2026-12-27", checkOut: "2027-01-02" });
    expect(asked[0]?.checkIn).toBe(rome.stayIntervals[0]?.checkIn);
    expect(asked[0]?.checkOut).toBe(rome.stayIntervals[0]?.checkOut);
  });

  it("takes the cheapest stay a provider offers", async () => {
    const result = await searchAccommodation([rome], {
      ...base,
      budget: budgetOf(10),
      provider: provider((query) => [stayFor(query, 40000), stayFor(query, 25000)]),
    });
    const [entry] = result.byCandidate.get("rome") ?? [];
    expect(entry?.state === "priced" && entry.stay.price.amountMinor).toBe(25000);
  });

  it("asks nothing about a stay it cannot construct a search for", async () => {
    const asked: StaySearchQuery[] = [];
    const result = await searchAccommodation([openJaw], {
      ...base,
      budget: budgetOf(10),
      provider: provider((query) => [stayFor(query, 30000)], asked),
    });
    expect(asked).toEqual([]);
    expect(result.byCandidate.get("open-jaw")?.[0]?.state).toBe("unresolved");
  });
});

describe("deduplication", () => {
  it("asks one question for candidates wanting the same bed", async () => {
    const asked: StaySearchQuery[] = [];
    const result = await searchAccommodation([rome, romeAgain], {
      ...base,
      budget: budgetOf(10),
      provider: provider((query) => [stayFor(query, 30000)], asked),
    });
    // Same city, dates and party: one query, both candidates priced.
    expect(asked).toHaveLength(1);
    expect(result.queriesPlanned).toBe(1);
    expect(result.queriesMade).toBe(1);
    expect(result.byCandidate.get("rome")?.[0]?.state).toBe("priced");
    expect(result.byCandidate.get("rome-again")?.[0]?.state).toBe("priced");
  });

  it("keys a search on city, dates, party and currency", () => {
    const interval = rome.stayIntervals[0];
    if (interval === undefined) throw new Error("expected a stay");
    const query: StaySearchQuery = {
      city: ROME,
      checkIn: interval.checkIn,
      checkOut: interval.checkOut,
      guests: 2,
      rooms: 1,
      currency: "EUR",
    };
    expect(stayQueryKey(query)).toBe(stayQueryKey({ ...query }));
    expect(stayQueryKey({ ...query, guests: 3 })).not.toBe(stayQueryKey(query));
    expect(stayQueryKey({ ...query, city: MILAN })).not.toBe(stayQueryKey(query));
  });
});

describe("when a provider disappoints", () => {
  it("separates an empty answer from an unreachable provider", async () => {
    const empty = await searchAccommodation([rome], {
      ...base,
      budget: budgetOf(10),
      provider: provider(() => []),
    });
    const outage = await searchAccommodation([rome], {
      ...base,
      budget: budgetOf(10),
      provider: provider(() => "fail"),
    });
    const [emptyEntry] = empty.byCandidate.get("rome") ?? [];
    const [outageEntry] = outage.byCandidate.get("rome") ?? [];
    expect(emptyEntry).toMatchObject({ state: "unpriced", reason: "provider_no_results" });
    expect(outageEntry).toMatchObject({ state: "unpriced", reason: "provider_unavailable" });
  });

  it("leaves the transport candidate intact when a provider fails", async () => {
    const result = await searchAccommodation([rome, viaMilan], {
      ...base,
      budget: budgetOf(10),
      provider: provider(() => "fail"),
    });
    // Both candidates still have coverage for every stay; nothing vanished.
    expect(result.byCandidate.size).toBe(2);
    expect(result.byCandidate.get("via-milan")).toHaveLength(2);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it("prices what it can when only one search fails", async () => {
    const result = await searchAccommodation([viaMilan], {
      ...base,
      budget: budgetOf(10),
      provider: provider((query) => (query.city.id === MILAN.id ? "fail" : [stayFor(query, 20000)])),
    });
    const entries = result.byCandidate.get("via-milan") ?? [];
    expect(entries[0]?.state).toBe("priced");
    expect(entries[1]).toMatchObject({ state: "unpriced", reason: "provider_unavailable" });
  });
});

describe("budget", () => {
  it("stops at its own limit and records what it did not ask", async () => {
    const budget = budgetOf(1);
    const asked: StaySearchQuery[] = [];
    const result = await searchAccommodation([viaMilan], {
      ...base,
      budget,
      provider: provider((query) => [stayFor(query, 30000)], asked),
    });
    expect(asked).toHaveLength(1);
    expect(result.queriesPlanned).toBe(2);
    expect(result.queriesMade).toBe(1);
    expect(budget.skipped).toHaveLength(1);
    expect(budget.skipped[0]).toMatchObject({ stage: "accommodation", reason: "call_budget" });
    // The unasked stay is not searched, never "unpriced".
    expect(result.byCandidate.get("via-milan")?.[1]?.state).toBe("not_searched");
  });

  it("never touches the transport budget", async () => {
    const transport = createSearchBudget(12);
    spend(transport, 12);
    const budget = budgetOf(5);
    await searchAccommodation([viaMilan], {
      ...base,
      budget,
      provider: provider((query) => [stayFor(query, 30000)]),
    });
    // Transport was already exhausted, and accommodation went ahead regardless.
    expect(transport.usedProviderCalls).toBe(12);
    expect(budget.usedProviderCalls).toBe(2);
  });

  it("asks nothing at all with no budget", async () => {
    const asked: StaySearchQuery[] = [];
    await searchAccommodation([rome], {
      ...base,
      budget: budgetOf(0),
      provider: provider((query) => [stayFor(query, 30000)], asked),
    });
    expect(asked).toEqual([]);
  });
});

describe("provenance", () => {
  it("keeps the provider's own provenance on every priced stay", async () => {
    const result = await searchAccommodation([rome], {
      ...base,
      budget: budgetOf(10),
      provider: provider((query) => [stayFor(query, 30000)]),
    });
    const [entry] = result.byCandidate.get("rome") ?? [];
    expect(entry?.state === "priced" && entry.stay.provenance).toMatchObject({
      provider: "fixture-stays",
      sourceType: "cached",
      fetchedAt: parseUtcInstant("2026-09-18T09:00:00Z"),
    });
  });
});

describe("attaching coverage and ranking", () => {
  const priced = (candidate: RankedCandidate, amountMinor: number) => {
    const entries = candidate.stayIntervals.map((interval) => ({
      state: "priced" as const,
      city: interval.cities[0],
      checkIn: interval.checkIn,
      checkOut: interval.checkOut,
      nights: interval.nights,
      stay: stayFor(
        {
          city: interval.cities[0],
          checkIn: interval.checkIn,
          checkOut: interval.checkOut,
          guests: 2,
          rooms: 1,
          currency: "EUR",
        },
        amountMinor,
      ),
    }));
    const result = applyAccommodation(candidate, entries);
    if (!result.ok) throw new Error(result.issues.map((issue) => issue.code).join(", "));
    return result.candidate;
  };

  const unsearched = (candidate: RankedCandidate) => {
    const result = applyAccommodation(
      candidate,
      candidate.stayIntervals.map((interval) => ({
        state: "not_searched" as const,
        reason: "no_provider" as const,
        city: interval.cities[0],
        checkIn: interval.checkIn,
        checkOut: interval.checkOut,
        nights: interval.nights,
      })),
    );
    if (!result.ok) throw new Error(result.issues.map((issue) => issue.code).join(", "));
    return result.candidate;
  };

  it("writes coverage and its priced stays together", () => {
    const complete = priced(rome, 30000);
    expect(complete.summary.cost.accommodation).toEqual({ amountMinor: 30000, currency: "EUR" });
    expect(complete.summary.cost.exclusions).toEqual([]);
    expect(comparisonClass(complete)).toBe(0);
  });

  it("puts a complete trip ahead of a cheaper one with an unpriced stay", () => {
    const complete = priced(rome, 30000);
    const incomplete = unsearched(romeAgain);
    expect(incomplete.summary.cost.total.amountMinor).toBeLessThan(
      complete.summary.cost.total.amountMinor,
    );
    // Cheaper, and still second: its number is not a total.
    expect([complete, incomplete].sort(compareCandidates).map((c) => c.candidate.id)).toEqual([
      "rome",
      "rome-again",
    ]);
    expect([incomplete, complete].sort(compareCandidates).map((c) => c.candidate.id)).toEqual([
      "rome",
      "rome-again",
    ]);
  });

  it("holds for a searched-but-empty stay as much as an unsearched one", async () => {
    const complete = priced(rome, 30000);
    const empty = await searchAccommodation([romeAgain], {
      ...base,
      budget: budgetOf(10),
      provider: provider(() => []),
    });
    const attached = applyAccommodation(
      romeAgain,
      empty.byCandidate.get("rome-again") ?? [],
    );
    if (!attached.ok) throw new Error("expected a candidate");
    expect(comparisonClass(attached.candidate)).toBe(1);
    expect([attached.candidate, complete].sort(compareCandidates)[0]?.candidate.id).toBe("rome");
  });

  it("orders two incomplete candidates by what is known", () => {
    const cheap = unsearched(rome);
    const dear = unsearched(viaMilan);
    expect(comparisonClass(cheap)).toBe(comparisonClass(dear));
    const ordered = [dear, cheap].sort(compareCandidates).map((c) => c.candidate.id);
    expect(ordered[0]).toBe("rome");
  });

  it("leaves every candidate in one class when no provider exists", async () => {
    const result = await searchAccommodation([rome, viaMilan], { ...base, budget: budgetOf(10) });
    const attached = [rome, viaMilan].map((entry) => {
      const applied = applyAccommodation(entry, result.byCandidate.get(entry.candidate.id) ?? []);
      if (!applied.ok) throw new Error("expected a candidate");
      return applied.candidate;
    });
    // All class 1 together, so their order is exactly the transport order.
    expect(attached.map(comparisonClass)).toEqual([1, 1]);
    expect(attached.every((entry) => entry.summary.cost.accommodation.amountMinor === 0)).toBe(
      true,
    );
  });

  it("lets an accommodation price reorder the complete class", () => {
    // Rome's flights are cheaper, but its bed is dearer.
    const dearBed = priced(rome, 90000);
    const cheapBed = priced(viaMilan, 10000);
    expect(
      [dearBed, cheapBed].sort(compareCandidates).map((entry) => entry.candidate.id)[0],
    ).toBe("via-milan");
  });

  it("keeps an unresolved trip below both, and adds no amount", () => {
    const result = applyAccommodation(
      openJaw,
      openJaw.stayIntervals.map((interval) => ({
        state: "unresolved" as const,
        reason: "unresolved_open_jaw_split" as const,
        cities: [...interval.cities],
        checkIn: interval.checkIn,
        checkOut: interval.checkOut,
        nights: interval.nights,
      })),
    );
    if (!result.ok) throw new Error("expected a candidate");
    expect(comparisonClass(result.candidate)).toBe(2);
    expect(result.candidate.summary.cost.accommodation.amountMinor).toBe(0);
    expect(result.candidate.summary.cost.exclusions).toContain("unresolved_accommodation");
  });

  it("keeps the two views of a priced stay in step", () => {
    // The dual write is the trap: coverage and priced stays are two views of
    // one fact, and the domain rejects a trip where they disagree. Deriving
    // both from the same entries is what makes disagreement impossible.
    const complete = priced(viaMilan, 20000);
    expect(complete.candidate.stays.map((stay) => stay.id)).toEqual(
      complete.candidate.accommodation.flatMap((entry) =>
        entry.state === "priced" ? [entry.stay.id] : [],
      ),
    );
    // And it summarizes cleanly rather than vanishing as invalid.
    expect(complete.summary.cost.accommodation.amountMinor).toBe(40000);
  });

  it("carries no priced stay for coverage that has none", () => {
    const incomplete = unsearched(viaMilan);
    expect(incomplete.candidate.stays).toEqual([]);
    expect(incomplete.candidate.accommodation).toHaveLength(2);
  });
});
