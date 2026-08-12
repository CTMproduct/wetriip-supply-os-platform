-- CreateEnum
CREATE TYPE "InventoryReleaseStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPLIED', 'FAILED');

-- AlterTable
ALTER TABLE "GroupRequest" ADD COLUMN     "inventoryAppliedAt" TIMESTAMP(3),
ADD COLUMN     "inventoryDetail" JSONB,
ADD COLUMN     "inventoryStatus" "InventoryReleaseStatus" NOT NULL DEFAULT 'NOT_REQUIRED';

-- CreateIndex
CREATE INDEX "GroupRequest_status_inventoryStatus_idx" ON "GroupRequest"("status", "inventoryStatus");
