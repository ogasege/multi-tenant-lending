-- =====================================================================================
-- 0001_core_schema.sql
-- Core schema for the multi-tenant lending platform.
--
-- Conventions
--   * Every tenant-owned table has `tenant_id uuid NOT NULL` and Row-Level Security with
--     ENABLE + FORCE and two policies:
--        tenant_isolation  (all roles)       : tenant_id = current tenant (fail closed)
--        worker_all        (lending_worker)  : unrestricted, for cross-tenant jobs
--   * Cross-table references use composite FKs (tenant_id, id) so a row can never point at
--     another tenant's row, even through an application bug.
--   * Money is BIGINT in ISO-4217 minor units + CHAR(3) currency. Rates are basis points.
--   * Immutable tables (ledger, audit, product versions) are protected by triggers and by
--     withholding UPDATE/DELETE grants.
-- =====================================================================================

-- ---------- helpers -----------------------------------------------------------------

-- Current tenant from the transaction-local setting; NULL (=> no rows) when unset.
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION app_touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE FUNCTION app_forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RAISE EXCEPTION '% on % is not allowed: table is append-only', TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END $$;

-- Applies the standard tenant RLS policies to a table.
CREATE FUNCTION app_enable_tenant_rls(tbl regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
  BEGIN
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s USING (tenant_id = app_current_tenant()) '
      'WITH CHECK (tenant_id = app_current_tenant())', tbl);
    EXECUTE format(
      'CREATE POLICY worker_all ON %s TO lending_worker USING (true) WITH CHECK (true)', tbl);
  END $$;

-- ---------- platform (not tenant-scoped) -------------------------------------------

CREATE TABLE platform_admins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  password_hash   text NOT NULL,
  full_name       text NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_admins_email_uq ON platform_admins (lower(email));

CREATE TABLE platform_refresh_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id      uuid NOT NULL REFERENCES platform_admins (id),
  family_id     uuid NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_refresh_tokens_family_idx ON platform_refresh_tokens (family_id);

-- ---------- tenants -----------------------------------------------------------------

-- The tenant registry. `id` IS the tenant id; RLS lets a tenant see only its own row.
CREATE TABLE institutions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 63),
  legal_name        text NOT NULL,
  country_code      char(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  default_currency  char(3) NOT NULL CHECK (default_currency ~ '^[A-Z]{3}$'),
  supported_currencies char(3)[] NOT NULL,
  timezone          text NOT NULL DEFAULT 'Africa/Lagos',
  -- Regulatory profile. Lender type drives licensing rules; max_apr_bps enforces usury caps
  -- (e.g. WAEMU: 14% banks, 24% microfinance/SFD) on the all-in APR at approval time.
  lender_type       text NOT NULL CHECK (lender_type IN
                      ('COMMERCIAL_BANK', 'MICROFINANCE_BANK', 'FINANCE_COMPANY', 'MONEY_LENDER', 'MICROFINANCE_INSTITUTION')),
  max_apr_bps       integer CHECK (max_apr_bps > 0),
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (default_currency = ANY (supported_currencies))
);
ALTER TABLE institutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE institutions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON institutions
  USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());
CREATE POLICY worker_all ON institutions TO lending_worker USING (true) WITH CHECK (true);
-- Platform administrators (verified JWT with aud=platform) list and suspend institutions.
-- `app.platform_admin` is set transaction-locally by TransactionRunner.asPlatformAdmin()
-- only after token verification; it grants nothing beyond this one table.
CREATE POLICY platform_admin_all ON institutions
  USING (current_setting('app.platform_admin', true) = 'on')
  WITH CHECK (current_setting('app.platform_admin', true) = 'on');

