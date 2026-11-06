-- =====================================================================================
-- V4__pagination_indexes.sql
--
-- Indexes for keyset ("seek") pagination of list endpoints. Lists are ordered newest first
-- by (created_at DESC, id DESC); `id` breaks ties between rows created in the same
-- microsecond, so the order is total and stable. The next page is fetched with
--   WHERE tenant_id = $1 AND (created_at, id) < ($cursor_created_at, $cursor_id)
--   ORDER BY created_at DESC, id DESC LIMIT $n
-- which, with these indexes, is a single index range scan whose cost does not grow with
-- the page number (unlike OFFSET, which reads and discards every skipped row) and which
-- never skips or repeats rows when new ones are inserted between requests.
--
-- Tenant tables lead with tenant_id, matching the RLS predicate (tenant_id = current
-- tenant) so isolation and pagination use the same index. `institutions` is listed only
-- by platform administrators across tenants, hence no tenant_id prefix.
--
-- Plain CREATE INDEX (not CONCURRENTLY): Flyway runs each migration in a transaction and
-- the tables are still small. Index changes on large production tables belong in their
-- own non-transactional migration.
-- =====================================================================================

CREATE INDEX institutions_created_idx      ON institutions      (created_at DESC, id DESC);
CREATE INDEX users_created_idx             ON users             (tenant_id, created_at DESC, id DESC);
CREATE INDEX customers_created_idx         ON customers         (tenant_id, created_at DESC, id DESC);
CREATE INDEX loan_products_created_idx     ON loan_products     (tenant_id, created_at DESC, id DESC);
CREATE INDEX loan_applications_created_idx ON loan_applications (tenant_id, created_at DESC, id DESC);
CREATE INDEX loans_created_idx             ON loans             (tenant_id, created_at DESC, id DESC);
CREATE INDEX repayments_created_idx        ON repayments        (tenant_id, created_at DESC, id DESC);
CREATE INDEX webhook_endpoints_created_idx ON webhook_endpoints (tenant_id, created_at DESC, id DESC);
