/**
 * Wire types of the 10mg Lending Core API (v1), mirrored from the backend DTOs in
 * src/modules/**\/interface/http/dto and SPEC §10. Amounts are integer strings in ISO 4217
 * minor units; rates are integer basis points; dates are ISO strings.
 */

export type MinorUnits = string;

export interface PublicBranding {
  slug: string;
  displayName: string;
  primaryColor: string;
  secondaryColor: string;
  locale: string;
  supportEmail: string | null;
  supportPhone: string | null;
  websiteUrl: string | null;
  logoUrl: string | null;
  /** ISO 4217 currency the lender reports in (amounts are minor units of it). */
  defaultCurrency: string;
  supportedCurrencies: string[];
}

export interface DirectoryEntry {
  slug: string;
  homeRegion: string;
  apiBaseUrl: string;
  status: string;
}

export interface TokenPair {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

export type UserRole =
  'INSTITUTION_ADMIN' | 'CREDIT_OFFICER' | 'FINANCE_OFFICER' | 'AUDITOR' | 'CUSTOMER';

/** `GET /v1/me`: the signed-in principal (discriminated on `kind`). */
export type Me =
  | {
      kind: 'USER';
      id: string;
      fullName: string;
      email: string;
      role: UserRole;
      permissions: string[];
      institution: { slug: string; displayName: string };
    }
  | { kind: 'PLATFORM_ADMIN'; id: string };

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export type EmploymentStatus = 'EMPLOYED' | 'SELF_EMPLOYED' | 'BUSINESS_OWNER' | 'UNEMPLOYED';

export interface RegisterCustomerRequest {
  customerType?: 'BUSINESS' | 'INDIVIDUAL';
  businessName?: string;
  businessRegistrationNumber?: string;
  operatingLicenceNumber?: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  nationalId: string;
  employmentStatus: EmploymentStatus;
  employerName?: string;
  monthsInEmployment: number;
  currency: string;
  monthlyIncome: MinorUnits;
  monthlyExpenses: MinorUnits;
  existingMonthlyDebt: MinorUnits;
  password: string;
}

export interface Customer {
  id: string;
  reference: string;
  customerType: 'BUSINESS' | 'INDIVIDUAL';
  firstName: string;
  lastName: string;
  businessName: string | null;
  email: string;
  phone: string;
  nationalIdLast4: string;
  kycStatus: 'PENDING' | 'VERIFIED' | 'REJECTED';
  currency: string;
  monthlyIncome: MinorUnits;
  createdAt: string;
}

export interface CustomerRegistration {
  customer: Customer;
  tokens: TokenPair;
}

export type RepaymentFrequency = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'BULLET';

export interface ProductTerms {
  versionId: string;
  version: number;
  currency: string;
  minPrincipal: MinorUnits;
  maxPrincipal: MinorUnits;
  minTerm: number;
  maxTerm: number;
  repaymentFrequency: RepaymentFrequency;
  interestMethod: string;
  annualInterestRateBps: number;
  originationFee: { type: 'FLAT' | 'PERCENTAGE'; value: string; treatment: string };
  lateFee: { type: 'FLAT' | 'PERCENTAGE'; value: string; graceDays: number };
  maxDtiBps: number;
  minCreditScore: number;
  applicationExpiryDays: number;
  disbursementMode: 'VENDOR' | 'BORROWER';
}

export interface LoanProduct {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  currentVersion: number;
  terms: ProductTerms;
}

export interface QuoteInstalment {
  seq: number;
  dueDate: string;
  principal: MinorUnits;
  interest: MinorUnits;
  total: MinorUnits;
}

export interface Quote {
  productId: string;
  productVersion: number;
  currency: string;
  principal: MinorUnits;
  term: number;
  termUnit: 'DAYS' | 'INSTALMENTS';
  repaymentFrequency: string;
  interestMethod: string;
  annualInterestRateBps: number;
  disbursementDate: string;
  maturityDate: string;
  originationFee: MinorUnits;
  originationFeeTreatment: 'DEDUCTED' | 'CAPITALISED';
  financedPrincipal: MinorUnits;
  netDisbursed: MinorUnits;
  totalInterest: MinorUnits;
  totalRepayable: MinorUnits;
  totalCostOfCredit: MinorUnits;
  aprBps: number;
  maxAprBps: number | null;
  aprWithinCap: boolean;
  instalments: QuoteInstalment[];
}

export type ApplicationStatus =
  'SUBMITTED' | 'ASSESSED' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED';

export type CreditDecision = 'APPROVE' | 'REFER' | 'DECLINE' | 'COUNTER_OFFER';

export interface Payee {
  type: 'VENDOR' | 'BORROWER';
  name: string;
  account: string;
}

export interface SubmitApplicationRequest {
  customerId?: string;
  productId: string;
  principal: MinorUnits;
  term: number;
  purpose?: string;
  /** Only for BORROWER-mode products; VENDOR (checkout) payees come from the order. */
  payee?: { type?: 'VENDOR' | 'BORROWER'; name: string; account: string };
  /** Checkout order id (`ORD-…`); required for VENDOR-mode products. */
  externalOrderReference?: string;
}

export interface Application {
  id: string;
  reference: string;
  customerId: string;
  productId: string;
  productVersionId: string;
  currency: string;
  requestedPrincipal: MinorUnits;
  term: number;
  purpose: string | null;
  payee: Payee;
  externalOrderReference: string | null;
  status: ApplicationStatus;
  submittedBy: string | null;
  submittedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNotes: string | null;
  rejectionReasonCodes: string[];
  approvedPrincipal: MinorUnits | null;
  expiresAt: string | null;
  loanId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssessmentSummary {
  id: string;
  decision: CreditDecision;
  grade: string | null;
  reasonCodes: string[];
  aprBps: number | null;
  maxAffordablePrincipal: MinorUnits | null;
  createdAt: string;
}

export interface ApplicationDetail extends Application {
  latestAssessment: AssessmentSummary | null;
}

export interface Disclosure {
  currency: string;
  principal: MinorUnits;
  originationFee: MinorUnits;
  originationFeeTreatment: string;
  financedPrincipal: MinorUnits;
  netDisbursed: MinorUnits;
  numberOfInstalments: number;
  instalmentAmount: MinorUnits;
  totalInterest: MinorUnits;
  totalRepayable: MinorUnits;
  totalCostOfCredit: MinorUnits;
  aprBps: number;
  firstDueDate: string;
  maturityDate: string;
}

export interface Assessment {
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
  instalmentAmount: MinorUnits;
  maxAffordablePrincipal: MinorUnits | null;
  aprBps: number | null;
  assessedBy: string;
  createdAt: string;
  disclosure: Disclosure;
}

export type LoanStatus = 'PENDING_DISBURSEMENT' | 'ACTIVE' | 'CLOSED' | 'CANCELLED' | 'WRITTEN_OFF';

export interface Outstanding {
  principal: MinorUnits;
  interest: MinorUnits;
  fees: MinorUnits;
  penalties: MinorUnits;
  total: MinorUnits;
}

export interface Loan {
  id: string;
  reference: string;
  applicationId: string;
  customerId: string;
  currency: string;
  approvedPrincipal: MinorUnits;
  financedPrincipal: MinorUnits;
  originationFee: MinorUnits;
  netDisbursed: MinorUnits;
  aprBps: number | null;
  terms: {
    productCode: string;
    term: number;
    repaymentFrequency: string;
    interestMethod: string;
    annualInterestRateBps: number;
  };
  payee: Payee;
  status: LoanStatus;
  approvedBy: string | null;
  approvedAt: string;
  disbursedBy: string | null;
  disbursedAt: string | null;
  disbursementDate: string | null;
  maturityDate: string | null;
  providerReference: string | null;
  closedAt: string | null;
  daysPastDue: number;
  dpdBucket: string;
  outstanding: Outstanding;
  createdAt: string;
}

export interface Approval {
  application: Application;
  loan: Loan;
  disclosure: Disclosure;
}

export interface Instalment {
  seq: number;
  dueDate: string;
  principalDue: MinorUnits;
  interestDue: MinorUnits;
  feeDue: MinorUnits;
  penaltyDue: MinorUnits;
  totalDue: MinorUnits;
  totalOutstanding: MinorUnits;
  interestWaived: MinorUnits;
  status: 'PENDING' | 'PARTIALLY_PAID' | 'PAID' | 'WAIVED';
  paidAt: string | null;
}

export interface Schedule {
  loanId: string;
  currency: string;
  preview: boolean;
  disbursementDate: string;
  maturityDate: string;
  instalments: Instalment[];
}

export interface PayoffQuote {
  loanId: string;
  currency: string;
  asOf: string;
  principal: MinorUnits;
  interest: MinorUnits;
  fees: MinorUnits;
  penalties: MinorUnits;
  total: MinorUnits;
  waivedInterest: MinorUnits;
}

export type RepaymentChannel = 'BANK_TRANSFER' | 'CARD' | 'DIRECT_DEBIT' | 'MOBILE_MONEY' | 'CASH';

export interface RecordRepaymentRequest {
  amount: MinorUnits;
  channel: RepaymentChannel;
  externalReference?: string;
  valueDate?: string;
}

export interface Repayment {
  id: string;
  loanId: string;
  amount: MinorUnits;
  currency: string;
  valueDate: string;
  channel: RepaymentChannel;
  externalReference: string | null;
  allocation: { principal: MinorUnits; interest: MinorUnits; fee: MinorUnits; penalty: MinorUnits };
  journalEntryId: string;
  createdAt: string;
}

export interface RepaymentResult extends Repayment {
  settled: boolean;
  waivedInterest: MinorUnits;
  loanStatus: LoanStatus;
  daysPastDue: number;
  outstanding: Outstanding;
}

/** `POST /v1/operations/end-of-day` result (closes the given business date). */
export interface EndOfDaySummary {
  asOf: string;
  loansProcessed: number;
  loansSkipped: number;
  loansFailed: string[];
  applicationsFailed: string[];
  interestAccruals: number;
  lateFees: number;
  delinquencyUpdates: number;
  applicationsExpired: number;
  loansCancelled: number;
}

export interface Posting {
  accountCode: string;
  accountName: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: MinorUnits;
}

export interface JournalEntry {
  id: string;
  kind: string;
  effectiveDate: string;
  description: string;
  idempotencyRef: string;
  reversesEntryId: string | null;
  createdAt: string;
  postings: Posting[];
}

export interface AccountBalance {
  code: string;
  name: string;
  type: string;
  normalBalance: 'DEBIT' | 'CREDIT';
  debits: MinorUnits;
  credits: MinorUnits;
  balance: MinorUnits;
}

export interface LoanLedger {
  loanId: string;
  currency: string;
  entries: JournalEntry[];
  balances: AccountBalance[];
}

export interface TrialBalance {
  currency: string;
  accounts: AccountBalance[];
  totalDebits: MinorUnits;
  totalCredits: MinorUnits;
  balanced: boolean;
}

export interface AuditLogEntry {
  id: string;
  actorType: 'PLATFORM_ADMIN' | 'USER' | 'SYSTEM';
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  requestId: string | null;
  occurredAt: string;
  prevHash: string;
  hash: string;
}

export interface ChainVerification {
  valid: boolean;
  entriesChecked: number;
  firstBrokenEntryId?: string;
}

/** RFC 9457 problem details as emitted by the API's ProblemDetailsFilter. */
export interface Problem {
  type?: string;
  title?: string;
  status: number;
  detail?: string;
  instance?: string;
  code?: string;
  traceId?: string;
  errors?: { field: string; message: string }[];
  [extension: string]: unknown;
}