-- Public, unauthenticated routes (login, customer sign-up, public branding) need to map a
-- slug to a tenant id before a tenant context exists. This narrowly-scoped SECURITY DEFINER
-- function is the ONLY way the app role can do that; it returns no other data.
CREATE FUNCTION resolve_institution(p_slug text)
  RETURNS TABLE (id uuid, status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT i.id, i.status FROM institutions i WHERE i.slug = p_slug $$;

CREATE TABLE institution_branding (
  tenant_id        uuid PRIMARY KEY REFERENCES institutions (id),
  display_name     text NOT NULL,
  logo_object_key  text,
  primary_color    text NOT NULL DEFAULT '#0B5FFF' CHECK (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  secondary_color  text NOT NULL DEFAULT '#111827' CHECK (secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
  support_email    text,
  support_phone    text,
  website_url      text,
  locale           text NOT NULL DEFAULT 'en-NG',
  version          integer NOT NULL DEFAULT 1,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
SELECT app_enable_tenant_rls('institution_branding');

-- ---------- identity ----------------------------------------------------------------

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES institutions (id),
  email              text NOT NULL,
  password_hash      text NOT NULL,
  full_name          text NOT NULL,
  role               text NOT NULL CHECK (role IN
                       ('INSTITUTION_ADMIN', 'CREDIT_OFFICER', 'FINANCE_OFFICER', 'AUDITOR', 'CUSTOMER')),
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX users_tenant_email_uq ON users (tenant_id, lower(email));
SELECT app_enable_tenant_rls('users');

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (tenant_id, family_id);
SELECT app_enable_tenant_rls('refresh_tokens');

-- Refresh happens before a tenant context exists (the access token has expired), so the
-- app role looks the token up through this SECURITY DEFINER function, which only reveals
-- the tenant/user the hash belongs to.
CREATE FUNCTION resolve_refresh_token(p_token_hash text)
  RETURNS TABLE (tenant_id uuid, user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT r.tenant_id, r.user_id FROM refresh_tokens r WHERE r.token_hash = p_token_hash $$;

-- ---------- customers (borrowers) --------------------------------------------------

CREATE TABLE customers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES institutions (id),
  user_id               uuid NOT NULL,
  reference             text NOT NULL,
  -- Borrowers are primarily healthcare businesses (pharmacies, clinics, hospitals); the
  -- individual fields describe the owner/director who signs and is KYC'd.
  customer_type         text NOT NULL DEFAULT 'BUSINESS' CHECK (customer_type IN ('INDIVIDUAL', 'BUSINESS')),
  first_name            text NOT NULL,
  last_name             text NOT NULL,
  business_name         text,
  business_registration_number text,          -- e.g. CAC RC/BN (NG), NINEA/RCCM (SN)
  operating_licence_number     text,          -- e.g. PCN premises licence for pharmacies
  email                 text NOT NULL,
  phone                 text NOT NULL,
  date_of_birth         date NOT NULL,
  national_id_hmac      text NOT NULL,          -- HMAC-SHA256 of BVN/NIN; raw value never stored
  national_id_last4     char(4) NOT NULL,
  kyc_status            text NOT NULL DEFAULT 'PENDING' CHECK (kyc_status IN ('PENDING', 'VERIFIED', 'REJECTED')),
  employment_status     text NOT NULL CHECK (employment_status IN ('EMPLOYED', 'SELF_EMPLOYED', 'BUSINESS_OWNER', 'UNEMPLOYED')),
  employer_name         text,
  months_in_employment  integer NOT NULL DEFAULT 0 CHECK (months_in_employment >= 0),
  currency              char(3) NOT NULL,
  monthly_income        bigint NOT NULL CHECK (monthly_income >= 0),   -- net monthly income / business net inflow
  monthly_expenses      bigint NOT NULL DEFAULT 0 CHECK (monthly_expenses >= 0),
  existing_monthly_debt bigint NOT NULL DEFAULT 0 CHECK (existing_monthly_debt >= 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (customer_type = 'INDIVIDUAL' OR (business_name IS NOT NULL AND business_registration_number IS NOT NULL)),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, reference),
  UNIQUE (tenant_id, national_id_hmac),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
SELECT app_enable_tenant_rls('customers');

-- ---------- loan products (versioned, white-label configuration) -------------------

CREATE TABLE loan_products (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES institutions (id),
  code             text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{2,32}$'),
  name             text NOT NULL,
  description      text,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  current_version  integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);
SELECT app_enable_tenant_rls('loan_products');

CREATE TABLE loan_product_versions (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL,
  product_id                 uuid NOT NULL,
  version                    integer NOT NULL CHECK (version >= 1),
  currency                   char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  min_principal              bigint NOT NULL CHECK (min_principal > 0),
  max_principal              bigint NOT NULL,
  min_term                   integer NOT NULL CHECK (min_term >= 1),
  max_term                   integer NOT NULL,
  -- BULLET = single repayment of principal + interest at maturity; then min/max_term are
  -- tenor in DAYS (typical inventory finance: 14–90 days). Otherwise terms are instalment counts.
  repayment_frequency        text NOT NULL CHECK (repayment_frequency IN ('BULLET', 'DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY')),
  interest_method            text NOT NULL CHECK (interest_method IN ('REDUCING_BALANCE', 'FLAT', 'EQUAL_PRINCIPAL')),
  annual_interest_rate_bps   integer NOT NULL CHECK (annual_interest_rate_bps BETWEEN 0 AND 100000),
  day_count                  text NOT NULL DEFAULT 'ACT_365F' CHECK (day_count IN ('ACT_365F')),
  origination_fee_type       text NOT NULL CHECK (origination_fee_type IN ('NONE', 'FLAT', 'PERCENTAGE')),
  origination_fee_value      bigint NOT NULL DEFAULT 0 CHECK (origination_fee_value >= 0), -- minor units or bps
  origination_fee_treatment  text NOT NULL DEFAULT 'DEDUCTED' CHECK (origination_fee_treatment IN ('DEDUCTED', 'CAPITALISED')),
  late_fee_type              text NOT NULL CHECK (late_fee_type IN ('NONE', 'FLAT', 'PERCENTAGE')),
  late_fee_value             bigint NOT NULL DEFAULT 0 CHECK (late_fee_value >= 0),
  late_fee_grace_days        integer NOT NULL DEFAULT 0 CHECK (late_fee_grace_days >= 0),
  max_dti_bps                integer NOT NULL DEFAULT 4000 CHECK (max_dti_bps BETWEEN 1 AND 10000),
  min_credit_score           integer NOT NULL DEFAULT 0 CHECK (min_credit_score BETWEEN 0 AND 850),
  application_expiry_days    integer NOT NULL DEFAULT 14 CHECK (application_expiry_days >= 1),
  -- VENDOR: funds go straight to the supplier (checkout / inventory financing — the borrower
  -- never handles cash). BORROWER: funds go to the borrower's account.
  disbursement_mode          text NOT NULL DEFAULT 'VENDOR' CHECK (disbursement_mode IN ('VENDOR', 'BORROWER')),
  created_by                 uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, product_id, version),
  FOREIGN KEY (tenant_id, product_id) REFERENCES loan_products (tenant_id, id),
  CHECK (max_principal >= min_principal),
  CHECK (max_term >= min_term)
);
SELECT app_enable_tenant_rls('loan_product_versions');
CREATE TRIGGER loan_product_versions_immutable
  BEFORE UPDATE OR DELETE ON loan_product_versions
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------- applications & credit assessment ---------------------------------------

CREATE TABLE loan_applications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  reference             text NOT NULL,
  customer_id           uuid NOT NULL,
  product_id            uuid NOT NULL,
  product_version_id    uuid NOT NULL,
  currency              char(3) NOT NULL,
  requested_principal   bigint NOT NULL CHECK (requested_principal > 0),
  term                  integer NOT NULL CHECK (term >= 1),
  purpose               text,
  payee_type            text NOT NULL CHECK (payee_type IN ('VENDOR', 'BORROWER')),
  payee_name            text NOT NULL,
  payee_account         text NOT NULL,          -- bank account / wallet reference of the payee
  external_order_reference text,               -- purchase order on the procurement platform
  status                text NOT NULL CHECK (status IN
                          ('SUBMITTED', 'ASSESSED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED')),
  submitted_by          uuid NOT NULL,
  submitted_at          timestamptz NOT NULL DEFAULT now(),
  decided_by            uuid,
  decided_at            timestamptz,
  decision_notes        text,
  rejection_reason_codes text[] NOT NULL DEFAULT '{}',
  approved_principal    bigint CHECK (approved_principal > 0),
  expires_at            timestamptz,
  version               integer NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, reference),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES loan_products (tenant_id, id),
  FOREIGN KEY (tenant_id, product_version_id) REFERENCES loan_product_versions (tenant_id, id)
);
CREATE INDEX loan_applications_status_idx ON loan_applications (tenant_id, status, created_at DESC);
CREATE INDEX loan_applications_customer_idx ON loan_applications (tenant_id, customer_id);
SELECT app_enable_tenant_rls('loan_applications');

CREATE TABLE credit_assessments (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL,
  application_id            uuid NOT NULL,
  model_version             text NOT NULL,
  bureau_score              integer NOT NULL CHECK (bureau_score BETWEEN 300 AND 850),
  bureau_delinquent         boolean NOT NULL,
  dti_bps                   integer NOT NULL,
  instalment_amount         bigint NOT NULL,
  scorecard_points          integer NOT NULL,
  grade                     char(1) NOT NULL CHECK (grade IN ('A', 'B', 'C', 'D', 'E')),
  decision                  text NOT NULL CHECK (decision IN ('APPROVE', 'REFER', 'DECLINE', 'COUNTER_OFFER')),
  reason_codes              text[] NOT NULL DEFAULT '{}',
  max_affordable_principal  bigint,
  apr_bps                   integer,
  inputs                    jsonb NOT NULL,       -- full input snapshot => reproducible decision
  assessed_by               uuid NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES loan_applications (tenant_id, id)
);
CREATE INDEX credit_assessments_application_idx ON credit_assessments (tenant_id, application_id, created_at DESC);
SELECT app_enable_tenant_rls('credit_assessments');

-- ---------- loans & schedule ----------------------------------------------------------

CREATE TABLE loans (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  reference            text NOT NULL,
  application_id       uuid NOT NULL,
  customer_id          uuid NOT NULL,
  product_version_id   uuid NOT NULL,
  currency             char(3) NOT NULL,
  approved_principal   bigint NOT NULL CHECK (approved_principal > 0),  -- what the borrower asked/was approved for
  financed_principal   bigint NOT NULL CHECK (financed_principal > 0),  -- approved + capitalised fee
  origination_fee      bigint NOT NULL DEFAULT 0 CHECK (origination_fee >= 0),
  net_disbursed        bigint NOT NULL CHECK (net_disbursed > 0),       -- cash that leaves the institution
  terms                jsonb NOT NULL,                                  -- snapshot of product terms at approval
  payee_type           text NOT NULL CHECK (payee_type IN ('VENDOR', 'BORROWER')),
  payee_name           text NOT NULL,
  payee_account        text NOT NULL,
  apr_bps              integer,
  status               text NOT NULL CHECK (status IN
                         ('PENDING_DISBURSEMENT', 'ACTIVE', 'CLOSED', 'CANCELLED', 'WRITTEN_OFF')),
  approved_by          uuid NOT NULL,
  approved_at          timestamptz NOT NULL DEFAULT now(),
  disbursed_by         uuid,
  disbursed_at         timestamptz,
  disbursement_date    date,
  maturity_date        date,
  provider_reference   text,
  closed_at            timestamptz,
  days_past_due        integer NOT NULL DEFAULT 0 CHECK (days_past_due >= 0),
  dpd_bucket           text NOT NULL DEFAULT 'CURRENT' CHECK (dpd_bucket IN
                         ('CURRENT', 'DPD_1_30', 'DPD_31_60', 'DPD_61_90', 'DPD_90_PLUS')),
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, reference),
  UNIQUE (tenant_id, application_id),                 -- one loan per approved application
  UNIQUE (tenant_id, provider_reference),             -- one disbursement per provider transfer
  FOREIGN KEY (tenant_id, application_id) REFERENCES loan_applications (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id),
  FOREIGN KEY (tenant_id, product_version_id) REFERENCES loan_product_versions (tenant_id, id),
  CHECK (status <> 'ACTIVE' OR (disbursed_at IS NOT NULL AND provider_reference IS NOT NULL))
);
CREATE INDEX loans_status_idx ON loans (tenant_id, status, created_at DESC);
CREATE INDEX loans_customer_idx ON loans (tenant_id, customer_id);
SELECT app_enable_tenant_rls('loans');

CREATE TABLE loan_instalments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  loan_id            uuid NOT NULL,
  seq                integer NOT NULL CHECK (seq >= 1),
  due_date           date NOT NULL,
  principal_due      bigint NOT NULL CHECK (principal_due >= 0),
  interest_due       bigint NOT NULL CHECK (interest_due >= 0),
  fee_due            bigint NOT NULL DEFAULT 0 CHECK (fee_due >= 0),
  penalty_due        bigint NOT NULL DEFAULT 0 CHECK (penalty_due >= 0),
  principal_paid     bigint NOT NULL DEFAULT 0 CHECK (principal_paid >= 0),
  interest_paid      bigint NOT NULL DEFAULT 0 CHECK (interest_paid >= 0),
  fee_paid           bigint NOT NULL DEFAULT 0 CHECK (fee_paid >= 0),
  penalty_paid       bigint NOT NULL DEFAULT 0 CHECK (penalty_paid >= 0),
  interest_waived    bigint NOT NULL DEFAULT 0 CHECK (interest_waived >= 0),
  interest_accrued   boolean NOT NULL DEFAULT false,   -- interest recognised in the ledger?
  late_fee_assessed  boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PARTIALLY_PAID', 'PAID', 'WAIVED')),
  paid_at            timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, loan_id, seq),
  FOREIGN KEY (tenant_id, loan_id) REFERENCES loans (tenant_id, id),
  CHECK (principal_paid <= principal_due AND fee_paid <= fee_due AND penalty_paid <= penalty_due
         AND interest_paid + interest_waived <= interest_due)
);
CREATE INDEX loan_instalments_due_idx ON loan_instalments (tenant_id, due_date) WHERE status IN ('PENDING', 'PARTIALLY_PAID');
SELECT app_enable_tenant_rls('loan_instalments');

