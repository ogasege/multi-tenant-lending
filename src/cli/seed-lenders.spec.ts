import { randomUUID } from 'node:crypto';

import { nationalIdHmac } from '../common/crypto/crypto';
import { mockVerifyNationalId } from '../modules/customers/kyc';
import { MockCreditBureau } from '../modules/lending/domain';
import {
  type ProductTermsInput,
  validateProductTerms,
} from '../modules/loan-products/domain/product-terms';
import { buildQuote, worstCaseAprBps } from '../modules/loan-products/domain/quote';

import { type CheckoutTerms, demoCartAmount, findDemoApplicants } from './demo-applicants';

import { assertSeedAllowed, credentialsTable, generatePassword } from './seed';
import {
  BUILT_IN_LENDERS,
  CHECKOUT_PRODUCT_CODE,
  type DemoLender,
  demoCustomers,
  demoProducts,
  loadLenders,
  parseLenderCatalogue,
} from './seed-lenders';

interface SeedTerms {
  currency: string;
  minPrincipal: string;
  maxPrincipal: string;
  minTerm: number;
  maxTerm: number;
  repaymentFrequency: ProductTermsInput['repaymentFrequency'];
  interestMethod: ProductTermsInput['interestMethod'];
  annualInterestRateBps: number;
  originationFee: { type: 'PERCENTAGE'; value: string; treatment: 'DEDUCTED' | 'CAPITALISED' };
  lateFee: { type: 'PERCENTAGE'; value: string; graceDays: number };
  disbursementMode: ProductTermsInput['disbursementMode'];
}

/** The seed's product terms through the real validation, with the API's DTO defaults. */
function validatedTerms(lender: DemoLender, terms: SeedTerms) {
  return validateProductTerms(
    {
      ...terms,
      minPrincipal: BigInt(terms.minPrincipal),
      maxPrincipal: BigInt(terms.maxPrincipal),
      originationFee: { ...terms.originationFee, value: BigInt(terms.originationFee.value) },
      lateFee: { ...terms.lateFee, value: BigInt(terms.lateFee.value) },
      maxDtiBps: 4000,
      minCreditScore: 0,
      applicationExpiryDays: 14,
    },
    { supportedCurrencies: [lender.currency], maxAprBps: lender.maxAprBps },
  );
}

const productsOf = (lender: DemoLender) =>
  demoProducts(lender) as { code: string; terms: SeedTerms }[];

describe('seed catalogue', () => {
  it('ships four fictional lenders across two cells', () => {
    expect(BUILT_IN_LENDERS.map((l) => l.slug)).toEqual([
      'eko-medicredit',
      'arewa-pharmafinance',
      'delta-carelend',
      'teranga-sante',
    ]);
    expect(BUILT_IN_LENDERS.filter((l) => l.homeRegion === 'eu-west-3').map((l) => l.slug)).toEqual(
      ['teranga-sante'],
    );
  });

  it('prices both products under each lender cap, in the lender currency', () => {
    for (const lender of BUILT_IN_LENDERS) {
      const products = demoProducts(lender) as { terms: Record<string, unknown> }[];
      expect(products.map((p) => p.terms.repaymentFrequency)).toEqual(['BULLET', 'MONTHLY']);
      for (const { terms } of products) {
        expect(terms.currency).toBe(lender.currency);
        expect(terms.annualInterestRateBps as number).toBeLessThan(lender.maxAprBps ?? 4800);
      }
    }
    const xof = demoProducts(BUILT_IN_LENDERS[3]!)[0] as { terms: { minPrincipal: string } };
    expect(xof.terms.minPrincipal).toBe('100000'); // XOF has no minor unit
  });

  it('passes the worst-case all-in APR cap check of every lender (fees included)', () => {
    // Built-in list and the front-end catalogue (its caps can differ, e.g. Delta 30 %).
    for (const lender of [...BUILT_IN_LENDERS, ...loadLenders().lenders]) {
      for (const { terms } of productsOf(lender)) {
        expect(worstCaseAprBps(validatedTerms(lender, terms))).toBeLessThanOrEqual(
          lender.maxAprBps ?? Number.POSITIVE_INFINITY,
        );
      }
    }
  });

  it('capitalises the checkout fee (supplier paid the full cart); instalments deduct it', () => {
    for (const lender of BUILT_IN_LENDERS) {
      const [checkout, working] = productsOf(lender);
      expect(checkout?.code).toBe(CHECKOUT_PRODUCT_CODE);
      expect(checkout?.terms.originationFee.treatment).toBe('CAPITALISED');
      expect(checkout?.terms.disbursementMode).toBe('VENDOR');
      expect(working?.terms.originationFee.treatment).toBe('DEDUCTED');

      const cart = demoCartAmount(lender.currency);
      const quote = buildQuote(
        validatedTerms(lender, checkout!.terms),
        { principal: cart, term: 30, disbursementDate: '2026-11-07' },
        lender.maxAprBps,
      );
      expect(quote.netDisbursed).toBe(cart);
      expect(quote.financedPrincipal).toBe(cart + quote.originationFee);
      expect(quote.originationFee).toBeGreaterThan(0n);
      expect(quote.aprWithinCap).toBe(true);
    }
  });

  it('creates two KYC-verifiable customers with stable identities per lender', () => {
    const a = demoCustomers(BUILT_IN_LENDERS[0]!, 'Pw-123456789a');
    const b = demoCustomers(BUILT_IN_LENDERS[0]!, 'Pw-123456789a');
    expect(a).toHaveLength(2);
    expect(a.map((c) => c.nationalId)).toEqual(b.map((c) => c.nationalId));
    for (const c of a) {
      expect(mockVerifyNationalId(String(c.nationalId))).toBe('VERIFIED');
      expect(String(c.phone)).toMatch(/^\+[1-9]\d{7,14}$/);
    }
    const other = demoCustomers(BUILT_IN_LENDERS[1]!, 'x');
    expect(other[0]?.nationalId).not.toBe(a[0]?.nationalId);
  });

  it('reads a front-end catalogue, filling gaps from the built-in list', () => {
    const lenders = parseLenderCatalogue(
      JSON.stringify({
        lenders: [
          {
            slug: 'teranga-sante',
            legalName: 'Teranga Santé Finance SA',
            currency: 'XOF',
            lenderType: 'MICROFINANCE_INSTITUTION',
            homeRegion: 'eu-west-3',
            colours: { primary: '#123456', secondary: '#654321' },
            logo: 'logos/teranga.png',
          },
        ],
      }),
      '/brands',
    );
    expect(lenders[0]).toMatchObject({
      countryCode: 'SN',
      locale: 'fr-SN',
      timezone: 'Africa/Dakar',
      maxAprBps: 2400,
      primaryColor: '#123456',
      logoPath: '/brands/logos/teranga.png',
    });
    expect(() => parseLenderCatalogue('[{"slug":"Bad Slug"}]', '/')).toThrow();
  });
});

