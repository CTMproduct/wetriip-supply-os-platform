-- DropIndex
DROP INDEX "Promotion_tenantId_code_key";

-- CreateIndex
CREATE INDEX "Promotion_tenantId_code_idx" ON "Promotion"("tenantId", "code");
