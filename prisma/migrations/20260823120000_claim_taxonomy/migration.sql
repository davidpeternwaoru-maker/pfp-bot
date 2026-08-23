-- CreateEnum
CREATE TYPE "ClaimType" AS ENUM ('open', 'bespoke', 'custom');

-- DropIndex
DROP INDEX "Claim_projectId_openClaimMemberId_key";

-- AlterTable
ALTER TABLE "Claim" DROP COLUMN "openClaimMemberId",
ADD COLUMN     "claimType" "ClaimType" NOT NULL DEFAULT 'open',
ADD COLUMN     "memberSlotKey" TEXT,
ADD COLUMN     "transferable" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE UNIQUE INDEX "Claim_projectId_memberSlotKey_key" ON "Claim"("projectId", "memberSlotKey");

