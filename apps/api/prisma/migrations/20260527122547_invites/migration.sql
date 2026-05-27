-- T8b.1 — Org invites.
--
-- Adds 'admin' to UserRole and the Invite table. No backfill needed — both
-- changes are additive. Existing rows continue with 'owner'/'member'.

-- AlterEnum — Postgres allows ADD VALUE concurrently outside of a transaction;
-- Prisma runs each migration in its own transaction so we use the inside-tx
-- form via `IF NOT EXISTS`. Safe to re-run.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'admin';

-- CreateTable
CREATE TABLE "invites" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'member',
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invites_token_key" ON "invites"("token");
CREATE UNIQUE INDEX "invites_orgId_email_key" ON "invites"("orgId", "email");
CREATE INDEX "invites_email_idx" ON "invites"("email");
CREATE INDEX "invites_orgId_idx" ON "invites"("orgId");

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invites" ADD CONSTRAINT "invites_invitedByUserId_fkey"
  FOREIGN KEY ("invitedByUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invites" ADD CONSTRAINT "invites_acceptedByUserId_fkey"
  FOREIGN KEY ("acceptedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
