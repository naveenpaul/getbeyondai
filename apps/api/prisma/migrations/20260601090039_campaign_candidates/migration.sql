-- CreateTable
CREATE TABLE "campaign_candidates" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "linkedinUrl" TEXT,
    "fitScore" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT NOT NULL,
    "draftId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_candidates_campaignId_idx" ON "campaign_candidates"("campaignId");

-- AddForeignKey
ALTER TABLE "campaign_candidates" ADD CONSTRAINT "campaign_candidates_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
