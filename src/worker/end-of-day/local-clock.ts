/** A wall-clock reading in some IANA time zone. */
export interface LocalDateTime {
  /** Calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Minutes since local midnight (0–1439). */
  minuteOfDay: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // Throws RangeError for an unknown zone; institutions.timezone is validated on write.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The local calendar date and time of `instant` in `timeZone` (DST-aware, via ICU). */
export function localDateTime(instant: Date, timeZone: string): LocalDateTime {
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const { year, month, day, hour, minute } = parts;
  if (!year || !month || !day || hour === undefined || minute === undefined) {
    throw new Error(`Cannot read the local time in ${timeZone}`);
  }
  return { date: `${year}-${month}-${day}`, minuteOfDay: Number(hour) * 60 + Number(minute) };
}

/** `HH:mm` → minutes since midnight. */
export function parseLocalTime(hhmm: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) throw new Error(`Invalid local time ${hhmm} (expected HH:mm)`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The calendar date before `date` (`YYYY-MM-DD`, proleptic Gregorian, UTC arithmetic). */
export function previousDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The business date an end-of-day run is due for, or undefined when it is still too early.
 * Close-of-day semantics: EOD for day D closes D once it is OVER, so it becomes due when the
 * tenant's local clock passes `runAtMinute` on day D + 1 (e.g. 00:05 the next morning). Run
 * any earlier and D's approvals would expire, and its business continue, after the close.
 */
export function dueBusinessDate(
  instant: Date,
  timeZone: string,
  runAtMinute: number,
): string | undefined {
  const local = localDateTime(instant, timeZone);
  return local.minuteOfDay >= runAtMinute ? previousDate(local.date) : undefined;
}
