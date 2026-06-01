-- Persist the campaign run configuration so a campaign can be re-run faithfully.
-- Previously `sourcing` (candidate pool) and `budgetCents` lived only in the
-- pg-boss job payload, leaving no DB record of what a campaign actually used.
-- Both are nullable: existing rows backfill to NULL (no source / default budget).
ALTER TABLE "campaigns" ADD COLUMN "sourcing" JSONB;
ALTER TABLE "campaigns" ADD COLUMN "budgetCents" INTEGER;
