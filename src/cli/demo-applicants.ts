import { readFile, writeFile } from 'node:fs/promises';

import { nationalIdHmac } from '../common/crypto/crypto';
import type { CreditDecision, FeeTreatment, FeeType } from '../common/database/schema';
import { assertCurrency, exponentOf } from '../common/money/currency';
import { mockVerifyNationalId } from '../modules/customers/kyc';
import {
  assessCredit,
  computeOrigination,
  type IsoDate,
  MockCreditBureau,
} from '../modules/lending/domain';

import { type DemoLender, nationalIdFor } from './seed-lenders';

/**
 * Predictable demo applicants (for the white-label demo and its video).
 *
 * The mock bureau scores an applicant from the national-id HMAC, which is keyed per tenant
 * (`BVN_HMAC_KEY` + tenant id), so the same national id scores differently at each lender
 * and in each environment. Instead of hard-coding ids, the seed SEARCHES deterministic
 * candidate ids for each lender and keeps those whose outcome, computed with the real
 * `MockCreditBureau`, the real per-tenant HMAC and the real `scorecard-v1`, is the wanted
 * one. Nothing about the bureau or the scorecard is changed or bypassed.
 *
 * Each applicant is a full self-registration profile plus the checkout request it was
 * evaluated for (the lender's checkout product, a fixed cart amount, 30 days); the outcome
 * holds for exactly that request. A national id can register once per lender.
 */

/** The subset of the checkout product's (current version) terms the outcome depends on. */
export interface CheckoutTerms {
  productCode: string;
  currency: string;
  annualInterestRateBps: number;
  minPrincipal: bigint;
  /** Tenor in days (BULLET). */
  term: number;
  originationFee: { type: FeeType; value: bigint; treatment: FeeTreatment };
  maxDtiBps: number;
  minCreditScore: number;
}

export interface DemoApplicant {
  lender: string;
  expectedDecision: CreditDecision;
  /** Why this applicant gets that decision, for the demo script. */
  scenario: string;
  bureauScore: number;
  /** The request the outcome was computed for. */
  request: { productCode: string; principal: string; term: number };
  /** Body for `POST /v1/institutions/{slug}/customers/register` (add a `password`). */
  registration: Record<string, string | number>;
}

interface Profile {
  key: string;
  expected: CreditDecision;
  scenario: string;
  /** Monthly income as a multiple of the cart amount. */
  incomeMultiple: bigint;
  /** Extra bureau condition (on top of the decision) for a nicer demo. */
  score: (score: number) => boolean;
  first: string;
  last: string;
  business: string;
}

/**
 * Profiles. Income is relative to the cart, so the outcome is the same in NGN and XOF:
 * - 6 × cart ⇒ DTI about 17 %, well inside the default 40 % ⇒ APPROVE on a clean bureau;
 * - 2 × cart ⇒ DTI about 52 % ⇒ R01, COUNTER_OFFER at the largest affordable principal;
 * - 6 × cart but a bureau-delinquent score (< 450) ⇒ R04 knock-out ⇒ DECLINE.
 */
const PROFILES: readonly Profile[] = [
  {
    key: 'approve-1',
    expected: 'APPROVE',
    scenario: 'Strong bureau file, income 6× the cart: approved as requested',
    incomeMultiple: 6n,
    score: (s) => s >= 650,
    first: 'Ngozi',
    last: 'Adebayo',
    business: 'GoodHealth Pharmacy Ltd',
  },
  {
    key: 'approve-2',
    expected: 'APPROVE',
    scenario: 'Strong bureau file, income 6× the cart: approved as requested',
    incomeMultiple: 6n,
    score: (s) => s >= 650,
    first: 'Emeka',
    last: 'Nwosu',
    business: 'CityCare Pharmacy Ltd',
  },
  {
    key: 'approve-3',
    expected: 'APPROVE',
    scenario: 'Strong bureau file, income 6× the cart: approved as requested',
    incomeMultiple: 6n,
    score: (s) => s >= 650,
    first: 'Halima',
    last: 'Sani',
    business: 'Northgate Chemists Ltd',
  },
  {
    key: 'counter-offer',
    expected: 'COUNTER_OFFER',
    scenario: 'Clean bureau, income only 2× the cart: DTI above 40 %, a smaller amount offered',
    incomeMultiple: 2n,
    score: () => true,
    first: 'Bola',
    last: 'Ogunleye',
    business: 'Corner Pharmacy Ltd',
  },
  {
    key: 'decline',
    expected: 'DECLINE',
    scenario: 'Bureau reports delinquency (score below 450): declined (R04)',
    incomeMultiple: 6n,
    score: () => true,
    first: 'Yusuf',
    last: 'Garba',
    business: 'Sunrise Drugstore Ltd',
  },
];

