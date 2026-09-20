import { describe, expect, it } from "vitest";

import { createReturnPool, type ReturnCandidate } from "./return-pool.js";
import { CIA, FCO, MILAN, MXP, ROME, SAW } from "./test-fixtures.js";

/*
 * The mixed return-candidate pool (ADR 0015 §7).
 *
 * Keyed by the return airport, because that is what a provider query asks
 * about. Prices here are test inputs, and no test touches the network.
 */

function direct(airport: typeof FCO, city: typeof ROME | undefined, minor: number): ReturnCandidate {
  return {
    airport,
    city,
    path: { via: [airport], reachCostMinor: minor, source: "stage_1" },
  };
}

function onward(
  first: typeof FCO,
  airport: typeof FCO,
  city: typeof ROME | undefined,
  minor: number,
): ReturnCandidate {
  return {
    airport,
    city,
    path: { via: [first, airport], reachCostMinor: minor, source: "onward" },
  };
}

describe("ranking", () => {
  it("takes the cheapest known reach cost first", () => {
    const pool = createReturnPool();
    pool.offer(direct(SAW, undefined, 9000));
    pool.offer(direct(FCO, ROME, 4000));
    pool.offer(direct(MXP, MILAN, 6000));
    expect(pool.remaining().map((entry) => entry.airport.iata)).toEqual(["FCO", "MXP", "SAW"]);
  });

  it("lets a cheaper second city outrank a dearer stage-1 destination", () => {
    const pool = createReturnPool();
    pool.offer(direct(SAW, undefined, 9000));
    // Reached through Rome: 40.00 out, 20.00 on. Still cheaper than Istanbul.
    pool.offer(onward(FCO, MXP, MILAN, 6000));
    expect(pool.take()?.airport.iata).toBe("MXP");
    expect(pool.take()?.airport.iata).toBe("SAW");
  });

  it("prefers a direct destination to one reached through another city, at equal cost", () => {
    const pool = createReturnPool();
    pool.offer(onward(FCO, SAW, undefined, 5000));
    pool.offer(direct(MXP, MILAN, 5000));
    expect(pool.take()?.airport.iata).toBe("MXP");
  });

  it("orders the rest by city, then airport, so a run repeats", () => {
    const build = (order: readonly ReturnCandidate[]) => {
      const pool = createReturnPool();
      for (const candidate of order) pool.offer(candidate);
      return pool.remaining().map((entry) => entry.airport.iata);
    };
    const a = direct(FCO, ROME, 5000);
    const b = direct(CIA, ROME, 5000);
    const c = direct(MXP, MILAN, 5000);
    expect(build([a, b, c])).toEqual(build([c, b, a]));
    // Milan sorts before Rome by city id; within Rome, Ciampino before Fiumicino.
    expect(build([a, b, c])).toEqual(["MXP", "CIA", "FCO"]);
  });
});

describe("keying by the return airport", () => {
  it("keeps both airports of one city, because each is its own query", () => {
    const pool = createReturnPool();
    pool.offer(direct(FCO, ROME, 4000));
    pool.offer(direct(CIA, ROME, 4200));
    expect(pool.size()).toBe(2);
    expect(pool.remaining().map((entry) => entry.airport.iata)).toEqual(["FCO", "CIA"]);
    // Same destination city, two separate ways home.
    expect(pool.remaining().every((entry) => entry.city?.iata === "ROM")).toBe(true);
  });

  it("does not let a fare from one airport stand in for its neighbour", () => {
    const pool = createReturnPool();
    pool.offer(direct(FCO, ROME, 4000));
    pool.take();
    // Ciampino is untouched by Fiumicino having been settled.
    pool.offer(onward(MXP, CIA, ROME, 5000));
    expect(pool.take()?.airport.iata).toBe("CIA");
  });

  it("queries one airport once, however many paths reach it", () => {
    const pool = createReturnPool();
    pool.offer(direct(MXP, MILAN, 6000));
    pool.offer(onward(FCO, MXP, MILAN, 5500));
    expect(pool.size()).toBe(1);
    pool.take();
    pool.offer(onward(SAW, MXP, MILAN, 5000));
    expect(pool.take()).toBeUndefined();
  });
});

describe("choosing between reach paths", () => {
  it("keeps the cheapest way of reaching an airport, with its provenance", () => {
    const pool = createReturnPool();
    pool.offer(onward(FCO, MXP, MILAN, 7000));
    pool.offer(onward(SAW, MXP, MILAN, 5000));
    const winner = pool.take();
    expect(winner?.path.reachCostMinor).toBe(5000);
    expect(winner?.path.via.map((stop) => stop.iata)).toEqual(["SAW", "MXP"]);
    expect(winner?.path.source).toBe("onward");
  });

  it("keeps a direct path when it beats the one through another city", () => {
    const pool = createReturnPool();
    pool.offer(onward(FCO, MXP, MILAN, 5500));
    pool.offer(direct(MXP, MILAN, 5000));
    const winner = pool.take();
    expect(winner?.path.source).toBe("stage_1");
    expect(winner?.path.via.map((stop) => stop.iata)).toEqual(["MXP"]);
  });

  it("does not replace a cheaper path with a dearer one that arrives later", () => {
    const pool = createReturnPool();
    pool.offer(direct(MXP, MILAN, 5000));
    pool.offer(onward(FCO, MXP, MILAN, 9000));
    expect(pool.take()?.path.reachCostMinor).toBe(5000);
  });
});

describe("what is left", () => {
  it("reports everything still waiting, in the order it would be taken", () => {
    const pool = createReturnPool();
    pool.offer(direct(SAW, undefined, 9000));
    pool.offer(direct(FCO, ROME, 4000));
    pool.take();
    expect(pool.remaining().map((entry) => entry.airport.iata)).toEqual(["SAW"]);
  });

  it("is empty before anything is offered", () => {
    const pool = createReturnPool();
    expect(pool.take()).toBeUndefined();
    expect(pool.peek()).toBeUndefined();
    expect(pool.remaining()).toEqual([]);
    expect(pool.size()).toBe(0);
  });
});
