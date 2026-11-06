import { Permission, roleHas } from './permissions';

describe('role permissions', () => {
  it('never lets a customer self-attest a repayment (provider-verified intents only)', () => {
    expect(roleHas('CUSTOMER', Permission.REPAYMENT_CREATE)).toBe(false);
    expect(roleHas('FINANCE_OFFICER', Permission.REPAYMENT_CREATE)).toBe(true);
  });
});