const FRENCH_NAMES: Readonly<Record<string, [string, string, string]>> = {
  'approve-1': ['Fatou', 'Sarr', 'Pharmacie du Plateau'],
  'approve-2': ['Ibrahima', 'Fall', 'Pharmacie Médina'],
  'approve-3': ['Aminata', 'Ba', 'Pharmacie Liberté 6'],
  'counter-offer': ['Cheikh', 'Gueye', 'Pharmacie Grand-Yoff'],
  decline: ['Mamadou', 'Faye', 'Pharmacie Pikine'],
};

/** Cart financed in the demo, in whole units: NGN 500 000 / XOF 1 000 000. */
export function demoCartAmount(currency: string): bigint {
  const units = currency === 'XOF' ? 1_000_000n : 500_000n;
  return units * 10n ** BigInt(exponentOf(assertCurrency(currency)));
}

/** Candidate ids per lender; far from the seed's demo customers (n = 0, 1, 10, 11). */
const FIRST_CANDIDATE = 1_000;
const MAX_CANDIDATES = 20_000;

export interface FindDemoApplicantsInput {
  lender: DemoLender;
  tenantId: string;
  /** `BVN_HMAC_KEY`: keys both the national-id HMAC and the mock bureau. */
  hmacKey: string;
  terms: CheckoutTerms;
  today: IsoDate;
}

/**
 * Demo applicants of one lender: three APPROVE, one COUNTER_OFFER, one DECLINE for the
 * checkout request. Deterministic for a given tenant id and key. Throws if a profile finds
 * no matching id (it would mean the product terms changed so much the profiles no longer fit).
 */
