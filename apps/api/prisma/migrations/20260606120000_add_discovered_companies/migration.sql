-- Persist the companies discovery surfaced (DiscoveredCompany[]) on a prospect
-- search so the "companies found" step survives a reload. This is the full
-- discovered pool BEFORE qualify drops the low-fit ones, so it can't be
-- reconstructed from the persisted Prospect rows. Nullable: existing rows
-- backfill to NULL (no discovery snapshot, prior behavior).
ALTER TABLE "prospect_searches" ADD COLUMN "discoveredCompanies" JSONB;
