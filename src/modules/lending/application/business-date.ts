import type { IsoDate } from '../domain';

/**
 * Calendar date of `instant` in an IANA time zone (`YYYY-MM-DD`). A loan disbursed at 23:30
 * in Lagos (22:30 UTC) belongs to that Lagos business day, whatever the server's zone.
 */
export function businessDate(timeZone: string, instant: Date): IsoDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** `instant` + `days` whole days (24 h each), e.g. an approval's expiry. */
export function addDaysToInstant(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * 86_400_000);
}
