import { z } from "zod";

import { DomainError } from "../errors.js";
import { parseLocalDate, type LocalDate } from "./local-date.js";

// See docs/decisions/0003-zoned-timestamps.md.

const MS_PER_MINUTE = 60_000;

function canonicalTimeZone(value: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * An IANA time zone identifier accepted by the runtime's ICU data, normalized
 * to the runtime's canonical spelling. Fixed-offset strings ("+01:00") are not
 * time zones and are rejected.
 */
export const timeZoneIdSchema = z
  .string()
  .regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/, {
    message: "Expected an IANA time zone identifier (e.g. Europe/Sarajevo)",
  })
  .transform((value, context) => {
    const canonical = canonicalTimeZone(value);
    if (canonical === undefined) {
      context.addIssue({ code: "custom", message: `Unknown IANA time zone: ${value}` });
      return z.NEVER;
    }
    return canonical;
  })
  .brand<"TimeZoneId">();

export type TimeZoneId = z.infer<typeof timeZoneIdSchema>;

export function parseTimeZoneId(value: string): TimeZoneId {
  const result = timeZoneIdSchema.safeParse(value);
  if (!result.success) {
    throw new DomainError("INVALID_TIME_ZONE", `Invalid IANA time zone: ${JSON.stringify(value)}`);
  }
  return result.data;
}

// YYYY-MM-DDTHH:mm[:ss[.fff]] followed by a mandatory Z or ±HH:MM offset.
const OFFSET_ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

const OFFSET_PATTERN = /^([+-])(\d{2}):(\d{2})$/;

interface ParsedOffsetIso {
  readonly epochMilliseconds: number;
  /** Minutes east of UTC, or `undefined` for a `Z` designator. */
  readonly offsetMinutes: number | undefined;
}

function parseOffsetMinutes(offset: string): number | undefined {
  const match = OFFSET_PATTERN.exec(offset);
  if (match === null) return undefined;
  const [, sign, hh = "", mm = ""] = match;
  const hours = Number(hh);
  const minutes = Number(mm);
  if (hours > 23 || minutes > 59) return undefined;
  return (sign === "-" ? -1 : 1) * (hours * 60 + minutes);
}

function parseOffsetIso(value: string): ParsedOffsetIso | undefined {
  const match = OFFSET_ISO_PATTERN.exec(value);
  if (match === null) return undefined;
  const [, y = "", mo = "", d = "", h = "", mi = "", s = "0", ms = "0", designator = ""] = match;
  const fields = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: Number(s),
    millisecond: Number(ms.padEnd(3, "0")),
  };

  const wallClock = new Date(0);
  wallClock.setUTCFullYear(fields.year, fields.month - 1, fields.day);
  wallClock.setUTCHours(fields.hour, fields.minute, fields.second, fields.millisecond);
  if (
    wallClock.getUTCFullYear() !== fields.year ||
    wallClock.getUTCMonth() !== fields.month - 1 ||
    wallClock.getUTCDate() !== fields.day ||
    wallClock.getUTCHours() !== fields.hour ||
    wallClock.getUTCMinutes() !== fields.minute ||
    wallClock.getUTCSeconds() !== fields.second
  ) {
    return undefined;
  }

  if (designator === "Z") {
    return { epochMilliseconds: wallClock.getTime(), offsetMinutes: undefined };
  }
  const offsetMinutes = parseOffsetMinutes(designator);
  if (offsetMinutes === undefined) return undefined;
  return {
    epochMilliseconds: wallClock.getTime() - offsetMinutes * MS_PER_MINUTE,
    offsetMinutes,
  };
}

/**
 * An absolute instant as canonical ISO-8601 UTC (`2026-12-26T21:30:00.000Z`).
 *
 * Input may carry any explicit offset; naive strings without an offset are
 * rejected. The stored form is always normalized to UTC.
 */
export const utcInstantSchema = z
  .string()
  .transform((value, context) => {
    const parsed = parseOffsetIso(value);
    if (parsed === undefined) {
      context.addIssue({
        code: "custom",
        message: "Expected an ISO-8601 timestamp with an explicit Z or ±HH:MM offset",
      });
      return z.NEVER;
    }
    return new Date(parsed.epochMilliseconds).toISOString();
  })
  .brand<"UtcInstant">();

export type UtcInstant = z.infer<typeof utcInstantSchema>;

export function parseUtcInstant(value: string): UtcInstant {
  const result = utcInstantSchema.safeParse(value);
  if (!result.success) {
    throw new DomainError(
      "INVALID_INSTANT",
      `Invalid timestamp ${JSON.stringify(value)}: an explicit UTC offset is required`,
    );
  }
  return result.data;
}

export function instantFromEpochMilliseconds(epochMilliseconds: number): UtcInstant {
  if (!Number.isFinite(epochMilliseconds)) {
    throw new DomainError("INVALID_INSTANT", "Epoch milliseconds must be finite");
  }
  return parseUtcInstant(new Date(epochMilliseconds).toISOString());
}

