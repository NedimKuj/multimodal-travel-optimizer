import type { Location } from "@travel-optimizer/domain";

/*
 * Mixed return-candidate discovery (ADR 0015 §7).
 *
 * A way home is wanted from every place an itinerary could end: the
 * destinations stage 1 found, and the second cities stage 3 reaches. Both go
 * into one pool, ranked by what it is already known to cost to get there.
 *
 * The pool is keyed by the **return airport**, because that is what a provider
 * query actually asks about: `FCO -> SJJ` and `CIA -> SJJ` are different
 * searches, and an itinerary ending at Ciampino must not quietly acquire a fare
 * leaving from Fiumicino because both are called Rome. The city is carried
 * alongside for grouping and presentation (ADR 0010), never as the key.
 *
 * The ranking uses only fares already retrieved. The `B -> SJJ` fare is
 * precisely what the query would discover, so it can play no part in deciding
 * whether to make it, and is never estimated in its place.
 */

export type ReachSource = "stage_1" | "onward";

/** How the traveler gets to a candidate, and what that is known to cost. */
export interface ReachPath {
  /** Airports passed through, home excluded: `[A]` direct, `[A, B]` onward. */
  readonly via: readonly Location[];
  /** Sum of the fares already retrieved for those legs, in minor units. */
  readonly reachCostMinor: number;
  readonly source: ReachSource;
}

export interface ReturnCandidate {
  /** Where the traveler arrives, and so where a return query departs from. */
  readonly airport: Location;
  /** The city it serves, when the reference data resolves one. */
  readonly city: Location | undefined;
  readonly path: ReachPath;
}

/**
 * Cheapest known reach cost first.
 *
 * Then a direct destination ahead of one reached through another city, then
 * the city, then the airport: a total order, so a run repeats exactly.
 */
export function compareReturnCandidates(a: ReturnCandidate, b: ReturnCandidate): number {
  return (
    a.path.reachCostMinor - b.path.reachCostMinor ||
    a.path.via.length - b.path.via.length ||
    (a.city?.id ?? a.airport.id).localeCompare(b.city?.id ?? b.airport.id) ||
    a.airport.id.localeCompare(b.airport.id)
  );
}

export interface ReturnPool {
  /**
   * Adds a candidate, or replaces a waiting one when this path reaches the
   * same airport more cheaply. An airport already settled is left alone.
   */
  offer: (candidate: ReturnCandidate) => void;
  /** The best candidate still waiting, without settling it. */
  peek: () => ReturnCandidate | undefined;
  /** Settles and returns the best candidate: it is never offered again. */
  take: () => ReturnCandidate | undefined;
  /** Everything still waiting, in the order it would have been taken. */
  remaining: () => ReturnCandidate[];
  /**
   * Whether the pool has ever held this airport, waiting or settled.
   *
   * Callers that record what was never considered use this to stay out of the
   * pool's way: an airport the pool reached is accounted for by the pool, and
   * reporting it a second time would contradict the first.
   */
  knows: (airportId: string) => boolean;
  size: () => number;
}

export function createReturnPool(): ReturnPool {
  const waiting = new Map<string, ReturnCandidate>();
  // Airports already taken from the pool, whether or not a call followed. An
  // airport is decided once: never queried twice, and never re-queued after
  // the budget has already refused it.
  const settled = new Set<string>();

  const best = (): ReturnCandidate | undefined => {
    let winner: ReturnCandidate | undefined;
    for (const candidate of waiting.values()) {
      if (winner === undefined || compareReturnCandidates(candidate, winner) < 0) {
        winner = candidate;
      }
    }
    return winner;
  };

  return {
    offer: (candidate) => {
      const key = candidate.airport.id;
      if (settled.has(key)) return;
      const existing = waiting.get(key);
      if (existing === undefined || compareReturnCandidates(candidate, existing) < 0) {
        waiting.set(key, candidate);
      }
    },
    peek: best,
    take: () => {
      const winner = best();
      if (winner === undefined) return undefined;
      waiting.delete(winner.airport.id);
      settled.add(winner.airport.id);
      return winner;
    },
    remaining: () => [...waiting.values()].sort(compareReturnCandidates),
    knows: (airportId) => waiting.has(airportId) || settled.has(airportId),
    size: () => waiting.size,
  };
}
