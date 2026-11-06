import type {
  FeeTreatment,
  FeeType,
  InterestMethod,
  PayeeType,
  RepaymentFrequency,
} from '../../../common/database/schema';
import type { ProductTermsInput } from '../domain/product-terms';
import {
  type ProductRow,
  toTerms,
  type VersionRow,
} from '../infrastructure/loan-products.repository';

/** Terms as sent by clients: money and fee values are integer strings. */
export interface ProductTermsCommand {
  currency: string;
  minPrincipal: string;
  maxPrincipal: string;
  minTerm: number;
  maxTerm: number;
  repaymentFrequency: RepaymentFrequency;
  interestMethod: InterestMethod;
  annualInterestRateBps: number;
  originationFee: { type: FeeType; value: string; treatment: FeeTreatment };
  lateFee: { type: FeeType; value: string; graceDays: number };
  maxDtiBps?: number;
  minCreditScore?: number;
  applicationExpiryDays?: number;
  disbursementMode?: PayeeType;
}

/** Parses string amounts to bigint and applies the documented defaults (SPEC §7.1). */
export function toTermsInput(cmd: ProductTermsCommand): ProductTermsInput {
  return {
    currency: cmd.currency,
    minPrincipal: BigInt(cmd.minPrincipal),
    maxPrincipal: BigInt(cmd.maxPrincipal),
    minTerm: cmd.minTerm,
    maxTerm: cmd.maxTerm,
    repaymentFrequency: cmd.repaymentFrequency,
    interestMethod: cmd.interestMethod,
    annualInterestRateBps: cmd.annualInterestRateBps,
    originationFee: {
      type: cmd.originationFee.type,
      value: BigInt(cmd.originationFee.value),
      treatment: cmd.originationFee.treatment,
    },
    lateFee: {
      type: cmd.lateFee.type,
      value: BigInt(cmd.lateFee.value),
      graceDays: cmd.lateFee.graceDays,
    },
    maxDtiBps: cmd.maxDtiBps ?? 4000,
    minCreditScore: cmd.minCreditScore ?? 0,
    applicationExpiryDays: cmd.applicationExpiryDays ?? 14,
    disbursementMode: cmd.disbursementMode ?? 'VENDOR',
  };
}

export interface ProductTermsView {
  versionId: string;
  version: number;
  currency: string;
  minPrincipal: string;
  maxPrincipal: string;
  minTerm: number;
  maxTerm: number;
  repaymentFrequency: RepaymentFrequency;
  interestMethod: InterestMethod;
  annualInterestRateBps: number;
  dayCount: 'ACT_365F';
  originationFee: { type: FeeType; value: string; treatment: FeeTreatment };
  lateFee: { type: FeeType; value: string; graceDays: number };
  /** Staff only (underwriting criteria; omitted from the borrower view). */
  maxDtiBps?: number;
  /** Staff only (underwriting criteria; omitted from the borrower view). */
  minCreditScore?: number;
  applicationExpiryDays: number;
  disbursementMode: PayeeType;
  createdAt: Date;
}

/**
 * Who reads a product: staff see everything; a CUSTOMER (borrower) sees only ACTIVE
 * products, and never the underwriting thresholds (`minCreditScore`, `maxDtiBps`, which
 * would help game an application) or who authored a version (`createdBy`, a staff id).
 */
export type ProductAudience = 'staff' | 'borrower';

export function audienceOf(role: string): ProductAudience {
  return role === 'CUSTOMER' ? 'borrower' : 'staff';
}

export function forTermsAudience(
  view: ProductTermsView,
  audience: ProductAudience,
): ProductTermsView {
  if (audience === 'staff') return view;
  const { maxDtiBps: _dti, minCreditScore: _score, ...borrower } = view;
  return borrower;
}

export function forProductAudience(
  view: LoanProductView,
  audience: ProductAudience,
): LoanProductView {
  return audience === 'staff' ? view : { ...view, terms: forTermsAudience(view.terms, audience) };
}

export function forDetailAudience(
  view: LoanProductDetailView,
  audience: ProductAudience,
): LoanProductDetailView {
  if (audience === 'staff') return view;
  return {
    ...view,
    terms: forTermsAudience(view.terms, audience),
    versions: view.versions.map(({ createdBy: _by, ...v }) => v),
  };
}

export interface LoanProductView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  currentVersion: number;
  terms: ProductTermsView;
  createdAt: Date;
  updatedAt: Date;
}

export interface LoanProductDetailView extends LoanProductView {
  /** `createdBy` is staff only. */
  versions: { id: string; version: number; createdAt: Date; createdBy?: string | null }[];
}

export function toTermsView(row: VersionRow): ProductTermsView {
  const t = toTerms(row);
  return {
    versionId: row.id,
    version: row.version,
    currency: t.currency,
    minPrincipal: t.minPrincipal.toString(),
    maxPrincipal: t.maxPrincipal.toString(),
    minTerm: t.minTerm,
    maxTerm: t.maxTerm,
    repaymentFrequency: t.repaymentFrequency,
    interestMethod: t.interestMethod,
    annualInterestRateBps: t.annualInterestRateBps,
    dayCount: t.dayCount,
    originationFee: { ...t.originationFee, value: t.originationFee.value.toString() },
    lateFee: { ...t.lateFee, value: t.lateFee.value.toString() },
    maxDtiBps: t.maxDtiBps,
    minCreditScore: t.minCreditScore,
    applicationExpiryDays: t.applicationExpiryDays,
    disbursementMode: t.disbursementMode,
    createdAt: row.created_at,
  };
}

export function toProductView(product: ProductRow, current: VersionRow): LoanProductView {
  return {
    id: product.id,
    code: product.code,
    name: product.name,
    description: product.description,
    status: product.status,
    currentVersion: product.current_version,
    terms: toTermsView(current),
    createdAt: product.created_at,
    updatedAt: product.updated_at,
  };
}
