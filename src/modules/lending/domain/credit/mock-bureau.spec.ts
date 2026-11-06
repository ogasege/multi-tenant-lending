import { createHmac } from 'node:crypto';

import fc from 'fast-check';

import { MOCK_DELINQUENCY_THRESHOLD, MockCreditBureau } from './mock-bureau';

describe('MockCreditBureau', () => {
  const bureau = new MockCreditBureau('test-secret');

  it('derives the score from HMAC-SHA256 mapped onto 300–850', () => {
    const id = 'a'.repeat(64);
    const digest = createHmac('sha256', 'test-secret').update(id).digest();
    const expected = 300 + (digest.readUIntBE(0, 6) % 551);
    expect(bureau.reportFor(id).score).toBe(expected);
  });

  it('is deterministic and async-compatible', async () => {
    const id = 'nid-hmac-123';
    await expect(bureau.fetchReport({ nationalIdHmac: id })).resolves.toEqual(bureau.reportFor(id));
    expect(bureau.reportFor(id)).toEqual(new MockCreditBureau('test-secret').reportFor(id));
  });

  it('depends on the secret', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `id-${i}`);
    const other = new MockCreditBureau('other-secret');
    expect(ids.some((id) => bureau.reportFor(id).score !== other.reportFor(id).score)).toBe(true);
  });

  it('honours fixture overrides', () => {
    const pinned = new MockCreditBureau('s', new Map([['vip', { score: 820, delinquent: false }]]));
    expect(pinned.reportFor('vip')).toEqual({
      score: 820,
      delinquent: false,
      provider: MockCreditBureau.PROVIDER,
    });
  });

  it('property: score in range, delinquent iff score < 450', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (id) => {
        const { score, delinquent } = bureau.reportFor(id);
        expect(Number.isInteger(score) && score >= 300 && score <= 850).toBe(true);
        expect(delinquent).toBe(score < MOCK_DELINQUENCY_THRESHOLD);
      }),
    );
  });
});
