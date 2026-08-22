-- DropIndex
DROP INDEX "Claim_projectId_memberId_key";

-- CreateIndex
CREATE INDEX "Claim_projectId_memberId_idx" ON "Claim"("projectId", "memberId");
