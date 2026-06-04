-- Persist explicit ICP overrides (IcpCriteriaInput) on a prospect search so a
-- search can be re-run faithfully and detail can report what it used. Nullable:
-- existing rows backfill to NULL (derive-only, prior behavior).
ALTER TABLE "prospect_searches" ADD COLUMN "icpCriteria" JSONB;

-- Per-org tuning for the Stage 5 contact-sourcing waterfall: connector priority
-- + verification threshold. Absence of a row = built-in defaults, so existing
-- orgs are unaffected.

-- CreateEnum
CREATE TYPE "SourcingThreshold" AS ENUM ('verified', 'any');

-- CreateTable
CREATE TABLE "org_sourcing_configs" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "contactPriority" "ConnectorKind"[] DEFAULT ARRAY[]::"ConnectorKind"[],
    "contactThreshold" "SourcingThreshold" NOT NULL DEFAULT 'verified',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_sourcing_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_sourcing_configs_orgId_key" ON "org_sourcing_configs"("orgId");

-- AddForeignKey
ALTER TABLE "org_sourcing_configs" ADD CONSTRAINT "org_sourcing_configs_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