-- ---------- double-entry ledger ---------------------------------------------------------

CREATE TABLE ledger_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES institutions (id),
  code            text NOT NULL,
  name            text NOT NULL,
  type            text NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')),
  normal_balance  text NOT NULL CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
  currency        char(3) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code, currency)
);
SELECT app_enable_tenant_rls('ledger_accounts');

CREATE TABLE journal_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES institutions (id),
  kind             text NOT NULL CHECK (kind IN
                     ('DISBURSEMENT', 'INTEREST_ACCRUAL', 'LATE_FEE', 'REPAYMENT', 'WRITE_OFF', 'REVERSAL')),
  loan_id          uuid,
  currency         char(3) NOT NULL,
  description      text NOT NULL,
  effective_date   date NOT NULL,
  idempotency_ref  text NOT NULL,             -- e.g. "disbursement:<loanId>" — business-level dedupe
  reverses_entry_id uuid,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_ref),
  FOREIGN KEY (tenant_id, loan_id) REFERENCES loans (tenant_id, id)
);
CREATE INDEX journal_entries_loan_idx ON journal_entries (tenant_id, loan_id, created_at);
SELECT app_enable_tenant_rls('journal_entries');

CREATE TABLE postings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  journal_entry_id  uuid NOT NULL,
  account_id        uuid NOT NULL,
  direction         text NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount            bigint NOT NULL CHECK (amount > 0),
  currency          char(3) NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES ledger_accounts (tenant_id, id)
);
CREATE INDEX postings_entry_idx ON postings (tenant_id, journal_entry_id);
CREATE INDEX postings_account_idx ON postings (tenant_id, account_id);
SELECT app_enable_tenant_rls('postings');

