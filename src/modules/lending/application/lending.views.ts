import type {
  ApplicationStatus,
  CreditDecision,
  DpdBucket,
  InstalmentStatus,
  LoanStatus,
  LoanTermsSnapshot,
  PayeeType,
  RepaymentChannel,
} from '../../../common/database/schema';
import type { ApplicationRow, AssessmentRow } from '../infrastructure/applications.repository';
import type { InstalmentRow, LoanRow, RepaymentRow } from '../infrastructure/loans.repository';

import { outstandingSummary, outstandingTotal } from './instalment-state';

/** Money in API responses: integer minor units as a decimal string (SPEC §6). */
export type MinorString = string;

export interface PayeeView {
  type: PayeeType;
  name: string;
  account: string;
}

export interface ApplicationView {
  id: string;
  reference: string;
  customerId: string;
  productId: string;
  productVersionId: string;
  currency: string;
  requestedPrincipal: MinorString;
  term: number;
  purpose: string | null;
  payee: PayeeView;
  externalOrderReference: string | null;
  status: ApplicationStatus;
  /** Staff user ids and internal notes are `null` for CUSTOMER callers. */
  submittedBy: string | null;
  submittedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNotes: string | null;
  rejectionReasonCodes: string[];
  approvedPrincipal: MinorString | null;
  expiresAt: string | null;
  loanId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** FCCPC-style pre-contract disclosure of one loan offer. */
export interface DisclosureView {
  currency: string;
  principal: MinorString;
  originationFee: MinorString;
  originationFeeTreatment: string;
  financedPrincipal: MinorString;
  netDisbursed: MinorString;
  numberOfInstalments: number;
  instalmentAmount: MinorString;
  totalInterest: MinorString;
  totalRepayable: MinorString;
  totalCostOfCredit: MinorString;
  aprBps: number;
  firstDueDate: string;
  maturityDate: string;
}

export interface AssessmentView {
  id: string;
  applicationId: string;
  modelVersion: string;
  decision: CreditDecision;
  grade: string;
  points: number;
  reasonCodes: string[];
  bureauScore: number;
  bureauDelinquent: boolean;
  dtiBps: number;
  instalmentAmount: MinorString;
  maxAffordablePrincipal: MinorString | null;
  aprBps: number | null;
  assessedBy: string;
  createdAt: string;
  disclosure: DisclosureView;
}

export interface OutstandingView {
  principal: MinorString;
  interest: MinorString;
  fees: MinorString;
  penalties: MinorString;
  total: MinorString;
}

export interface LoanView {
  id: string;
  reference: string;
  applicationId: string;
  customerId: string;
  productVersionId: string;
  currency: string;
  approvedPrincipal: MinorString;
  financedPrincipal: MinorString;
  originationFee: MinorString;
  netDisbursed: MinorString;
  aprBps: number | null;
  terms: LoanTermsSnapshot;
  payee: PayeeView;
  status: LoanStatus;
  /** Staff user ids are `null` for CUSTOMER callers. */
  approvedBy: string | null;
  approvedAt: string;
  disbursedBy: string | null;
  disbursedAt: string | null;
  disbursementDate: string | null;
  maturityDate: string | null;
  providerReference: string | null;
  closedAt: string | null;
  daysPastDue: number;
  dpdBucket: DpdBucket;
  /** Contractual amounts still owed (all instalments, incl. future interest). */
  outstanding: OutstandingView;
  createdAt: string;
}

export interface InstalmentView {
  seq: number;
  dueDate: string;
  principalDue: MinorString;
  interestDue: MinorString;
  feeDue: MinorString;
  penaltyDue: MinorString;
  principalPaid: MinorString;
  interestPaid: MinorString;
  feePaid: MinorString;
  penaltyPaid: MinorString;
  interestWaived: MinorString;
  totalDue: MinorString;
  totalOutstanding: MinorString;
  status: InstalmentStatus;
  paidAt: string | null;
}

export interface ScheduleView {
  loanId: string;
  currency: string;
  /** True for a loan not yet disbursed: a preview as if disbursed today. */
  preview: boolean;
  disbursementDate: string;
  maturityDate: string;
  instalments: InstalmentView[];
}

export interface PayoffQuoteView {
  loanId: string;
  currency: string;
  asOf: string;
  principal: MinorString;
  interest: MinorString;
  fees: MinorString;
  penalties: MinorString;
  total: MinorString;
  waivedInterest: MinorString;
}

export interface RepaymentView {
  id: string;
  loanId: string;
  amount: MinorString;
  currency: string;
  valueDate: string;
  channel: RepaymentChannel;
  externalReference: string | null;
  allocation: {
    principal: MinorString;
    interest: MinorString;
    fee: MinorString;
    penalty: MinorString;
  };
  journalEntryId: string;
  /** Staff user id; `null` for CUSTOMER callers. */
  recordedBy: string | null;
  createdAt: string;
}

export interface RepaymentResultView extends RepaymentView {
  /** True when the payment equalled the payoff amount and closed the loan. */
  settled: boolean;
  /** Future interest waived by an early settlement. */
  waivedInterest: MinorString;
  loanStatus: LoanStatus;
  daysPastDue: number;
  outstanding: OutstandingView;
}

/**
 * Who the view is rendered for. A CUSTOMER gets a borrower-appropriate view: no staff user
 * ids and no internal decision notes (OWASP API3, excessive data exposure).
 */
export type Audience = 'STAFF' | 'CUSTOMER';

/** The view audience of a principal. */
export function audienceOf(principal: { role: string }): Audience {
  return principal.role === 'CUSTOMER' ? 'CUSTOMER' : 'STAFF';
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toApplicationView(
  row: ApplicationRow,
  loanId: string | null,
  audience: Audience = 'STAFF',
): ApplicationView {
  const staff = audience === 'STAFF';
  return {
    id: row.id,
    reference: row.reference,
    customerId: row.customer_id,
    productId: row.product_id,
    productVersionId: row.product_version_id,
    currency: row.currency,
    requestedPrincipal: row.requested_principal.toString(),
    term: row.term,
    purpose: row.purpose,
    payee: { type: row.payee_type, name: row.payee_name, account: row.payee_account },
    externalOrderReference: row.external_order_reference,
    status: row.status,
    submittedBy: staff ? row.submitted_by : null,
    submittedAt: row.submitted_at.toISOString(),
    decidedBy: staff ? row.decided_by : null,
    decidedAt: iso(row.decided_at),
    decisionNotes: staff ? row.decision_notes : null,
    rejectionReasonCodes: row.rejection_reason_codes,
    approvedPrincipal: row.approved_principal?.toString() ?? null,
    expiresAt: iso(row.expires_at),
    loanId,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toAssessmentView(row: AssessmentRow, disclosure: DisclosureView): AssessmentView {
  return {
    id: row.id,
    applicationId: row.application_id,
    modelVersion: row.model_version,
    decision: row.decision,
    grade: row.grade,
    points: row.scorecard_points,
    reasonCodes: row.reason_codes,
    bureauScore: row.bureau_score,
    bureauDelinquent: row.bureau_delinquent,
    dtiBps: row.dti_bps,
    instalmentAmount: row.instalment_amount.toString(),
    maxAffordablePrincipal: row.max_affordable_principal?.toString() ?? null,
    aprBps: row.apr_bps,
    assessedBy: row.assessed_by,
    createdAt: row.created_at.toISOString(),
    disclosure,
  };
}

export function toOutstandingView(rows: readonly InstalmentRow[]): OutstandingView {
  const s = outstandingSummary(rows);
  return {
    principal: s.principal.toString(),
    interest: s.interest.toString(),
    fees: s.fees.toString(),
    penalties: s.penalties.toString(),
    total: s.total.toString(),
  };
}

/**
 * Loan row (+ its instalments) → API view. A loan not yet disbursed has no instalments; its
 * outstanding amount is then the financed principal (nothing is owed until disbursement, but
 * the figure is what will be owed).
 */
export function toLoanView(
  row: LoanRow,
  instalments: readonly InstalmentRow[],
  audience: Audience = 'STAFF',
): LoanView {
  const staff = audience === 'STAFF';
  return {
    id: row.id,
    reference: row.reference,
    applicationId: row.application_id,
    customerId: row.customer_id,
    productVersionId: row.product_version_id,
    currency: row.currency,
    approvedPrincipal: row.approved_principal.toString(),
    financedPrincipal: row.financed_principal.toString(),
    originationFee: row.origination_fee.toString(),
    netDisbursed: row.net_disbursed.toString(),
    aprBps: row.apr_bps,
    terms: row.terms,
    payee: { type: row.payee_type, name: row.payee_name, account: row.payee_account },
    status: row.status,
    approvedBy: staff ? row.approved_by : null,
    approvedAt: row.approved_at.toISOString(),
    disbursedBy: staff ? row.disbursed_by : null,
    disbursedAt: iso(row.disbursed_at),
    disbursementDate: row.disbursement_date,
    maturityDate: row.maturity_date,
    providerReference: row.provider_reference,
    closedAt: iso(row.closed_at),
    daysPastDue: row.days_past_due,
    dpdBucket: row.dpd_bucket,
    outstanding:
      instalments.length > 0 ? toOutstandingView(instalments) : undisbursedOutstanding(row),
    createdAt: row.created_at.toISOString(),
  };
}

/** Before disbursement: the financed principal while pending, nothing once cancelled. */
function undisbursedOutstanding(row: LoanRow): OutstandingView {
  const principal = row.status === 'PENDING_DISBURSEMENT' ? row.financed_principal.toString() : '0';
  return { principal, interest: '0', fees: '0', penalties: '0', total: principal };
}

export function toInstalmentView(row: InstalmentRow): InstalmentView {
  return {
    seq: row.seq,
    dueDate: row.due_date,
    principalDue: row.principal_due.toString(),
    interestDue: row.interest_due.toString(),
    feeDue: row.fee_due.toString(),
    penaltyDue: row.penalty_due.toString(),
    principalPaid: row.principal_paid.toString(),
    interestPaid: row.interest_paid.toString(),
    feePaid: row.fee_paid.toString(),
    penaltyPaid: row.penalty_paid.toString(),
    interestWaived: row.interest_waived.toString(),
    totalDue: (row.principal_due + row.interest_due + row.fee_due + row.penalty_due).toString(),
    totalOutstanding: outstandingTotal(row).toString(),
    status: row.status,
    paidAt: iso(row.paid_at),
  };
}

export function toRepaymentView(row: RepaymentRow, audience: Audience = 'STAFF'): RepaymentView {
  return {
    id: row.id,
    loanId: row.loan_id,
    amount: row.amount.toString(),
    currency: row.currency,
    valueDate: row.value_date,
    channel: row.channel,
    externalReference: row.external_reference,
    allocation: {
      principal: row.allocated_principal.toString(),
      interest: row.allocated_interest.toString(),
      fee: row.allocated_fee.toString(),
      penalty: row.allocated_penalty.toString(),
    },
    journalEntryId: row.journal_entry_id,
    recordedBy: audience === 'STAFF' ? row.recorded_by : null,
    createdAt: row.created_at.toISOString(),
  };
}
