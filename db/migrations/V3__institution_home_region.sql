-- =====================================================================================
-- V3__institution_home_region.sql
--
-- Cell-based data residency (SPEC §4.1). Each institution is pinned to the cell (AWS
-- region) that satisfies its regulator, e.g. af-south-1 for Nigerian lenders under the CBN
-- localisation rules. All of a tenant's data lives only in that cell; the API refuses to
-- register an institution whose home_region differs from the cell's own region, and the
-- value is never changed in place (moving a tenant is a planned data migration).
--
-- The DEFAULT exists only to backfill rows that predate this column (all of them in the
-- af-south-1 cell, the only one built so far). It is dropped straight away, so every new
-- institution must state its home region explicitly; a silent default would be exactly
-- the kind of residency mistake this column exists to prevent.
-- =====================================================================================

ALTER TABLE institutions
  ADD COLUMN home_region text NOT NULL DEFAULT 'af-south-1'
    CHECK (home_region ~ '^[a-z]{2}-[a-z]+-[0-9]$');

ALTER TABLE institutions ALTER COLUMN home_region DROP DEFAULT;