-- Every journal entry must balance (Σdebit = Σcredit), have >= 2 postings and a single
-- currency. Deferred to COMMIT so all postings of an entry can be inserted first.
CREATE FUNCTION app_check_journal_balanced() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    v_debits  numeric;
    v_credits numeric;
    v_count   integer;
    v_bad_ccy integer;
  BEGIN
    SELECT COALESCE(SUM(amount) FILTER (WHERE p.direction = 'DEBIT'), 0),
           COALESCE(SUM(amount) FILTER (WHERE p.direction = 'CREDIT'), 0),
           COUNT(*),
           COUNT(*) FILTER (WHERE p.currency <> je.currency)
      INTO v_debits, v_credits, v_count, v_bad_ccy
      FROM postings p
      JOIN journal_entries je ON je.id = p.journal_entry_id
     WHERE p.journal_entry_id = NEW.journal_entry_id;

    IF v_count < 2 OR v_debits <> v_credits OR v_bad_ccy > 0 THEN
      RAISE EXCEPTION 'journal entry % is unbalanced (debits=%, credits=%, postings=%, currency_mismatch=%)',
        NEW.journal_entry_id, v_debits, v_credits, v_count, v_bad_ccy
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END $$;

CREATE CONSTRAINT TRIGGER postings_balanced
  AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_check_journal_balanced();

