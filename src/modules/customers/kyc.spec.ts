import { isPastCalendarDate, mockVerifyNationalId, newCustomerReference } from './kyc';

describe('mock KYC', () => {
  it('verifies 11-digit ids that do not start with 000', () => {
    expect(mockVerifyNationalId('22212345678')).toBe('VERIFIED');
    expect(mockVerifyNationalId('00012345678')).toBe('PENDING');
    expect(mockVerifyNationalId('1234')).toBe('PENDING');
  });

  it('generates CUS- references from the unambiguous alphabet', () => {
    expect(newCustomerReference()).toMatch(/^CUS-[2-9A-HJKMNP-Z]{6}$/);
  });

  it('accepts only real dates in the past', () => {
    const today = new Date('2026-11-06T10:00:00Z');
    expect(isPastCalendarDate('1985-04-12', today)).toBe(true);
    expect(isPastCalendarDate('2023-02-30', today)).toBe(false);
    expect(isPastCalendarDate('2026-11-06', today)).toBe(false);
    expect(isPastCalendarDate('2030-01-01', today)).toBe(false);
  });
});
