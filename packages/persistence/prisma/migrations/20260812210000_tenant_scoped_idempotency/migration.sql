-- DropIndex
DROP INDEX "Booking_idempotencyKey_key";

-- CreateIndex
CREATE UNIQUE INDEX "Booking_tenantId_idempotencyKey_key" ON "Booking"("tenantId", "idempotencyKey");

