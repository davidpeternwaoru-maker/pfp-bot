-- Restores one-open-claim-per-member, which the previous migration removed
-- when it dropped the blanket unique index.
--
-- The scoping is carried by a nullable marker column rather than a partial
-- index. Postgres treats nulls as distinct in a unique index, so a member may
-- hold any number of awarded claims (marker null) but only one open claim
-- (marker = memberId). A partial index would express the same thing more
-- directly, but it cannot be written in schema.prisma, so it would survive
-- only as raw SQL that `prisma migrate dev` regenerates away — which is
-- exactly what happened, leaving the table with no enforcement at all.

-- AddColumn
ALTER TABLE "Claim" ADD COLUMN "openClaimMemberId" INTEGER;

-- Backfill before the index exists, so existing open claims are covered.
UPDATE "Claim" SET "openClaimMemberId" = "memberId" WHERE "tier" = 'open'::"TraitTier";

-- CreateIndex
CREATE UNIQUE INDEX "Claim_projectId_openClaimMemberId_key"
  ON "Claim"("projectId", "openClaimMemberId");
