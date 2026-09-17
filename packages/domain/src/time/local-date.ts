import { z } from "zod";

import { DomainError } from "../errors.js";

const MS_PER_DAY = 86_400_000;
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function epochDayOf(value: string): number | undefined {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (match === null) return undefined;
  const [, y = "", m = "", d = ""] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date.getTime() / MS_PER_DAY;
}

/**
 * A calendar date without time or time zone (`YYYY-MM-DD`).
 *
 * Used for search dates and stay check-in/check-out. Arithmetic is on whole
 * calendar days and never involves a time zone.
 */
export const localDateSchema = z
  .string()
  .refine((value) => epochDayOf(value) !== undefined, {
    message: "Expected a valid calendar date in YYYY-MM-DD format",
  })
  .brand<"LocalDate">();

export type LocalDate = z.infer<typeof localDateSchema>;

export function parseLocalDate(value: string): LocalDate {
  const result = localDateSchema.safeParse(value);
  if (!result.success) {
    throw new DomainError("INVALID_LOCAL_DATE", `Invalid local date: ${JSON.stringify(value)}`);
  }
  return result.data;
}

function toEpochDay(date: LocalDate): number {
  const day = epochDayOf(date);
  if (day === undefined) {
    throw new DomainError("INVALID_LOCAL_DATE", `Invalid local date: ${JSON.stringify(date)}`);
  }
  return day;
}

function fromEpochDay(epochDay: number): LocalDate {
  const iso = new Date(epochDay * MS_PER_DAY).toISOString();
  return parseLocalDate(iso.slice(0, 10));
}

export function addDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isSafeInteger(days)) {
    throw new DomainError("INVALID_DAY_COUNT", `Day count must be an integer, got ${String(days)}`);
  }
  return fromEpochDay(toEpochDay(date) + days);
}

/** Number of calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return toEpochDay(to) - toEpochDay(from);
}

export function compareLocalDates(a: LocalDate, b: LocalDate): -1 | 0 | 1 {
  const difference = daysBetween(b, a);
  if (difference === 0) return 0;
  return difference < 0 ? -1 : 1;
}
