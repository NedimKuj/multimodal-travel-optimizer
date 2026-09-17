import { describe, expect, it } from "vitest";

import {
  addDays,
  compareLocalDates,
  daysBetween,
  localDateSchema,
  parseLocalDate,
} from "./local-date.js";

describe("LocalDate", () => {
  it("accepts valid calendar dates", () => {
    expect(parseLocalDate("2026-12-26")).toBe("2026-12-26");
    expect(parseLocalDate("2028-02-29")).toBe("2028-02-29");
  });

  it("rejects invalid or non-canonical dates", () => {
    for (const input of [
      "2026-02-29",
      "2026-13-01",
      "2026-00-10",
      "2026-04-31",
      "2026-1-1",
      "26-12-2026",
      "2026-12-26T00:00:00Z",
      "",
    ]) {
      expect(localDateSchema.safeParse(input).success, input).toBe(false);
    }
  });

  it("adds days across month and year boundaries", () => {
    const boxingDay = parseLocalDate("2026-12-26");
    expect(addDays(boxingDay, 6)).toBe("2027-01-01");
    expect(addDays(boxingDay, -2)).toBe("2026-12-24");
    expect(addDays(parseLocalDate("2028-02-28"), 1)).toBe("2028-02-29");
    expect(addDays(parseLocalDate("2027-02-28"), 1)).toBe("2027-03-01");
  });

  it("is unaffected by DST transitions", () => {
    expect(daysBetween(parseLocalDate("2026-10-24"), parseLocalDate("2026-10-26"))).toBe(2);
    expect(daysBetween(parseLocalDate("2026-03-28"), parseLocalDate("2026-03-30"))).toBe(2);
  });

  it("counts days between dates, including across years", () => {
    expect(daysBetween(parseLocalDate("2026-12-26"), parseLocalDate("2027-01-03"))).toBe(8);
    expect(daysBetween(parseLocalDate("2027-01-03"), parseLocalDate("2026-12-26"))).toBe(-8);
  });

  it("rejects non-integer day offsets", () => {
    expect(() => addDays(parseLocalDate("2026-12-26"), 0.5)).toThrow(/integer/);
  });

  it("compares dates", () => {
    const a = parseLocalDate("2026-12-31");
    const b = parseLocalDate("2027-01-01");
    expect(compareLocalDates(a, b)).toBe(-1);
    expect(compareLocalDates(b, a)).toBe(1);
    expect(compareLocalDates(a, a)).toBe(0);
  });
});
