import { UTCDate } from '@date-fns/utc';
import {
  addDays as addDaysToDate,
  addMonths as addMonthsToDate,
  compareAsc,
  differenceInCalendarDays,
  differenceInYears,
  format,
  getDaysInMonth,
  isValid,
  parse as parseDate,
} from 'date-fns';

import { ValidationError } from '../../../common/errors/app-error';

/**
 * Business-date maths on ISO calendar dates (`YYYY-MM-DD`).
 *
 * Business dates have no time zone (SPEC §6). Every calculation is delegated
 * to date-fns v4 operating on `UTCDate` (`@date-fns/utc`), whose getters and
 * setters are the `getUTC*` / `setUTC*` ones, so nothing here reads the host
 * time zone or the clock. That rules out the classic "midnight in Lagos is
 * yesterday in UTC" off-by-one and any DST-shortened day.
 */
export type IsoDate = string;

/**
 * date-fns pattern for an ISO calendar date. `uuuu` is the signed ISO year
 * (`yyyy` would print year 0 as era year 1 and break the round-trip check).
 */
const ISO_PATTERN = 'uuuu-MM-dd';

/** 1970-01-01T00:00Z: day 0 of {@link toEpochDay} and the parse reference. */
const EPOCH = new UTCDate(0);

/**
 * Parses `value` strictly: date-fns must accept it AND re-format it to the
 * identical string. The round-trip rejects impossible days (`2026-02-30`),
 * unpadded fields (`2025-1-1`), surrounding text and anything not exactly
 * `YYYY-MM-DD`.
 */
function tryParse(value: string): UTCDate | null {
  const date = parseDate(value, ISO_PATTERN, EPOCH);
  return isValid(date) && format(date, ISO_PATTERN) === value ? date : null;
}

function parse(value: IsoDate): UTCDate {
  const date = tryParse(value);
  if (!date) {
    throw new ValidationError(`Invalid calendar date "${value}" (expected YYYY-MM-DD)`);
  }
  return date;
}

function toIso(date: UTCDate): IsoDate {
  return format(date, ISO_PATTERN);
}

/** Throws `ValidationError` unless `n` is a safe integer (whole days/months). */
function assertWhole(n: number, unit: string): void {
  if (!Number.isSafeInteger(n)) {
    throw new ValidationError(`${unit} must be a whole number, got ${n}`);
  }
}

/** True when `value` is a real calendar date in `YYYY-MM-DD` form. */
export function isIsoDate(value: string): boolean {
  return tryParse(value) !== null;
}

/** Throws `ValidationError` unless `value` is a real calendar date; returns it unchanged. */
export function assertIsoDate(value: string): IsoDate {
  parse(value);
  return value;
}

/** Number of days in `month` (1-12) of `year`, Gregorian leap rules (date-fns `getDaysInMonth`). */
export function daysInMonth(year: number, month: number): number {
  // setFullYear (setUTCFullYear on UTCDate) has no 0-99 → 19xx year mapping.
  const firstOfMonth = new UTCDate(0);
  firstOfMonth.setFullYear(year, month - 1, 1);
  return getDaysInMonth(firstOfMonth);
}

/** Days since 1970-01-01 (UTC day number) of a business date. */
export function toEpochDay(value: IsoDate): number {
  return differenceInCalendarDays(parse(value), EPOCH);
}

/** Inverse of {@link toEpochDay}; `epochDay` must be a whole number. */
export function fromEpochDay(epochDay: number): IsoDate {
  assertWhole(epochDay, 'Epoch day');
  return toIso(addDaysToDate(EPOCH, epochDay));
}

/** `value` shifted by `days` whole calendar days (may be negative). */
export function addDays(value: IsoDate, days: number): IsoDate {
  assertWhole(days, 'Days');
  return toIso(addDaysToDate(parse(value), days));
}

/**
 * `anchor` shifted by `months` whole calendar months with end-of-month
 * clamping (date-fns `addMonths`).
 *
 * The day-of-month is always taken from the ORIGINAL anchor, so a schedule
 * built as `addMonths(anchor, k)` for k = 1..n never drifts:
 * 31 Jan → 28/29 Feb → 31 Mar → 30 Apr → 31 May. Never chain calls
 * (`addMonths(addMonths(a, 1), 1)`): that drifts to 28/29 Mar.
 */
export function addMonths(anchor: IsoDate, months: number): IsoDate {
  assertWhole(months, 'Months');
  return toIso(addMonthsToDate(parse(anchor), months));
}

/**
 * Signed number of days from `from` to `to` (ACT day count): `to − from`
 * (date-fns `differenceInCalendarDays` in UTC).
 */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return differenceInCalendarDays(parse(to), parse(from));
}

/** Chronological comparison of two validated dates: −1 (a earlier), 0 or 1 (a later). */
export function compareDates(a: IsoDate, b: IsoDate): -1 | 0 | 1 {
  return compareAsc(parse(a), parse(b)) as -1 | 0 | 1;
}

/**
 * Completed years between `birthDate` and `onDate` (age on a given day):
 * date-fns `differenceInYears`, so a 29 Feb birthday completes a year on
 * 1 Mar in non-leap years (still 20 on 2025-02-28 for 2004-02-29).
 *
 * When `onDate` precedes `birthDate` the result is floored, not truncated
 * (−1 the day before birth), i.e. `onYear − birthYear − 1` if the month-day
 * of `onDate` is earlier in the year than that of `birthDate`.
 */
export function fullYearsBetween(birthDate: IsoDate, onDate: IsoDate): number {
  const birth = parse(birthDate);
  const on = parse(onDate);
  if (compareAsc(on, birth) >= 0) return differenceInYears(on, birth);
  const sameMonthDay = on.getMonth() === birth.getMonth() && on.getDate() === birth.getDate();
  return -differenceInYears(birth, on) - (sameMonthDay ? 0 : 1);
}
