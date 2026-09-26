-- AlterTable
ALTER TABLE "Membership" ADD COLUMN "extraPermissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