CREATE TRIGGER journal_entries_append_only
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
CREATE TRIGGER postings_append_only
  BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

-- ---------- repayments (after ledger: references journal_entries) -------------------

CREATE TABLE repayments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  loan_id             uuid NOT NULL,
  amount              bigint NOT NULL CHECK (amount > 0),
  currency            char(3) NOT NULL,
  value_date          date NOT NULL,
  channel             text NOT NULL CHECK (channel IN ('BANK_TRANSFER', 'CARD', 'DIRECT_DEBIT', 'MOBILE_MONEY', 'CASH')),
  external_reference  text,
  allocated_principal bigint NOT NULL DEFAULT 0,
  allocated_interest  bigint NOT NULL DEFAULT 0,
  allocated_fee       bigint NOT NULL DEFAULT 0,
  allocated_penalty   bigint NOT NULL DEFAULT 0,
  journal_entry_id    uuid NOT NULL,
  recorded_by         uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, external_reference),
  FOREIGN KEY (tenant_id, loan_id) REFERENCES loans (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  CHECK (allocated_principal + allocated_interest + allocated_fee + allocated_penalty = amount)
);
CREATE INDEX repayments_loan_idx ON repayments (tenant_id, loan_id, created_at);
SELECT app_enable_tenant_rls('repayments');

