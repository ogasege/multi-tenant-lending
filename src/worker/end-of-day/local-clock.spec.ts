import { dueBusinessDate, localDateTime, parseLocalTime, previousDate } from './local-clock';

describe('tenant-local clock for end of day', () => {
  it('reads the calendar date in the tenant time zone, not UTC', () => {
    // 23:30 UTC on 5 Nov is 00:30 on 6 Nov in Lagos (UTC+1) and still 5 Nov in Dakar (UTC+0).
    const instant = new Date('2026-11-05T23:30:00Z');
    expect(localDateTime(instant, 'Africa/Lagos')).toEqual({ date: '2026-11-06', minuteOfDay: 30 });
    expect(localDateTime(instant, 'Africa/Dakar')).toEqual({
      date: '2026-11-05',
      minuteOfDay: 1410,
    });
  });

  it('is DST-aware', () => {
    // London is UTC+1 in summer, UTC+0 in winter.
    expect(localDateTime(new Date('2026-07-01T23:30:00Z'), 'Europe/London').date).toBe(
      '2026-07-02',
    );
    expect(localDateTime(new Date('2026-12-01T23:30:00Z'), 'Europe/London').date).toBe(
      '2026-12-01',
    );
  });

  it('makes EOD for the PREVIOUS local date due once the local run time has passed', () => {
    const runAt = parseLocalTime('00:05');
    // 23:03 UTC on 5 Nov = 00:03 on 6 Nov in Lagos: too early to close 5 Nov.
    expect(
      dueBusinessDate(new Date('2026-11-05T23:03:00Z'), 'Africa/Lagos', runAt),
    ).toBeUndefined();
    // 00:05 on 6 Nov in Lagos closes 5 Nov (close of day), never the day still running.
    expect(dueBusinessDate(new Date('2026-11-05T23:05:00Z'), 'Africa/Lagos', runAt)).toBe(
      '2026-11-05',
    );
    expect(dueBusinessDate(new Date('2026-11-06T12:00:00Z'), 'Africa/Lagos', runAt)).toBe(
      '2026-11-05',
    );
  });

  it('steps back across month, year and leap-day boundaries', () => {
    expect(previousDate('2026-03-01')).toBe('2026-02-28');
    expect(previousDate('2028-03-01')).toBe('2028-02-29');
    expect(previousDate('2027-01-01')).toBe('2026-12-31');
  });

  it('validates HH:mm and time zones', () => {
    expect(parseLocalTime('23:59')).toBe(1439);
    expect(() => parseLocalTime('24:00')).toThrow();
    expect(() => localDateTime(new Date(), 'Mars/Olympus')).toThrow(RangeError);
  });
});
