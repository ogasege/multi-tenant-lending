-- =====================================================================================
-- V5__checkout_order_single_use.sql
--
-- A supplier order (checkout on the procurement platform) is financed at most once per
-- lender: at most one live loan application per (tenant, external_order_reference).
-- Without this, two concurrent checkouts of the same order could each pass an
-- application-level "already financed?" check and both be approved and disbursed.
--
-- Terminal, non-financing outcomes (REJECTED, WITHDRAWN, EXPIRED) drop out of the index,
-- which frees the order for a new attempt. Every other status (SUBMITTED, ASSESSED,
-- APPROVED) holds the order. Applications without an order reference are not affected.
-- The index leads with tenant_id, so different lenders may finance the same order
-- reference independently. A violation surfaces as SQLSTATE 23505 (unique_violation)
-- on this index name; the API maps it to 409 Conflict.
--
-- Plain CREATE INDEX (not CONCURRENTLY): Flyway runs each migration in a transaction and
-- the table is still small (see V4).
-- =====================================================================================

CREATE UNIQUE INDEX loan_applications_order_once
  ON public.loan_applications (tenant_id, external_order_reference)
  WHERE external_order_reference IS NOT NULL
    AND status NOT IN ('REJECTED', 'WITHDRAWN', 'EXPIRED');
