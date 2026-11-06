import { describe, expect, it } from 'vitest';

import { demoCart, newOrderReference } from './cart';
import { demoApplicantsFor, demoPassword, type DemoApplicantsFile } from './demoApplicants';

const applicant = (nationalId: string, expectedDecision: 'APPROVE' | 'DECLINE') => ({
  lender: 'eko-medicredit',
  expectedDecision,
  scenario: 'test',
  bureauScore: 700,
  request: { productCode: 'SUPPLIER_30', principal: '50000000', term: 30 },
  registration: {
    firstName: 'Ada',
    lastName: 'Obi',
    email: `${nationalId}@x.example`,
    phone: '+2348000000000',
    dateOfBirth: '1984-06-15',
    nationalId,
    employmentStatus: 'BUSINESS_OWNER' as const,
    monthsInEmployment: 60,
    currency: 'NGN',
    monthlyIncome: '300000000',
    monthlyExpenses: '100000000',
    existingMonthlyDebt: '0',
  },
});

const FILE: DemoApplicantsFile = {
  lenders: {
    'eko-medicredit': {
      cellRegion: 'af-south-1',
      applicants: [
        applicant('21111111111', 'APPROVE'),
        applicant('22222222222', 'APPROVE'),
        applicant('23333333333', 'DECLINE'),
      ],
    },
  },
};

describe('demo applicants', () => {
  it('filters by lender and outcome and skips used national ids', () => {
    expect(demoApplicantsFor('eko-medicredit', 'APPROVE', new Set(), FILE)).toHaveLength(2);
    expect(
      demoApplicantsFor('eko-medicredit', 'APPROVE', new Set(['21111111111']), FILE).map(
        (a) => a.registration.nationalId,
      ),
    ).toEqual(['22222222222']);
    expect(demoApplicantsFor('other', 'APPROVE', new Set(), FILE)).toEqual([]);
  });

  it('generates policy-compliant passwords', () => {
    expect(demoPassword()).toMatch(/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d).{12,}$/);
  });
});

describe('demo cart', () => {
  it('totals the amount the demo applicants were scored for', () => {
    const ref = newOrderReference(new Date('2026-11-07T10:00:00Z'));
    expect(ref).toMatch(/^ORD-[0-9][0-9-]{0,40}$/);
    expect(demoCart('NGN', 'en-NG', new URLSearchParams(), ref).total).toBe('50000000');
    expect(demoCart('XOF', 'fr-SN', new URLSearchParams(), ref).total).toBe('1000000');
  });

  it('accepts a valid order reference from the URL only', () => {
    const ok = demoCart('NGN', 'en-NG', new URLSearchParams('order=ORD-42'), 'ORD-1');
    const bad = demoCart('NGN', 'en-NG', new URLSearchParams('order=evil'), 'ORD-1');
    expect(ok.orderReference).toBe('ORD-42');
    expect(bad.orderReference).toBe('ORD-1');
  });
});