-- ---------- audit log (append-only, hash-chained per tenant) ---------------------------

CREATE TABLE audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL,       -- platform actions are recorded in the affected tenant's chain
  actor_type    text NOT NULL CHECK (actor_type IN ('PLATFORM_ADMIN', 'USER', 'SYSTEM')),
  actor_id      uuid,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text NOT NULL,
  before_state  jsonb,
  after_state   jsonb,
  request_id    text,
  ip_address    text,
  user_agent    text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  prev_hash     text NOT NULL,
  hash          text NOT NULL UNIQUE
);
CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, id);
CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity_type, entity_id);
SELECT app_enable_tenant_rls('audit_log');
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app_forbid_mutation();

-- ---------- idempotency -------------------------------------------------------------

CREATE TABLE idempotency_keys (
  tenant_id        uuid NOT NULL REFERENCES institutions (id),
  principal_id     uuid NOT NULL,
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 255),
  fingerprint      text NOT NULL,
  method           text NOT NULL,
  path             text NOT NULL,
  status           text NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response_status  integer,
  response_body    jsonb,
  locked_at        timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (tenant_id, principal_id, idempotency_key)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);
SELECT app_enable_tenant_rls('idempotency_keys');

-- ---------- transactional outbox & webhooks ----------------------------------------

CREATE TABLE outbox_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES institutions (id),
  event_type      text NOT NULL,
  aggregate_type  text NOT NULL,
  aggregate_id    text NOT NULL,
  payload         jsonb NOT NULL,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text
);
CREATE INDEX outbox_events_unpublished_idx ON outbox_events (occurred_at) WHERE published_at IS NULL;
SELECT app_enable_tenant_rls('outbox_events');

CREATE TABLE webhook_endpoints (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES institutions (id),
  url                text NOT NULL CHECK (url ~ '^https://'),
  secret_ciphertext  text NOT NULL,          -- AES-256-GCM; plaintext shown once at creation
  event_types        text[] NOT NULL,
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
SELECT app_enable_tenant_rls('webhook_endpoints');

CREATE TABLE webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  endpoint_id      uuid NOT NULL,
  event_id         uuid NOT NULL,
  attempt          integer NOT NULL,
  status           text NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED')),
  response_status  integer,
  error            text,
  duration_ms      integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, endpoint_id) REFERENCES webhook_endpoints (tenant_id, id)
);
CREATE INDEX webhook_deliveries_event_idx ON webhook_deliveries (tenant_id, event_id);
SELECT app_enable_tenant_rls('webhook_deliveries');

-- ---------- updated_at triggers -----------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_admins', 'institutions', 'institution_branding', 'users',
    'customers', 'loan_products', 'loan_applications', 'loans', 'loan_instalments', 'webhook_endpoints']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()', t, t);
  END LOOP;
END $$;

-- ---------- privileges ----------------------------------------------------------------
-- Least privilege: runtime roles get DML only; append-only tables get SELECT/INSERT only.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO lending_app, lending_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lending_app, lending_worker;
REVOKE UPDATE, DELETE ON journal_entries, postings, audit_log, loan_product_versions
  FROM lending_app, lending_worker;
-- Platform admin credentials are not tenant data (no RLS); only the API authenticates them.
REVOKE ALL ON platform_admins, platform_refresh_tokens FROM lending_worker;

GRANT EXECUTE ON FUNCTION app_current_tenant(), resolve_institution(text), resolve_refresh_token(text)
  TO lending_app, lending_worker;

-- FORCE RLS also applies to the table owner. The two SECURITY DEFINER lookups above run as
-- the owner, so the owner gets a narrow read-only policy on exactly those two tables.
-- (Locally the owner is a superuser and bypasses RLS anyway; on RDS it is not.)
DO $$
BEGIN
  EXECUTE format('CREATE POLICY definer_read ON institutions FOR SELECT TO %I USING (true)', current_user);
  EXECUTE format('CREATE POLICY definer_read ON refresh_tokens FOR SELECT TO %I USING (true)', current_user);
END $$;

-- Tables created by later migrations get the same runtime grants automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lending_app, lending_worker;
