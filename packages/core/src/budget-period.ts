/**
 * Calendar periods for budgets (#198): period ids, and the ledger that keeps
 * spend per period.
 *
 * Local dates come from `Intl.DateTimeFormat` with an IANA time zone, so a
 * period follows the wall clock in that zone and a 23 or 25 hour day around
 * a Daylight Saving Time change is still one period. No date library is
 * needed. See docs/design.md, "Policy and budgets".
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

/** The calendar budget periods. */
export type CalendarPeriodKind = "day" | "week" | "month";

/**
 * The id of the calendar period that contains `timestampMs`, for example
 * `day:2026-11-18@America/Los_Angeles`, `week:2026-11-16@UTC` (the date the
 * week starts) or `month:2026-11@Europe/London`. For one kind and zone, ids
 * sort in time order as plain strings, so a store can expire old periods by
 * key.
 */
export function calendarPeriodId(
  kind: CalendarPeriodKind,
  timestampMs: number,
  timeZone = "UTC",
  weekStartsOn: WeekStartsOn = "monday",
): string {
  switch (kind) {
    case "day":
      return `day:${calendarDayKey(timestampMs, timeZone)}@${timeZone}`;
    case "week":
      return `week:${calendarWeekKey(timestampMs, timeZone, weekStartsOn)}@${timeZone}`;
    case "month":
      return `month:${calendarMonthKey(timestampMs, timeZone)}@${timeZone}`;
  }
}

/** The date part of a period id: `2026-11-18` from `day:2026-11-18@UTC`. */
export function periodDate(periodId: string): string {
  const start = periodId.indexOf(":") + 1;
  const end = periodId.indexOf("@", start);
  return periodId.slice(start, end);
}

/**
 * Spend per asset in one kind of calendar period. Spend is stored under its
 * period id and is never reset in place: a new period simply has no entries
 * yet, and the entries of periods that have closed are dropped.
 *
 * The current period only moves forward. When the clock steps back across a
 * boundary, the latest period seen stays current, so a closed period is not
 * reopened with an empty budget and nothing is counted twice.
 */
export class PeriodSpendLedger {
  readonly #periodOf: (timestampMs: number) => string;
  #current: string | undefined;
  /** Keyed by `${periodId}|${asset}`. */
  readonly #spend = new Map<string, bigint>();

  constructor(periodOf: (timestampMs: number) => string) {
    this.#periodOf = periodOf;
  }

  /** The period that spend at `timestampMs` counts toward. */
  period(timestampMs: number): string {
    const computed = this.#periodOf(timestampMs);
    // Ids of one kind and zone differ only in their fixed-width date, so a
    // string comparison is a time comparison.
    if (this.#current === undefined || computed > this.#current) {
      this.#current = computed;
      this.#dropClosedPeriods(computed);
    }
    return this.#current;
  }

  spent(timestampMs: number, asset: string): bigint {
    return this.#spend.get(`${this.period(timestampMs)}|${asset}`) ?? 0n;
  }

  add(timestampMs: number, asset: string, amount: bigint): void {
    const key = `${this.period(timestampMs)}|${asset}`;
    this.#spend.set(key, (this.#spend.get(key) ?? 0n) + amount);
  }

  /**
   * Adds to a period named earlier, for undoing a reservation (#189). A period
   * that has closed is left alone: its spend no longer counts toward any
   * budget, and writing into the current period would be wrong.
   */
  addInPeriod(periodId: string, asset: string, amount: bigint): void {
    if (periodId !== this.#current) return;
    const key = `${periodId}|${asset}`;
    this.#spend.set(key, (this.#spend.get(key) ?? 0n) + amount);
  }

  /** How many period and asset entries are held. For tests of the memory bound. */
  get size(): number {
    return this.#spend.size;
  }

  #dropClosedPeriods(current: string): void {
    for (const key of this.#spend.keys()) {
      if (!key.startsWith(`${current}|`)) this.#spend.delete(key);
    }
  }
}
