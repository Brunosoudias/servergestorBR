-- AlterEnum
ALTER TYPE "TokenType" ADD VALUE 'mfa_challenge';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "mfaSecretEnc" TEXT,
ADD COLUMN "mfaEnabledAt" TIMESTAMP(3),
ADD COLUMN "mfaLastStep" INTEGER NOT NULL DEFAULT 0;
