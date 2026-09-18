import { describe, expect, it } from "vitest";

import { distanceKm } from "./distance.js";

const LONDON = { latitude: 51.5074, longitude: -0.1278 };
const PARIS = { latitude: 48.8566, longitude: 2.3522 };
const ROME = { latitude: 41.9028, longitude: 12.4964 };
const MILAN = { latitude: 45.4642, longitude: 9.19 };
const SARAJEVO = { latitude: 43.8563, longitude: 18.4131 };

describe("distanceKm", () => {
  it("matches published great-circle distances", () => {
    expect(distanceKm(LONDON, PARIS)).toBeCloseTo(343.5, 0);
    expect(distanceKm(ROME, MILAN)).toBeCloseTo(477, 0);
  });

  it("is zero for the same point", () => {
    expect(distanceKm(SARAJEVO, SARAJEVO)).toBe(0);
  });

  it("is symmetric", () => {
    expect(distanceKm(LONDON, ROME)).toBeCloseTo(distanceKm(ROME, LONDON), 9);
  });

  it("handles antipodal points without NaN", () => {
    const antipode = { latitude: -SARAJEVO.latitude, longitude: SARAJEVO.longitude - 180 };
    const distance = distanceKm(SARAJEVO, antipode);
    expect(Number.isNaN(distance)).toBe(false);
    // Half the Earth's circumference, about 20,015 km.
    expect(distance).toBeCloseTo(20015, -1);
  });

  it("handles crossing the antimeridian", () => {
    const west = { latitude: 0, longitude: 179.9 };
    const east = { latitude: 0, longitude: -179.9 };
    // 0.2 degrees at the equator is about 22 km, not most of the way round.
    expect(distanceKm(west, east)).toBeCloseTo(22.2, 0);
  });

  it("handles the poles", () => {
    const northPole = { latitude: 90, longitude: 0 };
    const southPole = { latitude: -90, longitude: 137 };
    expect(distanceKm(northPole, southPole)).toBeCloseTo(20015, -1);
  });

  it("is small for airports within one metropolitan area", () => {
    const fiumicino = { latitude: 41.8003, longitude: 12.2389 };
    const ciampino = { latitude: 41.7994, longitude: 12.5949 };
    expect(distanceKm(fiumicino, ciampino)).toBeGreaterThan(25);
    expect(distanceKm(fiumicino, ciampino)).toBeLessThan(35);
  });
});
