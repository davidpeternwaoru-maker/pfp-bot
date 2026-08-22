-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('draft', 'live', 'closed');

-- CreateEnum
CREATE TYPE "TraitTier" AS ENUM ('open', 'gated', 'legendary');

-- CreateTable
CREATE TABLE "Project" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "mascotName" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'draft',
    "claimOpensAt" TIMESTAMP(3),
    "claimClosesAt" TIMESTAMP(3),
    "canvasWidth" INTEGER NOT NULL,
    "canvasHeight" INTEGER NOT NULL,
    "telegramGroupId" BIGINT,
    "announceOnClaim" BOOLEAN NOT NULL DEFAULT false,
    "eligibilityRule" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trait" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "slot" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "layerOrder" INTEGER NOT NULL,
    "imagePath" TEXT NOT NULL,
    "rarityWeight" INTEGER NOT NULL DEFAULT 1,
    "tier" "TraitTier" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trait_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Exclusion" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "traitAId" INTEGER NOT NULL,
    "traitBId" INTEGER NOT NULL,

    CONSTRAINT "Exclusion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" SERIAL NOT NULL,
    "telegramUserId" BIGINT NOT NULL,
    "username" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "walletAddress" TEXT,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "memberId" INTEGER NOT NULL,
    "traitIds" INTEGER[],
    "combinationHash" TEXT NOT NULL,
    "editionNumber" INTEGER NOT NULL,
    "tier" "TraitTier" NOT NULL DEFAULT 'open',
    "imagePath" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "mintAddress" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE INDEX "Trait_projectId_slot_idx" ON "Trait"("projectId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "Trait_projectId_slot_name_key" ON "Trait"("projectId", "slot", "name");

-- CreateIndex
CREATE INDEX "Exclusion_projectId_idx" ON "Exclusion"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Exclusion_projectId_traitAId_traitBId_key" ON "Exclusion"("projectId", "traitAId", "traitBId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_telegramUserId_key" ON "Member"("telegramUserId");

-- CreateIndex
CREATE INDEX "Claim_memberId_idx" ON "Claim"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_projectId_combinationHash_key" ON "Claim"("projectId", "combinationHash");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_projectId_memberId_key" ON "Claim"("projectId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_projectId_editionNumber_key" ON "Claim"("projectId", "editionNumber");

-- AddForeignKey
ALTER TABLE "Trait" ADD CONSTRAINT "Trait_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exclusion" ADD CONSTRAINT "Exclusion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exclusion" ADD CONSTRAINT "Exclusion_traitAId_fkey" FOREIGN KEY ("traitAId") REFERENCES "Trait"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exclusion" ADD CONSTRAINT "Exclusion_traitBId_fkey" FOREIGN KEY ("traitBId") REFERENCES "Trait"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
