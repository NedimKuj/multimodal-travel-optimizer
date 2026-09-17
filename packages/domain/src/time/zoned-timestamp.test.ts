import { describe, expect, it } from "vitest";

import {
  addMinutes,
  compareZonedTimestamps,
  localDate,
  localDateTime,
  minutesBetween,
  parseTimeZoneId,
  parseUtcInstant,
  timeZoneIdSchema,
  utcInstantSchema,
  zonedTimestampFromOffsetIso,
  zonedTimestampSchema,
} from "./zoned-timestamp.js";

describe("time zone identifiers", () => {
  it("accepts IANA zones", () => {
    expect(parseTimeZoneId("Europe/Sarajevo")).toBe("Europe/Sarajevo");
    expect(parseTimeZoneId("UTC")).toBe("UTC");
  });

  it("normalizes spelling to the runtime's canonical form", () => {
    expect(parseTimeZoneId("europe/sarajevo")).toBe("Europe/Sarajevo");
    expect(parseTimeZoneId("Etc/UTC")).toBe("UTC");
  });

  it("rejects unknown zones and fixed offsets", () => {
    for (const input of ["Europe/Atlantis", "+01:00", "GMT+1", "", "CET DST"]) {
      expect(timeZoneIdSchema.safeParse(input).success, input).toBe(false);
    }
  });
});

describe("UTC instants", () => {
  it("normalizes explicit offsets to UTC", () => {
    expect(parseUtcInstant("2026-12-26T22:30+01:00")).toBe("2026-12-26T21:30:00.000Z");
    expect(parseUtcInstant("2026-12-26T21:30:00Z")).toBe("2026-12-26T21:30:00.000Z");
    expect(parseUtcInstant("2026-12-27T00:30:00.5-05:00")).toBe("2026-12-27T05:30:00.500Z");
  });

  it("rejects naive timestamps without an offset", () => {
    for (const input of ["2026-12-26T22:30", "2026-12-26T22:30:00", "2026-12-26 22:30+01:00"]) {
      expect(utcInstantSchema.safeParse(input).success, input).toBe(false);
    }
    expect(() => parseUtcInstant("2026-12-26T22:30")).toThrow(/explicit UTC offset/);
  });

  it("rejects impossible calendar values instead of rolling them over", () => {
    for (const input of ["2026-02-30T10:00Z", "2026-12-26T24:00Z", "2026-12-26T10:60Z"]) {
      expect(utcInstantSchema.safeParse(input).success, input).toBe(false);
    }
  });
});

describe("zonedTimestampFromOffsetIso", () => {
  it("keeps the instant and the zone", () => {
    const departure = zonedTimestampFromOffsetIso("2026-12-26T22:30+01:00", "Europe/Sarajevo");
    expect(departure).toEqual({
      instant: "2026-12-26T21:30:00.000Z",
      timeZone: "Europe/Sarajevo",
    });
  });

  it("rejects an offset that does not match the zone at that instant", () => {
    // Sarajevo is on CET (+01:00) in December, not CEST.
    expect(() =>
      zonedTimestampFromOffsetIso("2026-12-26T22:30+02:00", "Europe/Sarajevo"),
    ).toThrow(/does not match/);
  });

  it("accepts Z-designated instants for any zone", () => {
    const arrival = zonedTimestampFromOffsetIso("2026-12-26T22:35:00Z", "Europe/Vienna");
    expect(localDateTime(arrival).time).toBe("23:35:00");
  });

  it("rejects naive strings", () => {
    expect(() => zonedTimestampFromOffsetIso("2026-12-26T22:30", "Europe/Sarajevo")).toThrow(
      /explicit UTC offset/,
    );
  });

  it("validates schema input", () => {
    expect(
      zonedTimestampSchema.safeParse({ instant: "2026-12-26T21:30:00Z", timeZone: "Europe/Vienna" })
        .success,
    ).toBe(true);
    expect(
      zonedTimestampSchema.safeParse({ instant: "2026-12-26T21:30:00", timeZone: "Europe/Vienna" })
        .success,
    ).toBe(false);
  });
});

describe("local dates from instants", () => {
  it("crosses into the next calendar year locally before UTC does", () => {
    const timestamp = zonedTimestampFromOffsetIso("2026-12-31T23:30:00Z", "Europe/Sarajevo");
    expect(localDate(timestamp)).toBe("2027-01-01");
    expect(localDateTime(timestamp)).toMatchObject({ time: "00:30:00", offset: "+01:00" });
  });

  it("derives the same instant's local date differently per zone", () => {
    const instant = parseUtcInstant("2026-12-27T03:00:00Z");
    expect(localDate({ instant, timeZone: parseTimeZoneId("Europe/Istanbul") })).toBe("2026-12-27");
    expect(localDate({ instant, timeZone: parseTimeZoneId("America/New_York") })).toBe(
      "2026-12-26",
    );
  });

  it("handles the autumn DST change (2026-10-25, Europe)", () => {
    const zone = "Europe/Sarajevo";
    const beforeChange = zonedTimestampFromOffsetIso("2026-10-25T02:30+02:00", zone);
    const afterChange = zonedTimestampFromOffsetIso("2026-10-25T02:30+01:00", zone);
    expect(localDateTime(beforeChange)).toMatchObject({ time: "02:30:00", offset: "+02:00" });
    expect(localDateTime(afterChange)).toMatchObject({ time: "02:30:00", offset: "+01:00" });
    // Same wall-clock time, one real hour apart.
    expect(minutesBetween(beforeChange, afterChange)).toBe(60);
  });

  it("handles the spring DST change (2026-03-29, Europe)", () => {
    const zone = "Europe/Vienna";
    const before = zonedTimestampFromOffsetIso("2026-03-29T01:30+01:00", zone);
    const after = addMinutes(before, 60);
    expect(localDateTime(after)).toMatchObject({ time: "03:30:00", offset: "+02:00" });
  });
});

describe("comparisons and durations", () => {
  it("compares absolute instants across zones", () => {
    // 23:30 in Istanbul (+03:00) happens before 23:00 in Sarajevo (+01:00).
    const sarajevo = zonedTimestampFromOffsetIso("2026-12-26T23:00+01:00", "Europe/Sarajevo");
    const istanbul = zonedTimestampFromOffsetIso("2026-12-26T23:30+03:00", "Europe/Istanbul");
    expect(compareZonedTimestamps(istanbul, sarajevo)).toBe(-1);
    expect(compareZonedTimestamps(sarajevo, istanbul)).toBe(1);
    expect(compareZonedTimestamps(sarajevo, sarajevo)).toBe(0);
  });

  it("measures overnight journeys crossing midnight and time zones", () => {
    const departure = zonedTimestampFromOffsetIso("2026-12-26T22:30+01:00", "Europe/Sarajevo");
    const arrival = zonedTimestampFromOffsetIso("2026-12-27T02:15+03:00", "Europe/Istanbul");
    expect(minutesBetween(departure, arrival)).toBe(105);
    expect(localDate(departure)).toBe("2026-12-26");
    expect(localDate(arrival)).toBe("2026-12-27");
  });
});
