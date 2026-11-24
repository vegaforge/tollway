/**
 * Calendar period keys and time zone helpers for periodic budgets (#198).
 *
 * Uses the runtime's built-in `Intl.DateTimeFormat` with IANA time zones so
 * calendar-day, weekly, and monthly boundaries follow local wall-clock time
 * across Daylight Saving Time transitions with zero external dependencies.
 */

export type WeekStartsOn = "monday" | "sunday";

type LocalDateParts = {
  year: number;
  month: number;
  day: number;
  weekday: number;
};

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour12: false,
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Returns true when `timeZone` is accepted by `Intl.DateTimeFormat`. */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim() === "") return false;
  try {
    getFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function localDateParts(timestampMs: number, timeZone: string): LocalDateParts {
  const parts = getFormatter(timeZone).formatToParts(new Date(timestampMs));
  let year = 0;
  let month = 0;
  let day = 0;
  let weekday = 0;
  for (const part of parts) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
    else if (part.type === "weekday") weekday = WEEKDAY_INDEX[part.value] ?? 0;
  }
  return { year, month, day, weekday };
}

/** Returns `YYYY-MM-DD` for `timestampMs` in `timeZone`. */
export function calendarDayKey(timestampMs: number, timeZone = "UTC"): string {
  const { year, month, day } = localDateParts(timestampMs, timeZone);
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

/** Returns `YYYY-MM` for `timestampMs` in `timeZone`. */
export function calendarMonthKey(timestampMs: number, timeZone = "UTC"): string {
  const { year, month } = localDateParts(timestampMs, timeZone);
  return `${String(year).padStart(4, "0")}-${pad2(month)}`;
}

/**
 * Returns the `YYYY-MM-DD` date of the first day of the calendar week
 * containing `timestampMs` in `timeZone`.
 */
export function calendarWeekKey(
  timestampMs: number,
  timeZone = "UTC",
  weekStartsOn: WeekStartsOn = "monday",
): string {
  const { year, month, day, weekday } = localDateParts(timestampMs, timeZone);
  const offset = weekStartsOn === "sunday" ? weekday : (weekday + 6) % 7;
  // Pure calendar-date arithmetic in UTC avoids any local DST distortion
  // when subtracting up to 6 days from the already-resolved local date.
  const weekStart = new Date(Date.UTC(year, month - 1, day - offset));
  return weekStart.toISOString().slice(0, 10);
}
