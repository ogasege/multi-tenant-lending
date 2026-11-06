import fc from 'fast-check';

import { ValidationError } from '../../../common/errors/app-error';

import {
  addDays,
  addMonths,
  assertIsoDate,
  compareDates,
  daysBetween,
  daysInMonth,
  fromEpochDay,
  fullYearsBetween,
  isIsoDate,
  toEpochDay,
} from './dates';

/** Arbitrary valid business date between 1950 and 2100. */
const isoDateArb = fc
  .integer({ min: toEpochDay('1950-01-01'), max: toEpochDay('2100-12-31') })
  .map(fromEpochDay);

describe('dates', () => {
  it.each([
    // anchor, months, expected — the day always comes from the ORIGINAL anchor
    ['2024-01-31', 1, '2024-02-29'], // leap year clamp
    ['2025-01-31', 1, '2025-02-28'], // non-leap clamp
    ['2025-01-31', 2, '2025-03-31'], // no drift back from 28th
    ['2025-01-31', 3, '2025-04-30'],
    ['2025-08-31', 6, '2026-02-28'], // across year end
    ['2025-12-15', 1, '2026-01-15'],
    ['2025-03-31', -1, '2025-02-28'], // negative months
  ])('addMonths(%s, %i) = %s', (anchor, months, expected) => {
    expect(addMonths(anchor, months)).toBe(expected);
  });

  it('adds days across month, year and leap-day boundaries', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDays('2026-03-29', 14)).toBe('2026-04-12'); // a European DST weekend is irrelevant
  });

  it('counts ACT days', () => {
    expect(daysBetween('2026-01-01', '2026-12-31')).toBe(364);
    expect(daysBetween('2024-01-01', '2025-01-01')).toBe(366);
    expect(daysBetween('2026-02-10', '2026-02-01')).toBe(-9);
    expect(daysInMonth(2100, 2)).toBe(28); // century, not a leap year
    expect(daysInMonth(2000, 2)).toBe(29);
  });

  it('computes completed years (age)', () => {
    expect(fullYearsBetween('2008-11-06', '2026-11-06')).toBe(18); // birthday today
    expect(fullYearsBetween('2008-11-07', '2026-11-06')).toBe(17); // birthday tomorrow
    expect(fullYearsBetween('1960-12-01', '2026-11-06')).toBe(65);
  });

  it.each(['2025-02-29', '2025-13-01', '2025-1-1', '2025-04-31', '', 'not-a-date'])(
    'rejects %j',
    (value) => {
      expect(isIsoDate(value)).toBe(false);
      expect(() => toEpochDay(value)).toThrow(ValidationError);
    },
  );

  it('ages a 29 Feb birthday by date-fns differenceInYears rules', () => {
    expect(fullYearsBetween('2004-02-29', '2025-02-28')).toBe(20); // non-leap: not yet 21
    expect(fullYearsBetween('2004-02-29', '2025-03-01')).toBe(21);
    expect(fullYearsBetween('2004-02-29', '2024-02-28')).toBe(19);
    expect(fullYearsBetween('2004-02-29', '2024-02-29')).toBe(20);
  });

  it('floors the age when the date precedes the birth date', () => {
    expect(fullYearsBetween('2026-11-07', '2026-11-06')).toBe(-1); // day before birth
    expect(fullYearsBetween('2027-11-06', '2026-11-06')).toBe(-1); // exactly one year before
    expect(fullYearsBetween('2027-11-07', '2026-11-06')).toBe(-2); // 366 days before
  });

  it.each([
    ' 2025-01-01',
    '2025-01-01 ',
    '+2025-01-01',
    '2025-01-01T00:00',
    '20250101',
    '2025-01-00',
  ])('rejects non-canonical %j', (value) => {
    expect(isIsoDate(value)).toBe(false);
  });

  it('assertIsoDate returns valid dates unchanged and names invalid ones', () => {
    expect(assertIsoDate('2024-02-29')).toBe('2024-02-29');
    expect(() => assertIsoDate('2026-02-30')).toThrow(
      'Invalid calendar date "2026-02-30" (expected YYYY-MM-DD)',
    );
  });

  it.each([
    ['addDays', () => addDays('2026-01-01', 1.5)],
    ['addMonths', () => addMonths('2026-01-01', Number.NaN)],
    ['fromEpochDay', () => fromEpochDay(Number.POSITIVE_INFINITY)],
  ])('%s rejects a non-whole amount', (_name, call) => {
    expect(call).toThrow(ValidationError);
  });

  it('handles years below 100 without the Date.UTC 19xx mapping', () => {
    expect(daysInMonth(4, 2)).toBe(29); // 4 AD is a (proleptic) leap year; 1904 mapping agrees
    expect(daysInMonth(100, 2)).toBe(28);
    expect(isIsoDate('0000-02-29')).toBe(true); // ISO year 0 is a leap year
    expect(addDays('0099-12-31', 1)).toBe('0100-01-01');
  });

  it('compares chronologically', () => {
    expect(compareDates('2026-01-02', '2026-01-10')).toBe(-1);
    expect(compareDates('2026-01-10', '2026-01-10')).toBe(0);
    expect(compareDates('2026-02-01', '2026-01-31')).toBe(1);
  });

  describe('properties', () => {
    it('epoch-day round-trips and addDays/daysBetween are inverse', () => {
      fc.assert(
        fc.property(isoDateArb, fc.integer({ min: -5000, max: 5000 }), (d, n) => {
          expect(fromEpochDay(toEpochDay(d))).toBe(d);
          expect(daysBetween(d, addDays(d, n))).toBe(n);
        }),
      );
    });

    it('addMonths keeps the anchor day or clamps to month end, never drifting', () => {
      fc.assert(
        fc.property(isoDateArb, fc.integer({ min: 0, max: 240 }), (anchor, k) => {
          const result = addMonths(anchor, k);
          const anchorDay = Number(anchor.slice(8));
          const [y, m, day] = result.split('-').map(Number) as [number, number, number];
          expect(day).toBe(Math.min(anchorDay, daysInMonth(y, m)));
          const monthsApart =
            (y - Number(anchor.slice(0, 4))) * 12 + (m - Number(anchor.slice(5, 7)));
          expect(monthsApart).toBe(k);
        }),
      );
    });
  });
});
