-- CreateTable
CREATE TABLE "campaign_candidate_contacts" (
    "id" TEXT NOT NULL,
    "campaignCandidateId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "sourceKind" "ConnectorKind" NOT NULL,
    "emailVerification" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_candidate_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_candidate_contacts_contactId_idx" ON "campaign_candidate_contacts"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_candidate_contacts_campaignCandidateId_contactId_key" ON "campaign_candidate_contacts"("campaignCandidateId", "contactId");

-- AddForeignKey
ALTER TABLE "campaign_candidate_contacts" ADD CONSTRAINT "campaign_candidate_contacts_campaignCandidateId_fkey" FOREIGN KEY ("campaignCandidateId") REFERENCES "campaign_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_candidate_contacts" ADD CONSTRAINT "campaign_candidate_contacts_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
