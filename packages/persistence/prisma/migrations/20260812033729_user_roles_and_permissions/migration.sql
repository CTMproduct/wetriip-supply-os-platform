-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'DISABLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'GENERAL_MANAGER';
ALTER TYPE "Role" ADD VALUE 'ECOMMERCE';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "disabledBy" TEXT,
ADD COLUMN     "grants" TEXT[],
ADD COLUMN     "invitedBy" TEXT,
ADD COLUMN     "jobTitle" TEXT,
ADD COLUMN     "lastActiveAt" TIMESTAMP(3),
ADD COLUMN     "propertyIds" TEXT[],
ADD COLUMN     "revokes" TEXT[],
ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "User_organizationId_status_idx" ON "User"("organizationId", "status");
