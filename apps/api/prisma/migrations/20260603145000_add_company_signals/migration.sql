-- CreateEnum
CREATE TYPE "SignalStatus" AS ENUM ('present', 'absent', 'unknown');

-- CreateEnum
CREATE TYPE "SignalSource" AS ENUM ('connector', 'research', 'feed', 'computed');

-- CreateTable
CREATE TABLE "company_signals" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" "SignalStatus" NOT NULL DEFAULT 'unknown',
    "value" JSONB NOT NULL DEFAULT '{}',
    "citationId" TEXT,
    "source" "SignalSource" NOT NULL,
    "detectedAt" TIMESTAMP(3),
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_signals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_signals_key_status_idx" ON "company_signals"("key", "status");

-- CreateIndex
CREATE UNIQUE INDEX "company_signals_candidateId_key_key" ON "company_signals"("candidateId", "key");

-- AddForeignKey
ALTER TABLE "company_signals" ADD CONSTRAINT "company_signals_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "campaign_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
