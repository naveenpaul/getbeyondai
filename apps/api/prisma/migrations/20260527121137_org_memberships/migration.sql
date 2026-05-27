-- T8a.1 — Multi-org membership.
--
-- One user can now belong to many organizations. The (userId, orgId) pair
-- holds the role for that org. User.role moves to OrgMembership.role; the
-- old User.orgId is renamed User.activeOrgId — the org the user is acting
-- in right now. AuthGuard verifies a matching OrgMembership exists each
-- request before trusting activeOrgId.

-- CreateTable
CREATE TABLE "org_memberships" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "org_memberships_userId_orgId_key" ON "org_memberships"("userId", "orgId");
CREATE INDEX "org_memberships_orgId_idx" ON "org_memberships"("orgId");

-- AddForeignKey
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing user gets exactly one membership row, role copied
-- from the user. CUID-shaped ids generated server-side via gen_random_uuid()
-- for the SQL backfill; new rows go through Prisma's @default(cuid()).
INSERT INTO "org_memberships" ("id", "userId", "orgId", "role", "createdAt", "updatedAt")
SELECT
  'mbr_' || replace(gen_random_uuid()::text, '-', '') AS "id",
  "id"   AS "userId",
  "orgId" AS "orgId",
  "role" AS "role",
  "createdAt",
  "updatedAt"
FROM "users";

-- Rename users.orgId → users.activeOrgId. (FK + index follow.)
ALTER TABLE "users" RENAME COLUMN "orgId" TO "activeOrgId";

-- Drop the old (orgId, email) unique — meaningless now that email is globally
-- unique and active org can change.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_orgId_email_key";
DROP INDEX IF EXISTS "users_orgId_email_key";

-- Drop the old users.role — role lives on OrgMembership now.
ALTER TABLE "users" DROP COLUMN "role";

-- Replace the old FK name with one that matches the new column name.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_orgId_fkey";
ALTER TABLE "users" ADD CONSTRAINT "users_activeOrgId_fkey"
  FOREIGN KEY ("activeOrgId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
