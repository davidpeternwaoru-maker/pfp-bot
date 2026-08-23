-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "walletLinkedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WalletChallenge" (
    "id" SERIAL NOT NULL,
    "memberId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletChallenge_token_key" ON "WalletChallenge"("token");

-- CreateIndex
CREATE INDEX "WalletChallenge_memberId_createdAt_idx" ON "WalletChallenge"("memberId", "createdAt");

-- CreateIndex
CREATE INDEX "WalletChallenge_expiresAt_idx" ON "WalletChallenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Member_walletAddress_key" ON "Member"("walletAddress");

-- AddForeignKey
ALTER TABLE "WalletChallenge" ADD CONSTRAINT "WalletChallenge_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

