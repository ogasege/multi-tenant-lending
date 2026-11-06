/**
 * Kysely table types. Hand-maintained mirror of db/migrations — the SQL is the source of
 * truth.
 *
 * Type conventions (set globally in pg type parsers, see pg-types.ts):
 *   BIGINT  -> bigint   (money in minor units; never JS number)
 *   DATE    -> string   ('YYYY-MM-DD', no timezone shifting)
 *   TIMESTAMPTZ -> Date
 */
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type CreatedAt = ColumnType<Date, never, never>;
type Json<T = unknown> = ColumnType<T, string, string>;
type BigIntCol = ColumnType<bigint, bigint, bigint>;
type BigIntDefault = ColumnType<bigint, bigint | undefined, bigint>;

export type UserRole =
  'INSTITUTION_ADMIN' | 'CREDIT_OFFICER' | 'FINANCE_OFFICER' | 'AUDITOR' | 'CUSTOMER';

export type RepaymentFrequency = 'BULLET' | 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';
export type LenderType =
  | 'COMMERCIAL_BANK'
  | 'MICROFINANCE_BANK'
  | 'FINANCE_COMPANY'
  | 'MONEY_LENDER'
  | 'MICROFINANCE_INSTITUTION';
export type PayeeType = 'VENDOR' | 'BORROWER';
export type InterestMethod = 'REDUCING_BALANCE' | 'FLAT' | 'EQUAL_PRINCIPAL';
export type FeeType = 'NONE' | 'FLAT' | 'PERCENTAGE';
export type FeeTreatment = 'DEDUCTED' | 'CAPITALISED';
export type ApplicationStatus =
  'SUBMITTED' | 'ASSESSED' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED';
export type LoanStatus = 'PENDING_DISBURSEMENT' | 'ACTIVE' | 'CLOSED' | 'CANCELLED' | 'WRITTEN_OFF';
export type DpdBucket = 'CURRENT' | 'DPD_1_30' | 'DPD_31_60' | 'DPD_61_90' | 'DPD_90_PLUS';
export type InstalmentStatus = 'PENDING' | 'PARTIALLY_PAID' | 'PAID' | 'WAIVED';
export type CreditDecision = 'APPROVE' | 'REFER' | 'DECLINE' | 'COUNTER_OFFER';
export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
export type Direction = 'DEBIT' | 'CREDIT';
export type JournalKind =
  'DISBURSEMENT' | 'INTEREST_ACCRUAL' | 'LATE_FEE' | 'REPAYMENT' | 'WRITE_OFF' | 'REVERSAL';
export type RepaymentChannel = 'BANK_TRANSFER' | 'CARD' | 'DIRECT_DEBIT' | 'MOBILE_MONEY' | 'CASH';
export type ActorType = 'PLATFORM_ADMIN' | 'USER' | 'SYSTEM';

export interface PlatformAdminsTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  full_name: string;
  status: ColumnType<'ACTIVE' | 'DISABLED', 'ACTIVE' | 'DISABLED' | undefined>;
  failed_login_count: Generated<number>;
  locked_until: Timestamp | null;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface PlatformRefreshTokensTable {
  id: Generated<string>;
  admin_id: string;
  family_id: string;
  token_hash: string;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  revoked_at: Timestamp | null;
  created_at: CreatedAt;
}

export interface InstitutionsTable {
  id: Generated<string>;
  slug: string;
  legal_name: string;
  country_code: string;
  default_currency: string;
  supported_currencies: string[];
  timezone: ColumnType<string, string | undefined>;
  lender_type: LenderType;
  max_apr_bps: number | null;
  status: ColumnType<'ACTIVE' | 'SUSPENDED', 'ACTIVE' | 'SUSPENDED' | undefined>;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
  /** AWS region of the cell holding this tenant's data (SPEC §4.1); no default. */
  home_region: string;
}

export interface InstitutionBrandingTable {
  tenant_id: string;
  display_name: string;
  logo_object_key: string | null;
  primary_color: ColumnType<string, string | undefined>;
  secondary_color: ColumnType<string, string | undefined>;
  support_email: string | null;
  support_phone: string | null;
  website_url: string | null;
  locale: ColumnType<string, string | undefined>;
  version: Generated<number>;
  updated_at: Generated<Date>;
}

export interface UsersTable {
  id: Generated<string>;
  tenant_id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: UserRole;
  status: ColumnType<'ACTIVE' | 'DISABLED', 'ACTIVE' | 'DISABLED' | undefined>;
  failed_login_count: Generated<number>;
  locked_until: Timestamp | null;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  revoked_at: Timestamp | null;
  created_at: CreatedAt;
}

