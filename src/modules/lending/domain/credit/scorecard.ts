import Decimal from 'decimal.js';

import type {
  CreditDecision,
  InterestMethod,
  RepaymentFrequency,
  Row,
} from '../../../../common/database/schema';
import { ValidationError } from '../../../../common/errors/app-error';
import type { CurrencyCode } from '../../../../common/money/currency';
import { FinDecimal } from '../../../../common/money/money';
import { fullYearsBetween, type IsoDate } from '../dates';
import {
  annuityPresentValue,
  generateSchedule,
  PERIODS_PER_YEAR,
  periodicRate,
  roundMinor,
  type Schedule,
  toDecimal,
} from '../schedule';

import { BUREAU_MAX_SCORE, BUREAU_MIN_SCORE } from './bureau.port';

export const SCORECARD_MODEL_VERSION = 'scorecard-v1';

export type KycStatus = Row<'customers'>['kyc_status'];
export type CreditGrade = Row<'credit_assessments'>['grade'];

/** Adverse-action reason codes (SPEC §7.6), in canonical order. */
export const REASON_CODES = [
  'R01_DTI_ABOVE_THRESHOLD',
  'R02_LOW_BUREAU_SCORE',
  'R03_SHORT_EMPLOYMENT_TENURE',
  'R04_BUREAU_DELINQUENCY',
  'R05_KYC_NOT_VERIFIED',
  'R06_AGE_OUT_OF_RANGE',
  'R07_EXISTING_DELINQUENCY',
  'R08_BELOW_MIN_SCORE',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** Reasons that decline outright regardless of points (policy knock-outs). */
export const KNOCK_OUT_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'R04_BUREAU_DELINQUENCY',
  'R05_KYC_NOT_VERIFIED',
  'R06_AGE_OUT_OF_RANGE',
  'R07_EXISTING_DELINQUENCY',
  'R08_BELOW_MIN_SCORE',
]);

/** Policy thresholds of scorecard-v1. */
export const SCORECARD_POLICY = {
  minOwnerAge: 18,
  maxOwnerAge: 65,
  /** Existing loan at this tenant more than this many DPD ⇒ R07. */
  maxExistingDpd: 30,
  /** Months in business / employment below this ⇒ R03. */
  minTenureMonths: 6,
  /** Bureau score below this ⇒ R02 (adverse but not a knock-out). */
  lowBureauScore: 580,
} as const;

/**
 * scorecard-v1 points table (max 100). Bands are evaluated top-down; first match wins.
 *
 * | Factor              | Band                 | Points |
 * |---------------------|----------------------|--------|
 * | Bureau score        | ≥ 720                | 40     |
 * |                     | 650–719              | 30     |
 * |                     | 580–649              | 20     |
 * |                     | 500–579              | 10     |
 * |                     | < 500                | 0      |
 * | DTI (post-loan)     | ≤ 20.00 %            | 25     |
 * |                     | ≤ 30.00 %            | 18     |
 * |                     | ≤ 40.00 %            | 10     |
 * |                     | > 40.00 %            | 0      |
 * | Tenure (months)     | ≥ 36                 | 20     |
 * |                     | 12–35                | 15     |
 * |                     | 6–11                 | 8      |
 * |                     | < 6                  | 0      |
 * | Bureau delinquency  | none                 | 15     |
 * |                     | delinquent           | 0      |
 *
 * Grades: A ≥ 80, B ≥ 65, C ≥ 50, D ≥ 35, E < 35.
 */
export const SCORECARD_V1 = {
  bureauScore: [
    { min: 720, points: 40 },
    { min: 650, points: 30 },
    { min: 580, points: 20 },
    { min: 500, points: 10 },
    { min: 0, points: 0 },
  ],
  dtiBps: [
    { max: 2000, points: 25 },
    { max: 3000, points: 18 },
    { max: 4000, points: 10 },
    { max: Number.POSITIVE_INFINITY, points: 0 },
  ],
  tenureMonths: [
    { min: 36, points: 20 },
    { min: 12, points: 15 },
    { min: 6, points: 8 },
    { min: 0, points: 0 },
  ],
  bureauClean: 15,
  grades: [
    { min: 80, grade: 'A' },
    { min: 65, grade: 'B' },
    { min: 50, grade: 'C' },
    { min: 35, grade: 'D' },
    { min: 0, grade: 'E' },
  ],
} as const satisfies {
  grades: readonly { min: number; grade: CreditGrade }[];
  [key: string]: unknown;
};