describe('demo applicants', () => {
  const key = 'k'.repeat(64);

  const checkoutTerms = (lender: DemoLender): CheckoutTerms => {
    const t = validatedTerms(lender, productsOf(lender)[0]!.terms);
    return {
      productCode: CHECKOUT_PRODUCT_CODE,
      currency: t.currency,
      annualInterestRateBps: t.annualInterestRateBps,
      minPrincipal: t.minPrincipal,
      term: t.minTerm,
      originationFee: t.originationFee,
      maxDtiBps: t.maxDtiBps,
      minCreditScore: t.minCreditScore,
    };
  };

  it.each(BUILT_IN_LENDERS.map((l) => [l.slug, l] as const))(
    '%s: 3 approve, 1 counter-offer, 1 decline, scored by the real per-tenant bureau',
    (_slug, lender) => {
      const tenantId = randomUUID();
      const input = {
        lender,
        tenantId,
        hmacKey: key,
        terms: checkoutTerms(lender),
        today: '2026-11-07',
      };
      const applicants = findDemoApplicants(input);
      expect(applicants.map((a) => a.expectedDecision)).toEqual([
        'APPROVE',
        'APPROVE',
        'APPROVE',
        'COUNTER_OFFER',
        'DECLINE',
      ]);
      expect(findDemoApplicants(input)).toEqual(applicants); // deterministic

      const bureau = new MockCreditBureau(key);
      const ids = applicants.map((a) => String(a.registration.nationalId));
      expect(new Set(ids).size).toBe(ids.length);
      for (const a of applicants) {
        const id = String(a.registration.nationalId);
        expect(mockVerifyNationalId(id)).toBe('VERIFIED');
        const report = bureau.reportFor(nationalIdHmac(key, tenantId, id));
        expect(a.bureauScore).toBe(report.score);
        expect(report.delinquent).toBe(a.expectedDecision === 'DECLINE');
        expect(a.registration.currency).toBe(lender.currency);
        expect(a.request.principal).toBe(demoCartAmount(lender.currency).toString());
      }
      // The demo customers the seed registers keep their own ids.
      const seeded = demoCustomers(lender, 'x').map((c) => c.nationalId);
      expect(ids.some((id) => seeded.includes(id))).toBe(false);
    },
  );

  it('depends on the tenant: the same lender in another database gets other ids', () => {
    const lender = BUILT_IN_LENDERS[0]!;
    const terms = checkoutTerms(lender);
    const at = (tenantId: string) =>
      findDemoApplicants({ lender, tenantId, hmacKey: key, terms, today: '2026-11-07' }).map(
        (a) => a.registration.nationalId,
      );
    expect(at(randomUUID())).not.toEqual(at(randomUUID()));
  });
});

describe('seed safety', () => {
  it('refuses production unless explicitly allowed', () => {
    expect(() => {
      assertSeedAllowed({ NODE_ENV: 'production' });
    }).toThrow(/production/);
    expect(() => {
      assertSeedAllowed({ NODE_ENV: 'production', SEED_ALLOW_PRODUCTION: 'true' });
    }).not.toThrow();
    expect(() => {
      assertSeedAllowed({ NODE_ENV: 'test' });
    }).not.toThrow();
  });

  it('generates policy-compliant passwords and hides them outside local stacks', () => {
    const pw = generatePassword();
    expect(pw.length).toBeGreaterThanOrEqual(12);
    expect(pw).toMatch(/[a-z]/);
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/\d/);
    const rows = [{ lender: 'x', role: 'AUDITOR', email: 'a@x.example', password: pw }];
    expect(credentialsTable(rows, true)).toContain(pw);
    expect(credentialsTable(rows, false)).not.toContain(pw);
  });
});
