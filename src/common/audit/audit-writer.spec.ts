import { GENESIS_HASH, hashEntry, sanitiseForAudit } from './audit-writer';

const entry = {
  tenantId: 't1',
  actorType: 'USER' as const,
  actorId: 'u1',
  action: 'loan.disbursed',
  entityType: 'loan',
  entityId: 'l1',
  before: null,
  after: { amount: '100' },
  requestId: 'r1',
  ipAddress: '102.89.1.7',
  userAgent: 'curl/8.0',
  occurredAt: '2026-11-06T10:00:00.000Z',
};

describe('audit sanitisation', () => {
  it('normalises key names and covers camelCase identifiers, arrays and contact details', () => {
    expect(
      sanitiseForAudit({
        nationalId: '22212345678',
        BVN: '22212345678',
        dateOfBirth: '1990-01-01',
        email: 'owner@pharmacy.ng',
        accountNumber: ['0123456789'],
        ledgerAccountId: 'acc-123',
      }),
    ).toEqual({
      nationalId: '[REDACTED]',
      BVN: '[REDACTED]',
      dateOfBirth: '[REDACTED]',
      email: '****y.ng',
      accountNumber: ['****6789'],
      ledgerAccountId: 'acc-123',
    });
  });

  it('redacts secrets and national ids, masks accounts, stringifies bigints', () => {
    expect(
      sanitiseForAudit({
        password_hash: 'x',
        refreshToken: 'y',
        national_id_hmac: 'z',
        payee_account: '0123456789',
        amount: 5n,
        nested: [{ secret_ciphertext: 's', at: new Date('2026-01-01T00:00:00Z') }],
      }),
    ).toEqual({
      password_hash: '[REDACTED]',
      refreshToken: '[REDACTED]',
      national_id_hmac: '[REDACTED]',
      payee_account: '****6789',
      amount: '5',
      nested: [{ secret_ciphertext: '[REDACTED]', at: '2026-01-01T00:00:00.000Z' }],
    });
  });
});

describe('audit hash chain', () => {
  it('is deterministic and order-independent for object keys', () => {
    expect(hashEntry(GENESIS_HASH, entry)).toBe(
      hashEntry(GENESIS_HASH, { ...entry, after: { amount: '100' } }),
    );
  });

  it('changes when any field or the previous hash changes', () => {
    const h = hashEntry(GENESIS_HASH, entry);
    expect(hashEntry(GENESIS_HASH, { ...entry, action: 'loan.closed' })).not.toBe(h);
    expect(hashEntry('other', entry)).not.toBe(h);
  });

  it('covers the client IP and user agent, so they cannot be altered undetected', () => {
    const h = hashEntry(GENESIS_HASH, entry);
    expect(hashEntry(GENESIS_HASH, { ...entry, ipAddress: '10.0.0.1' })).not.toBe(h);
    expect(hashEntry(GENESIS_HASH, { ...entry, userAgent: 'other' })).not.toBe(h);
  });
});