export function findDemoApplicants(input: FindDemoApplicantsInput): DemoApplicant[] {
  const { lender, tenantId, hmacKey, terms, today } = input;
  const bureau = new MockCreditBureau(hmacKey);
  const currency = assertCurrency(terms.currency);
  const cart = demoCartAmount(currency);
  const { financedPrincipal } = computeOrigination(cart, terms.originationFee);
  const french = lender.locale.startsWith('fr');
  const used = new Set<string>();
  let next = FIRST_CANDIDATE;

  return PROFILES.map((profile, index) => {
    const income = cart * profile.incomeMultiple;
    for (; next < FIRST_CANDIDATE + MAX_CANDIDATES; next++) {
      const nationalId = nationalIdFor(lender.slug, next);
      if (used.has(nationalId) || mockVerifyNationalId(nationalId) !== 'VERIFIED') continue;
      const report = bureau.reportFor(nationalIdHmac(hmacKey, tenantId, nationalId));
      if (!profile.score(report.score)) continue;
      const result = assessCredit({
        applicationDate: today,
        principal: financedPrincipal,
        term: terms.term,
        kycStatus: 'VERIFIED',
        ownerDateOfBirth: '1984-06-15',
        tenureMonths: 60,
        monthlyIncome: income,
        existingMonthlyDebt: 0n,
        existingTenantMaxDpd: 0,
        bureau: { score: report.score, delinquent: report.delinquent },
        product: {
          currency,
          annualRateBps: terms.annualInterestRateBps,
          frequency: 'BULLET',
          method: 'FLAT',
          minPrincipal: terms.minPrincipal,
          maxDtiBps: terms.maxDtiBps,
          minCreditScore: terms.minCreditScore,
        },
      });
      if (result.decision !== profile.expected) continue;
      used.add(nationalId);
      next++;
      const [first, last, business] = french
        ? (FRENCH_NAMES[profile.key] ?? [profile.first, profile.last, profile.business])
        : [profile.first, profile.last, profile.business];
      return {
        lender: lender.slug,
        expectedDecision: profile.expected,
        scenario: profile.scenario,
        bureauScore: report.score,
        request: {
          productCode: terms.productCode,
          principal: cart.toString(),
          term: terms.term,
        },
        registration: {
          customerType: 'BUSINESS',
          businessName: business,
          businessRegistrationNumber: `${french ? 'SN-DKR-' : 'RC'}${nationalId.slice(-7)}`,
          operatingLicenceNumber: french
            ? `ONP/2024/${900 + index}`
            : `PCN/PREM/2024/${900 + index}`,
          firstName: first,
          lastName: last,
          email: `demo.${profile.key}@${lender.slug}.customers.example`,
          phone: french ? `+22177123460${index}` : `+23480123460${index}`,
          dateOfBirth: '1984-06-15',
          nationalId,
          employmentStatus: 'BUSINESS_OWNER',
          monthsInEmployment: 60,
          currency,
          monthlyIncome: income.toString(),
          monthlyExpenses: (income / 3n).toString(),
          existingMonthlyDebt: '0',
        },
      };
    }
    throw new Error(`No demo applicant found for ${lender.slug} (${profile.key})`);
  });
}

/** Shape of demo-applicants.json: applicants per lender slug, merged across cells. */
export interface DemoApplicantsFile {
  note: string;
  generatedAt: string;
  lenders: Record<string, { cellRegion: string; applicants: DemoApplicant[] }>;
}

const FILE_NOTE =
  'Generated by `npm run seed`. Outcomes are computed with the mock credit bureau and the ' +
  'per-tenant national-id HMAC of THIS database: re-seeding a fresh database regenerates ' +
  'them. Each outcome holds for the stated request; each national id registers once.';

/**
 * Writes (or merges into) the demo applicants file: this cell's lenders are replaced, other
 * cells' entries are kept, so seeding each cell in turn accumulates one file.
 */
export async function writeDemoApplicantsFile(
  file: string,
  cellRegion: string,
  applicants: readonly DemoApplicant[],
  now = new Date(),
): Promise<void> {
  let existing: DemoApplicantsFile['lenders'] = {};
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<DemoApplicantsFile>;
    existing = parsed.lenders ?? {};
  } catch {
    // Missing or unreadable: start a new file.
  }
  const lenders = Object.fromEntries(
    Object.entries(existing).filter(([, entry]) => entry.cellRegion !== cellRegion),
  );
  for (const applicant of applicants) {
    const entry = (lenders[applicant.lender] ??= { cellRegion, applicants: [] });
    entry.applicants.push(applicant);
  }
  const body: DemoApplicantsFile = { note: FILE_NOTE, generatedAt: now.toISOString(), lenders };
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

/** Plain-text table of demo applicants for the seed output. */
export function demoApplicantsTable(applicants: readonly DemoApplicant[]): string {
  const header = ['LENDER', 'OUTCOME', 'NATIONAL ID', 'SCORE', 'INCOME/MONTH', 'REQUEST'];
  const body = applicants.map((a) => [
    a.lender,
    a.expectedDecision,
    String(a.registration.nationalId),
    String(a.bureauScore),
    `${String(a.registration.monthlyIncome)} ${String(a.registration.currency)}`,
    `${a.request.productCode} ${a.request.principal} for ${String(a.request.term)} days`,
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    'Demo applicants (sign up with these to get a known credit decision; amounts in minor units):',
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...body.map(line),
  ].join('\n');
}