export function instantEpochMilliseconds(instant: UtcInstant): number {
  return Date.parse(instant);
}

/**
 * A transport timestamp: an absolute instant plus the IANA zone in which it is
 * observed locally (normally the zone of the departure/arrival location).
 */
export interface ZonedTimestamp {
  readonly instant: UtcInstant;
  readonly timeZone: TimeZoneId;
}

export const zonedTimestampSchema = z.object({
  instant: utcInstantSchema,
  timeZone: timeZoneIdSchema,
});

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: TimeZoneId): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export interface LocalDateTime {
  /** Local calendar date in the timestamp's zone. */
  readonly date: LocalDate;
  /** Local wall-clock time, `HH:mm:ss`. */
  readonly time: string;
  /** UTC offset in effect at that instant, `±HH:MM`. */
  readonly offset: string;
  readonly offsetMinutes: number;
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

export function localDateTime(timestamp: ZonedTimestamp): LocalDateTime {
  const parts = formatterFor(timestamp.timeZone).formatToParts(
    instantEpochMilliseconds(timestamp.instant),
  );
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((candidate) => candidate.type === type);
    if (found === undefined) {
      throw new DomainError("TIME_FORMAT_FAILURE", `Missing ${type} for ${timestamp.timeZone}`);
    }
    return found.value;
  };

  // longOffset renders "GMT" for UTC and "GMT+01:00" otherwise.
  const zoneName = part("timeZoneName");
  const offsetMinutes = zoneName === "GMT" ? 0 : parseOffsetMinutes(zoneName.replace("GMT", ""));
  if (offsetMinutes === undefined) {
    throw new DomainError("TIME_FORMAT_FAILURE", `Unexpected offset format ${zoneName}`);
  }

  return {
    date: parseLocalDate(`${part("year")}-${part("month")}-${part("day")}`),
    time: `${part("hour")}:${part("minute")}:${part("second")}`,
    offset: formatOffset(offsetMinutes),
    offsetMinutes,
  };
}

export function localDate(timestamp: ZonedTimestamp): LocalDate {
  return localDateTime(timestamp).date;
}

/**
 * Builds a ZonedTimestamp from a provider string with an explicit offset.
 *
 * If the string carries a numeric offset, it must equal the zone's actual
 * offset at that instant; a mismatch means the provider data and our location
 * data disagree, and is rejected rather than silently corrected.
 */
export function zonedTimestampFromOffsetIso(value: string, timeZone: string): ZonedTimestamp {
  const zone = parseTimeZoneId(timeZone);
  const parsed = parseOffsetIso(value);
  if (parsed === undefined) {
    throw new DomainError(
      "INVALID_INSTANT",
      `Invalid timestamp ${JSON.stringify(value)}: an explicit UTC offset is required`,
    );
  }
  const timestamp: ZonedTimestamp = {
    instant: instantFromEpochMilliseconds(parsed.epochMilliseconds),
    timeZone: zone,
  };
  if (parsed.offsetMinutes !== undefined) {
    const actual = localDateTime(timestamp).offsetMinutes;
    if (actual !== parsed.offsetMinutes) {
      throw new DomainError(
        "TIME_ZONE_OFFSET_MISMATCH",
        `Offset ${formatOffset(parsed.offsetMinutes)} in ${JSON.stringify(value)} does not match ${zone} (${formatOffset(actual)}) at that instant`,
      );
    }
  }
  return timestamp;
}

export function compareInstants(a: UtcInstant, b: UtcInstant): -1 | 0 | 1 {
  const difference = instantEpochMilliseconds(a) - instantEpochMilliseconds(b);
  if (difference === 0) return 0;
  return difference < 0 ? -1 : 1;
}

/** Orders timestamps by absolute instant, regardless of their zones. */
export function compareZonedTimestamps(a: ZonedTimestamp, b: ZonedTimestamp): -1 | 0 | 1 {
  return compareInstants(a.instant, b.instant);
}

export function millisecondsBetween(from: ZonedTimestamp, to: ZonedTimestamp): number {
  return instantEpochMilliseconds(to.instant) - instantEpochMilliseconds(from.instant);
}

/** Elapsed minutes between two instants; fractional when seconds differ. */
export function minutesBetween(from: ZonedTimestamp, to: ZonedTimestamp): number {
  return millisecondsBetween(from, to) / MS_PER_MINUTE;
}

export function addMinutes(timestamp: ZonedTimestamp, minutes: number): ZonedTimestamp {
  if (!Number.isFinite(minutes)) {
    throw new DomainError("INVALID_DURATION", "Minutes must be finite");
  }
  return {
    instant: instantFromEpochMilliseconds(
      instantEpochMilliseconds(timestamp.instant) + minutes * MS_PER_MINUTE,
    ),
    timeZone: timestamp.timeZone,
  };
}
