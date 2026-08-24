-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('awaiting_payment', 'awaiting_approval', 'approved', 'in_production', 'delivered', 'declined', 'cancelled');

-- CreateEnum
CREATE TYPE "DeclineReason" AS ENUM ('copyrighted_material', 'real_person', 'prohibited_content', 'rival_branding', 'not_producible', 'brief_unclear');

-- CreateTable
CREATE TABLE "CommissionSettings" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "priceUsdcCents" INTEGER NOT NULL DEFAULT 0,
    "treasuryShareBps" INTEGER NOT NULL DEFAULT 0,
    "monthlyCapacity" INTEGER NOT NULL DEFAULT 0,
    "tokenMint" TEXT,
    "tokenMinimum" TEXT,
    "eligibleSlots" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commission" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "memberId" INTEGER NOT NULL,
    "status" "CommissionStatus" NOT NULL DEFAULT 'awaiting_payment',
    "priceUsdcCents" INTEGER NOT NULL,
    "treasuryShareBps" INTEGER NOT NULL,
    "paymentReference" TEXT,
    "paidAt" TIMESTAMP(3),
    "declineReason" "DeclineReason",
    "approvedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "deliveredClaimId" INTEGER,
    "deliveredAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "openOrderKey" TEXT,

    CONSTRAINT "Commission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionBrief" (
    "id" SERIAL NOT NULL,
    "commissionId" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "slot" TEXT NOT NULL,
    "textContent" TEXT,
    "colour" TEXT,
    "referencePath" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionBrief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommissionWaitlist" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "memberId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),

    CONSTRAINT "CommissionWaitlist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommissionSettings_projectId_key" ON "CommissionSettings"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Commission_deliveredClaimId_key" ON "Commission"("deliveredClaimId");

-- CreateIndex
CREATE INDEX "Commission_projectId_status_createdAt_idx" ON "Commission"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Commission_memberId_idx" ON "Commission"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "Commission_projectId_openOrderKey_key" ON "Commission"("projectId", "openOrderKey");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionBrief_commissionId_revision_key" ON "CommissionBrief"("commissionId", "revision");

-- CreateIndex
CREATE INDEX "CommissionWaitlist_projectId_notifiedAt_idx" ON "CommissionWaitlist"("projectId", "notifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommissionWaitlist_projectId_memberId_key" ON "CommissionWaitlist"("projectId", "memberId");

-- AddForeignKey
ALTER TABLE "CommissionSettings" ADD CONSTRAINT "CommissionSettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionBrief" ADD CONSTRAINT "CommissionBrief_commissionId_fkey" FOREIGN KEY ("commissionId") REFERENCES "Commission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionWaitlist" ADD CONSTRAINT "CommissionWaitlist_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionWaitlist" ADD CONSTRAINT "CommissionWaitlist_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