export interface ScorecardProductTerms {
  currency: CurrencyCode;
  annualRateBps: number;
  frequency: RepaymentFrequency;
  method: InterestMethod;
  minPrincipal: bigint;
  maxDtiBps: number;
  minCreditScore: number;
}

export interface CreditAssessmentInput {
  applicationDate: IsoDate;
  /** Principal the schedule would amortise (financed principal), minor units. */
  principal: bigint;
  /** Instalment count, or tenor in days for BULLET. */
  term: number;
  kycStatus: KycStatus;
  /** Date of birth of the signing owner / guarantor. */
  ownerDateOfBirth: IsoDate;
  /** Months in business (pharmacy/clinic) or employment. */
  tenureMonths: number;
  monthlyIncome: bigint;
  existingMonthlyDebt: bigint;
  /** Worst current DPD across this borrower's other loans at this tenant (0 if none). */
  existingTenantMaxDpd: number;
  bureau: { score: number; delinquent: boolean };
  product: ScorecardProductTerms;
}

export interface PointsBreakdown {
  bureauScore: number;
  dti: number;
  tenure: number;
  bureauDelinquency: number;
}

export interface CreditAssessmentResult {
  modelVersion: typeof SCORECARD_MODEL_VERSION;
  decision: CreditDecision;
  grade: CreditGrade;
  points: number;
  pointsBreakdown: PointsBreakdown;
  reasonCodes: ReasonCode[];
  dtiBps: number;
  /** Regular (first) scheduled instalment (BULLET: the single repayment), minor units. */
  instalmentAmount: bigint;
  /** Monthly-equivalent instalment used for affordability, minor units. */
  monthlyInstalment: bigint;
  /** Set when DTI is breached: largest principal that fits (rounded down), else null. */
  maxAffordablePrincipal: bigint | null;
  ownerAge: number;
}

function bandPoints<B extends { points: number }>(
  bands: readonly B[],
  matches: (b: B) => boolean,
): number {
  return bands.find(matches)?.points ?? 0;
}

/** Grade for a points total per the scorecard-v1 table. */
export function gradeFor(points: number): CreditGrade {
  return SCORECARD_V1.grades.find((g) => points >= g.min)?.grade ?? 'E';
}

/**
 * Affordability amounts of a schedule.
 *
 * - Periodic: monthly equivalent = regular (first) instalment × periodsPerYear / 12. The
 *   first instalment is the quoted level payment for REDUCING_BALANCE and FLAT (the last one
 *   only differs by rounding residue) and the largest one for EQUAL_PRINCIPAL.
 * - BULLET: total repayable spread over max(1, tenorDays / 30) months.
 *
 * Both are rounded half-even to minor units.
 */
export function monthlyEquivalent(
  schedule: Schedule,
  frequency: RepaymentFrequency,
  term: number,
): { instalmentAmount: bigint; monthlyInstalment: bigint } {
  if (frequency === 'BULLET') {
    const months = Decimal.max(1, new FinDecimal(term).div(30));
    return {
      instalmentAmount: schedule.totalRepayable,
      monthlyInstalment: roundMinor(toDecimal(schedule.totalRepayable).div(months)),
    };
  }
  const instalmentAmount = schedule.instalments[0]?.total ?? 0n;
  return {
    instalmentAmount,
    monthlyInstalment: roundMinor(
      toDecimal(instalmentAmount).mul(PERIODS_PER_YEAR[frequency]).div(12),
    ),
  };
}

interface Affordability {
  instalmentAmount: bigint;
  monthlyInstalment: bigint;
  dtiBps: number;
  breached: boolean;
}