export interface CustomersTable {
  id: Generated<string>;
  tenant_id: string;
  user_id: string;
  reference: string;
  customer_type: ColumnType<'INDIVIDUAL' | 'BUSINESS', 'INDIVIDUAL' | 'BUSINESS' | undefined>;
  first_name: string;
  last_name: string;
  business_name: string | null;
  business_registration_number: string | null;
  operating_licence_number: string | null;
  email: string;
  phone: string;
  date_of_birth: string;
  national_id_hmac: string;
  national_id_last4: string;
  kyc_status: ColumnType<
    'PENDING' | 'VERIFIED' | 'REJECTED',
    'PENDING' | 'VERIFIED' | 'REJECTED' | undefined
  >;
  employment_status: 'EMPLOYED' | 'SELF_EMPLOYED' | 'BUSINESS_OWNER' | 'UNEMPLOYED';
  employer_name: string | null;
  months_in_employment: Generated<number>;
  currency: string;
  monthly_income: BigIntCol;
  monthly_expenses: BigIntDefault;
  existing_monthly_debt: BigIntDefault;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface LoanProductsTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  description: string | null;
  status: ColumnType<'ACTIVE' | 'ARCHIVED', 'ACTIVE' | 'ARCHIVED' | undefined>;
  current_version: Generated<number>;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface LoanProductVersionsTable {
  id: Generated<string>;
  tenant_id: string;
  product_id: string;
  version: number;
  currency: string;
  min_principal: BigIntCol;
  max_principal: BigIntCol;
  min_term: number;
  max_term: number;
  repayment_frequency: RepaymentFrequency;
  interest_method: InterestMethod;
  annual_interest_rate_bps: number;
  day_count: ColumnType<'ACT_365F', 'ACT_365F' | undefined>;
  origination_fee_type: FeeType;
  origination_fee_value: BigIntDefault;
  origination_fee_treatment: ColumnType<FeeTreatment, FeeTreatment | undefined>;
  late_fee_type: FeeType;
  late_fee_value: BigIntDefault;
  late_fee_grace_days: Generated<number>;
  max_dti_bps: Generated<number>;
  min_credit_score: Generated<number>;
  application_expiry_days: Generated<number>;
  disbursement_mode: ColumnType<PayeeType, PayeeType | undefined>;
  created_by: string | null;
  created_at: CreatedAt;
}

export interface LoanApplicationsTable {
  id: Generated<string>;
  tenant_id: string;
  reference: string;
  customer_id: string;
  product_id: string;
  product_version_id: string;
  currency: string;
  requested_principal: BigIntCol;
  term: number;
  purpose: string | null;
  payee_type: PayeeType;
  payee_name: string;
  payee_account: string;
  external_order_reference: string | null;
  status: ApplicationStatus;
  submitted_by: string;
  submitted_at: Generated<Date>;
  decided_by: string | null;
  decided_at: Timestamp | null;
  decision_notes: string | null;
  rejection_reason_codes: ColumnType<string[], string[] | undefined>;
  approved_principal: ColumnType<bigint | null, bigint | null | undefined>;
  expires_at: Timestamp | null;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface CreditAssessmentsTable {
  id: Generated<string>;
  tenant_id: string;
  application_id: string;
  model_version: string;
  bureau_score: number;
  bureau_delinquent: boolean;
  dti_bps: number;
  instalment_amount: BigIntCol;
  scorecard_points: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'E';
  decision: CreditDecision;
  reason_codes: ColumnType<string[], string[] | undefined>;
  max_affordable_principal: ColumnType<bigint | null, bigint | null | undefined>;
  apr_bps: number | null;
  inputs: Json;
  assessed_by: string;
  created_at: CreatedAt;
}

export interface LoanTermsSnapshot {
  productId: string;
  productVersionId: string;
  productVersion: number;
  productCode: string;
  currency: string;
  term: number;
  repaymentFrequency: RepaymentFrequency;
  interestMethod: InterestMethod;
  annualInterestRateBps: number;
  dayCount: 'ACT_365F';
  originationFee: { type: FeeType; value: string; treatment: FeeTreatment };
  lateFee: { type: FeeType; value: string; graceDays: number };
}

export interface LoansTable {
  id: Generated<string>;
  tenant_id: string;
  reference: string;
  application_id: string;
  customer_id: string;
  product_version_id: string;
  currency: string;
  approved_principal: BigIntCol;
  financed_principal: BigIntCol;
  origination_fee: BigIntDefault;
  net_disbursed: BigIntCol;
  terms: Json<LoanTermsSnapshot>;
  payee_type: PayeeType;
  payee_name: string;
  payee_account: string;
  apr_bps: number | null;
  status: LoanStatus;
  approved_by: string;
  approved_at: Generated<Date>;
  disbursed_by: string | null;
  disbursed_at: Timestamp | null;
  disbursement_date: string | null;
  maturity_date: string | null;
  provider_reference: string | null;
  closed_at: Timestamp | null;
  days_past_due: Generated<number>;
  dpd_bucket: ColumnType<DpdBucket, DpdBucket | undefined>;
  version: Generated<number>;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface LoanInstalmentsTable {
  id: Generated<string>;
  tenant_id: string;
  loan_id: string;
  seq: number;
  due_date: string;
  principal_due: BigIntCol;
  interest_due: BigIntCol;
  fee_due: BigIntDefault;
  penalty_due: BigIntDefault;
  principal_paid: BigIntDefault;
  interest_paid: BigIntDefault;
  fee_paid: BigIntDefault;
  penalty_paid: BigIntDefault;
  interest_waived: BigIntDefault;
  interest_accrued: Generated<boolean>;
  late_fee_assessed: Generated<boolean>;
  status: ColumnType<InstalmentStatus, InstalmentStatus | undefined>;
  paid_at: Timestamp | null;
  updated_at: Generated<Date>;
}

export interface RepaymentsTable {
  id: Generated<string>;
  tenant_id: string;
  loan_id: string;
  amount: BigIntCol;
  currency: string;
  value_date: string;
  channel: RepaymentChannel;
  external_reference: string | null;
  allocated_principal: BigIntDefault;
  allocated_interest: BigIntDefault;
  allocated_fee: BigIntDefault;
  allocated_penalty: BigIntDefault;
  journal_entry_id: string;
  recorded_by: string;
  created_at: CreatedAt;
}

export interface LedgerAccountsTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  type: AccountType;
  normal_balance: Direction;
  currency: string;
  created_at: CreatedAt;
}

export interface JournalEntriesTable {
  id: Generated<string>;
  tenant_id: string;
  kind: JournalKind;
  loan_id: string | null;
  currency: string;
  description: string;
  effective_date: string;
  idempotency_ref: string;
  reverses_entry_id: string | null;
  created_by: string | null;
  created_at: CreatedAt;
}

export interface PostingsTable {
  id: Generated<string>;
  tenant_id: string;
  journal_entry_id: string;
  account_id: string;
  direction: Direction;
  amount: BigIntCol;
  currency: string;
  created_at: CreatedAt;
}

export interface AuditLogTable {
  id: Generated<bigint>;
  tenant_id: string;
  actor_type: ActorType;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  before_state: Json | null;
  after_state: Json | null;
  request_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  occurred_at: ColumnType<Date, Date | undefined, never>;
  prev_hash: string;
  hash: string;
}

export interface IdempotencyKeysTable {
  tenant_id: string;
  principal_id: string;
  idempotency_key: string;
  fingerprint: string;
  method: string;
  path: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  response_status: number | null;
  response_body: Json | null;
  locked_at: Timestamp;
  created_at: CreatedAt;
  expires_at: Timestamp;
}

export interface OutboxEventsTable {
  id: Generated<string>;
  tenant_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Json;
  occurred_at: Generated<Date>;
  published_at: Timestamp | null;
  attempts: Generated<number>;
  last_error: string | null;
}

export interface WebhookEndpointsTable {
  id: Generated<string>;
  tenant_id: string;
  url: string;
  secret_ciphertext: string;
  event_types: string[];
  status: ColumnType<'ACTIVE' | 'DISABLED', 'ACTIVE' | 'DISABLED' | undefined>;
  created_at: CreatedAt;
  updated_at: Generated<Date>;
}

export interface WebhookDeliveriesTable {
  id: Generated<string>;
  tenant_id: string;
  endpoint_id: string;
  event_id: string;
  attempt: number;
  status: 'SUCCEEDED' | 'FAILED';
  response_status: number | null;
  error: string | null;
  duration_ms: number | null;
  created_at: CreatedAt;
}

export interface Database {
  platform_admins: PlatformAdminsTable;
  platform_refresh_tokens: PlatformRefreshTokensTable;
  institutions: InstitutionsTable;
  institution_branding: InstitutionBrandingTable;
  users: UsersTable;
  refresh_tokens: RefreshTokensTable;
  customers: CustomersTable;
  loan_products: LoanProductsTable;
  loan_product_versions: LoanProductVersionsTable;
  loan_applications: LoanApplicationsTable;
  credit_assessments: CreditAssessmentsTable;
  loans: LoansTable;
  loan_instalments: LoanInstalmentsTable;
  repayments: RepaymentsTable;
  ledger_accounts: LedgerAccountsTable;
  journal_entries: JournalEntriesTable;
  postings: PostingsTable;
  audit_log: AuditLogTable;
  idempotency_keys: IdempotencyKeysTable;
  outbox_events: OutboxEventsTable;
  webhook_endpoints: WebhookEndpointsTable;
  webhook_deliveries: WebhookDeliveriesTable;
}

export type Row<T extends keyof Database> = Selectable<Database[T]>;
export type NewRow<T extends keyof Database> = Insertable<Database[T]>;
export type RowUpdate<T extends keyof Database> = Updateable<Database[T]>;
