import fc from 'fast-check';

import { ACCOUNT } from '../chart-of-accounts';

import { assertBalanced, type JournalLine, normalBalance } from './journal';
import {
  disbursementLines,
  interestAccrualLines,
  interestWaiverLines,
  lateFeeLines,
  repaymentLines,
} from './posting-rules';

const sum = (lines: JournalLine[], direction: 'DEBIT' | 'CREDIT') =>
  lines.filter((l) => l.direction === direction).reduce((acc, l) => acc + l.amount, 0n);

describe('posting rules (SPEC §8)', () => {
  it('deducted fee: Dr 1100 P / Cr 1000 P − F / Cr 4100 F', () => {
    // P = ₦1,000,000.00 = 100,000,000 kobo; 2 % fee F = 2,000,000; net 98,000,000.
    expect(
      disbursementLines({
        financedPrincipal: 100_000_000n,
        netDisbursed: 98_000_000n,
        originationFee: 2_000_000n,
      }),
    ).toEqual([
      { account: ACCOUNT.LOAN_PRINCIPAL_RECEIVABLE, direction: 'DEBIT', amount: 100_000_000n },
      { account: ACCOUNT.CASH, direction: 'CREDIT', amount: 98_000_000n },
      { account: ACCOUNT.FEE_INCOME, direction: 'CREDIT', amount: 2_000_000n },
    ]);
  });

  it('capitalised fee: Dr 1100 P + F / Cr 1000 P / Cr 4100 F', () => {
    const lines = disbursementLines({
      financedPrincipal: 102_000_000n,
      netDisbursed: 100_000_000n,
      originationFee: 2_000_000n,
    });
    expect(lines.map((l) => [l.account, l.direction, l.amount])).toEqual([
      ['1100', 'DEBIT', 102_000_000n],
      ['1000', 'CREDIT', 100_000_000n],
      ['4100', 'CREDIT', 2_000_000n],
    ]);
  });

  it('no fee: the fee line is omitted (postings are always > 0)', () => {
    const lines = disbursementLines({
      financedPrincipal: 500_000n,
      netDisbursed: 500_000n,
      originationFee: 0n,
    });
    expect(lines).toHaveLength(2);
    assertBalanced(lines);
  });

  it('interest accrual, waiver reversal and late fee', () => {
    expect(interestAccrualLines(1_500n).map((l) => `${l.direction}:${l.account}`)).toEqual([
      'DEBIT:1110',
      'CREDIT:4000',
    ]);
    expect(interestWaiverLines(700n).map((l) => `${l.direction}:${l.account}`)).toEqual([
      'DEBIT:4000',
      'CREDIT:1110',
    ]);
    expect(lateFeeLines(500_000n).map((l) => `${l.direction}:${l.account}`)).toEqual([
      'DEBIT:1130',
      'CREDIT:4200',
    ]);
    expect(lateFeeLines(0n)).toEqual([]);
  });

  it('repayment: Dr 1000 X / Cr 1130, 1120, 1110, 1100 by allocation, zero lines dropped', () => {
    const lines = repaymentLines({ penalty: 500n, fee: 0n, interest: 2_000n, principal: 7_500n });
    expect(lines.map((l) => [l.direction, l.account, l.amount])).toEqual([
      ['DEBIT', '1000', 10_000n],
      ['CREDIT', '1130', 500n],
      ['CREDIT', '1110', 2_000n],
      ['CREDIT', '1100', 7_500n],
    ]);
  });

  it('property: every rule balances and posts only positive amounts', () => {
    const minor = fc.bigInt({ min: 0n, max: 10n ** 15n });
    fc.assert(
      fc.property(minor, minor, minor, minor, (penalty, fee, interest, principal) => {
        fc.pre(penalty + fee + interest + principal > 0n);
        const lines = repaymentLines({ penalty, fee, interest, principal });
        assertBalanced(lines);
        expect(sum(lines, 'DEBIT')).toBe(penalty + fee + interest + principal);
      }),
    );
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 15n }), minor, (net, feeAmount) => {
        const lines = disbursementLines({
          financedPrincipal: net + feeAmount,
          netDisbursed: net,
          originationFee: feeAmount,
        });
        assertBalanced(lines);
        expect(lines.every((l) => l.amount > 0n)).toBe(true);
      }),
    );
  });
});

describe('assertBalanced', () => {
  const dr = (amount: bigint): JournalLine => ({ account: '1000', direction: 'DEBIT', amount });
  const cr = (amount: bigint): JournalLine => ({ account: '4000', direction: 'CREDIT', amount });

  it.each([
    ['fewer than two lines', [dr(1n)]],
    ['a zero amount', [dr(0n), cr(0n)]],
    ['a negative amount', [dr(-5n), cr(-5n)]],
    ['debits ≠ credits', [dr(10n), cr(9n)]],
  ])('rejects %s', (_label, lines) => {
    expect(() => {
      assertBalanced(lines);
    }).toThrow();
  });

  it('accepts a balanced multi-line entry', () => {
    expect(() => {
      assertBalanced([dr(10n), cr(4n), cr(6n)]);
    }).not.toThrow();
  });
});

describe('normalBalance', () => {
  it('debit-normal accounts are Dr − Cr; credit-normal are Cr − Dr', () => {
    expect(normalBalance('DEBIT', 100n, 30n)).toBe(70n);
    expect(normalBalance('CREDIT', 100n, 30n)).toBe(-70n);
  });
});
