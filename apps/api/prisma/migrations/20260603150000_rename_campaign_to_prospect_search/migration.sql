-- Rename Campaign → ProspectSearch / CampaignCandidate → Prospect /
-- CampaignCandidateContact → ProspectContact.
--
-- DATA-PRESERVING: this RENAMEs tables/columns/constraints/indexes in place.
-- Prisma's default for a changed @@map is DROP + CREATE, which would destroy
-- every row — this file is hand-authored; do NOT regenerate it. Constraint and
-- index names are renamed to the names Prisma derives from the new table names
-- so future `migrate dev` runs see no drift.

-- ── Enum type ────────────────────────────────────────────────────────────────
ALTER TYPE "CampaignStatus" RENAME TO "ProspectSearchStatus";

-- ── Tables ───────────────────────────────────────────────────────────────────
ALTER TABLE "campaigns" RENAME TO "prospect_searches";
ALTER TABLE "campaign_candidates" RENAME TO "prospects";
ALTER TABLE "campaign_candidate_contacts" RENAME TO "prospect_contacts";

-- ── Columns ──────────────────────────────────────────────────────────────────
ALTER TABLE "prospects" RENAME COLUMN "campaignId" TO "prospectSearchId";
ALTER TABLE "prospect_contacts" RENAME COLUMN "campaignCandidateId" TO "prospectId";
ALTER TABLE "company_signals" RENAME COLUMN "candidateId" TO "prospectId";

-- ── Primary-key constraints (index renamed with the constraint) ──────────────
ALTER TABLE "prospect_searches" RENAME CONSTRAINT "campaigns_pkey" TO "prospect_searches_pkey";
ALTER TABLE "prospects" RENAME CONSTRAINT "campaign_candidates_pkey" TO "prospects_pkey";
ALTER TABLE "prospect_contacts" RENAME CONSTRAINT "campaign_candidate_contacts_pkey" TO "prospect_contacts_pkey";

-- ── Foreign-key constraints ──────────────────────────────────────────────────
ALTER TABLE "prospect_searches" RENAME CONSTRAINT "campaigns_orgId_fkey" TO "prospect_searches_orgId_fkey";
ALTER TABLE "prospects" RENAME CONSTRAINT "campaign_candidates_campaignId_fkey" TO "prospects_prospectSearchId_fkey";
ALTER TABLE "prospect_contacts" RENAME CONSTRAINT "campaign_candidate_contacts_campaignCandidateId_fkey" TO "prospect_contacts_prospectId_fkey";
ALTER TABLE "prospect_contacts" RENAME CONSTRAINT "campaign_candidate_contacts_contactId_fkey" TO "prospect_contacts_contactId_fkey";
ALTER TABLE "company_signals" RENAME CONSTRAINT "company_signals_candidateId_fkey" TO "company_signals_prospectId_fkey";

-- ── Indexes (plain @@index + @@unique unique indexes) ────────────────────────
ALTER INDEX "campaigns_orgId_status_idx" RENAME TO "prospect_searches_orgId_status_idx";
ALTER INDEX "campaign_candidates_campaignId_idx" RENAME TO "prospects_prospectSearchId_idx";
ALTER INDEX "campaign_candidate_contacts_contactId_idx" RENAME TO "prospect_contacts_contactId_idx";
ALTER INDEX "campaign_candidate_contacts_campaignCandidateId_contactId_key" RENAME TO "prospect_contacts_prospectId_contactId_key";
ALTER INDEX "company_signals_candidateId_key_key" RENAME TO "company_signals_prospectId_key_key";

-- ── Persisted LLM routing slug for the orchestrator teammate ─────────────────
-- The teammate routing key was 'campaign-orchestrator'; rename it in place so
-- saved per-org routing (org_teammate_configs) is preserved, not orphaned.
UPDATE "org_teammate_configs" SET "teammate" = 'prospect-search-orchestrator' WHERE "teammate" = 'campaign-orchestrator';
