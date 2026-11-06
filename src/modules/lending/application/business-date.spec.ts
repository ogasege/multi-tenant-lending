import { addDaysToInstant, businessDate } from './business-date';

describe('businessDate', () => {
  it('uses the institution time zone, not UTC', () => {
    // 23:30 UTC on 31 Jan is already 1 Feb in Lagos (UTC+1) but still 31 Jan in Dakar (UTC).
    const instant = new Date('2026-01-31T23:30:00Z');
    expect(businessDate('Africa/Lagos', instant)).toBe('2026-02-01');
    expect(businessDate('Africa/Dakar', instant)).toBe('2026-01-31');
  });

  it('adds whole days to instants', () => {
    expect(addDaysToInstant(new Date('2026-01-01T10:00:00Z'), 14).toISOString()).toBe(
      '2026-01-15T10:00:00.000Z',
    );
  });
});
