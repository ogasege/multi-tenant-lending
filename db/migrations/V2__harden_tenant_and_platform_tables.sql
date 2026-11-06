-- =====================================================================================
-- 0002_harden_tenant_and_platform_tables.sql
--
-- 1. Tenants may only READ their own `institutions` row. Regulatory and lifecycle fields
--    (status, lender_type, max_apr_bps, slug) are platform-controlled: a tenant admin must
--    never be able to unsuspend itself or raise its own usury cap. Tenant-editable settings
--    live in `institution_branding`.
-- 2. Platform admin credentials get FORCE RLS. Rows are visible only inside a transaction
--    that the platform auth service opened with `app.platform_auth = on`
--    (TransactionRunner.asPlatformAuth), so no other code path can read password hashes or
--    refresh-token hashes, even by mistake.
-- =====================================================================================

DROP POLICY tenant_isolation ON institutions;
CREATE POLICY tenant_read_own ON institutions
  FOR SELECT
  USING (id = app_current_tenant());

ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_auth_only ON platform_admins
  USING (current_setting('app.platform_auth', true) = 'on')
  WITH CHECK (current_setting('app.platform_auth', true) = 'on');

ALTER TABLE platform_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_refresh_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_auth_only ON platform_refresh_tokens
  USING (current_setting('app.platform_auth', true) = 'on')
  WITH CHECK (current_setting('app.platform_auth', true) = 'on');