function affordability(input: CreditAssessmentInput, principal: bigint): Affordability {
  const { product } = input;
  const schedule = generateSchedule({
    principal,
    currency: product.currency,
    annualRateBps: product.annualRateBps,
    term: input.term,
    frequency: product.frequency,
    method: product.method,
    disbursementDate: input.applicationDate,
  });
  const { instalmentAmount, monthlyInstalment } = monthlyEquivalent(
    schedule,
    product.frequency,
    input.term,
  );
  const debt = input.existingMonthlyDebt + monthlyInstalment;
  return {
    instalmentAmount,
    monthlyInstalment,
    dtiBps: Number(roundMinor(toDecimal(debt).mul(10_000).div(input.monthlyIncome.toString()))),
    // Exact integer comparison: debt / income > maxDti / 10 000.
    breached: debt * 10_000n > BigInt(product.maxDtiBps) * input.monthlyIncome,
  };
}

/**
 * Largest principal whose monthly-equivalent instalment keeps DTI within the product limit.
 *
 * Budget = maxDti × income − existing debt (monthly). REDUCING_BALANCE inverts the annuity,
 * P = A(1 − (1 + r)^−n) / r with A = budget × 12 / periodsPerYear; other methods scale the
 * requested principal linearly by budget / requested monthly instalment. The estimate is
 * rounded down and then verified against the real (rounded) schedule; if rounding pushes it
 * over the limit a binary search finds the largest principal that fits. Never exceeds the
 * requested principal. Returns 0 when nothing fits.
 */
export function maxAffordablePrincipal(
  input: CreditAssessmentInput,
  requestedMonthlyInstalment: bigint,
): bigint {
  const { product } = input;
  const budget =
    (BigInt(product.maxDtiBps) * input.monthlyIncome) / 10_000n - input.existingMonthlyDebt;
  if (budget <= 0n) return 0n;

  let estimate: bigint;
  if (product.frequency !== 'BULLET' && product.method === 'REDUCING_BALANCE') {
    const perInstalment = toDecimal(budget).mul(12).div(PERIODS_PER_YEAR[product.frequency]);
    const pv = annuityPresentValue(
      perInstalment,
      periodicRate(product.annualRateBps, product.frequency),
      input.term,
    );
    estimate = BigInt(pv.toDecimalPlaces(0, Decimal.ROUND_DOWN).toFixed(0));
  } else {
    estimate =
      requestedMonthlyInstalment === 0n
        ? input.principal
        : (input.principal * budget) / requestedMonthlyInstalment;
  }
  if (estimate > input.principal) estimate = input.principal;
  if (estimate <= 0n) return 0n;
  const fits = (p: bigint): boolean => !affordability(input, p).breached;
  if (fits(estimate)) return estimate;

  let lo = 0n;
  let hi = estimate - 1n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (fits(mid)) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

function validate(input: CreditAssessmentInput): void {
  const errors: { field: string; message: string }[] = [];
  if (input.monthlyIncome <= 0n) errors.push({ field: 'monthlyIncome', message: 'must be > 0' });
  if (input.existingMonthlyDebt < 0n) {
    errors.push({ field: 'existingMonthlyDebt', message: 'must be >= 0' });
  }
  if (!Number.isFinite(input.tenureMonths) || input.tenureMonths < 0) {
    errors.push({ field: 'tenureMonths', message: 'must be >= 0' });
  }
  if (!Number.isFinite(input.existingTenantMaxDpd) || input.existingTenantMaxDpd < 0) {
    errors.push({ field: 'existingTenantMaxDpd', message: 'must be >= 0' });
  }
  const { score } = input.bureau;
  if (!Number.isInteger(score) || score < BUREAU_MIN_SCORE || score > BUREAU_MAX_SCORE) {
    errors.push({ field: 'bureau.score', message: 'must be an integer in 300..850' });
  }
  if (errors.length > 0) throw new ValidationError('Invalid credit assessment input', errors);
}

/**
 * Decision rules, first that applies. `maxPrincipal` is non-null exactly when DTI is breached
 * and the applicant is not knocked out.
 */
function decide(
  knockedOut: boolean,
  grade: CreditGrade,
  maxPrincipal: bigint | null,
  minPrincipal: bigint,
): CreditDecision {
  if (knockedOut || grade === 'E') return 'DECLINE';
  if (maxPrincipal !== null) return maxPrincipal >= minPrincipal ? 'COUNTER_OFFER' : 'DECLINE';
  if (grade === 'D') return 'REFER';
  return 'APPROVE';
}

/**
 * Explainable credit assessment, model `scorecard-v1` (SPEC §7.6).
 *
 * 1. Knock-outs: KYC not VERIFIED (R05); signing owner younger than 18 or older than 65 in
 *    completed years on the application date (R06); another loan at this tenant > 30 DPD (R07).
 * 2. Bureau: delinquent (R04, knock-out); score < product min (R08, knock-out);
 *    score < 580 (R02, adverse).
 * 3. Affordability: DTI = (existing monthly debt + monthly-equivalent instalment) / monthly
 *    income; above product `maxDtiBps` ⇒ R01.
 * 4. Tenure < 6 months ⇒ R03 (adverse).
 * 5. Points ({@link SCORECARD_V1}) → grade A–E.
 *
 * Decision, first rule that applies: any knock-out ⇒ DECLINE; grade E ⇒ DECLINE; DTI breach
 * ⇒ COUNTER_OFFER at the max affordable principal if that is ≥ product min principal, else
 * DECLINE; grade D ⇒ REFER; otherwise APPROVE. Reason codes are unique, in R01..R08 order.
 */
export function assessCredit(input: CreditAssessmentInput): CreditAssessmentResult {
  validate(input);
  const { product, bureau } = input;
  const reasons = new Set<ReasonCode>();

  const ownerAge = fullYearsBetween(input.ownerDateOfBirth, input.applicationDate);
  if (input.kycStatus !== 'VERIFIED') reasons.add('R05_KYC_NOT_VERIFIED');
  if (ownerAge < SCORECARD_POLICY.minOwnerAge || ownerAge > SCORECARD_POLICY.maxOwnerAge) {
    reasons.add('R06_AGE_OUT_OF_RANGE');
  }
  if (input.existingTenantMaxDpd > SCORECARD_POLICY.maxExistingDpd) {
    reasons.add('R07_EXISTING_DELINQUENCY');
  }
  if (bureau.delinquent) reasons.add('R04_BUREAU_DELINQUENCY');
  if (bureau.score < product.minCreditScore) reasons.add('R08_BELOW_MIN_SCORE');
  if (bureau.score < SCORECARD_POLICY.lowBureauScore) reasons.add('R02_LOW_BUREAU_SCORE');

  const afford = affordability(input, input.principal);
  if (afford.breached) reasons.add('R01_DTI_ABOVE_THRESHOLD');
  if (input.tenureMonths < SCORECARD_POLICY.minTenureMonths) {
    reasons.add('R03_SHORT_EMPLOYMENT_TENURE');
  }

  const pointsBreakdown: PointsBreakdown = {
    bureauScore: bandPoints(SCORECARD_V1.bureauScore, (b) => bureau.score >= b.min),
    dti: bandPoints(SCORECARD_V1.dtiBps, (b) => afford.dtiBps <= b.max),
    tenure: bandPoints(SCORECARD_V1.tenureMonths, (b) => input.tenureMonths >= b.min),
    bureauDelinquency: bureau.delinquent ? 0 : SCORECARD_V1.bureauClean,
  };
  const points =
    pointsBreakdown.bureauScore +
    pointsBreakdown.dti +
    pointsBreakdown.tenure +
    pointsBreakdown.bureauDelinquency;
  const grade = gradeFor(points);

  const knockedOut = [...reasons].some((r) => KNOCK_OUT_REASONS.has(r));
  const maxPrincipal =
    afford.breached && !knockedOut ? maxAffordablePrincipal(input, afford.monthlyInstalment) : null;

  return {
    modelVersion: SCORECARD_MODEL_VERSION,
    decision: decide(knockedOut, grade, maxPrincipal, product.minPrincipal),
    grade,
    points,
    pointsBreakdown,
    reasonCodes: REASON_CODES.filter((code) => reasons.has(code)),
    dtiBps: afford.dtiBps,
    instalmentAmount: afford.instalmentAmount,
    monthlyInstalment: afford.monthlyInstalment,
    maxAffordablePrincipal: maxPrincipal,
    ownerAge,
  };
}
