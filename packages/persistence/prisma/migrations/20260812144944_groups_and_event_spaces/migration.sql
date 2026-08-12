-- CreateEnum
CREATE TYPE "Bedding" AS ENUM ('SINGLE', 'TWIN', 'DOUBLE', 'TRIPLE', 'QUAD');

-- CreateEnum
CREATE TYPE "GroupBlockStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "GroupRequestStatus" AS ENUM ('OPEN', 'COUNTERED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "BidActor" AS ENUM ('AGENCY', 'HOTEL');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'NOT_CONFIGURED');

-- CreateTable
CREATE TABLE "GroupBlock" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fromDate" TEXT NOT NULL,
    "toDate" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "roomsCeiling" INTEGER NOT NULL,
    "releaseDays" INTEGER NOT NULL DEFAULT 30,
    "minRooms" INTEGER NOT NULL DEFAULT 1,
    "status" "GroupBlockStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupBlockLine" (
    "id" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "bedding" "Bedding" NOT NULL,
    "roomsTotal" INTEGER NOT NULL,
    "ratePerNight" DECIMAL(14,2),

    CONSTRAINT "GroupBlockLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "minRoomsForGroup" INTEGER NOT NULL DEFAULT 10,
    "floorRatePerNight" DECIMAL(14,2),
    "floorCurrency" TEXT,
    "autoDeclineBelowFloor" BOOLEAN NOT NULL DEFAULT false,
    "responseWindowHours" INTEGER NOT NULL DEFAULT 24,
    "depositPct" DECIMAL(5,2) NOT NULL DEFAULT 30,
    "cancellationPolicy" TEXT,
    "benefits" JSONB NOT NULL DEFAULT '[]',
    "notifyEmails" TEXT[],
    "notifyWhatsapp" TEXT[],
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "blockId" TEXT,
    "organizationId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "checkIn" TEXT NOT NULL,
    "checkOut" TEXT NOT NULL,
    "pax" INTEGER NOT NULL,
    "rooms" JSONB NOT NULL,
    "budgetTotal" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "inclusions" TEXT[],
    "notes" TEXT,
    "status" "GroupRequestStatus" NOT NULL DEFAULT 'OPEN',
    "currentTotal" DECIMAL(14,2) NOT NULL,
    "currentActor" "BidActor" NOT NULL DEFAULT 'AGENCY',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "settledBy" TEXT,
    "settlement" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupBid" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "actor" "BidActor" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "benefits" JSONB NOT NULL DEFAULT '[]',
    "message" TEXT,
    "evaluation" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupBid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "template" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT,
    "providerRef" TEXT,
    "failureReason" TEXT,
    "requirement" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requestId" TEXT,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventSpace" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "areaM2" DECIMAL(10,2),
    "ceilingHeightM" DECIMAL(5,2),
    "naturalLight" BOOLEAN NOT NULL DEFAULT false,
    "divisible" BOOLEAN NOT NULL DEFAULT false,
    "floor" TEXT,
    "halfDayHours" INTEGER NOT NULL DEFAULT 4,
    "fullDayHours" INTEGER NOT NULL DEFAULT 8,
    "layouts" JSONB NOT NULL DEFAULT '[]',
    "rates" JSONB NOT NULL DEFAULT '[]',
    "addons" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventSpace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GroupBlock_tenantId_propertyId_status_idx" ON "GroupBlock"("tenantId", "propertyId", "status");

-- CreateIndex
CREATE INDEX "GroupBlock_tenantId_fromDate_toDate_idx" ON "GroupBlock"("tenantId", "fromDate", "toDate");

-- CreateIndex
CREATE UNIQUE INDEX "GroupBlock_tenantId_propertyId_code_key" ON "GroupBlock"("tenantId", "propertyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "GroupBlockLine_blockId_roomTypeId_bedding_key" ON "GroupBlockLine"("blockId", "roomTypeId", "bedding");

-- CreateIndex
CREATE UNIQUE INDEX "GroupPolicy_propertyId_key" ON "GroupPolicy"("propertyId");

-- CreateIndex
CREATE INDEX "GroupPolicy_tenantId_idx" ON "GroupPolicy"("tenantId");

-- CreateIndex
CREATE INDEX "GroupRequest_tenantId_propertyId_status_idx" ON "GroupRequest"("tenantId", "propertyId", "status");

-- CreateIndex
CREATE INDEX "GroupRequest_tenantId_organizationId_status_idx" ON "GroupRequest"("tenantId", "organizationId", "status");

-- CreateIndex
CREATE INDEX "GroupRequest_status_expiresAt_idx" ON "GroupRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "GroupBid_requestId_idx" ON "GroupBid"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupBid_requestId_round_key" ON "GroupBid"("requestId", "round");

-- CreateIndex
CREATE INDEX "Notification_tenantId_status_idx" ON "Notification"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Notification_requestId_idx" ON "Notification"("requestId");

-- CreateIndex
CREATE INDEX "EventSpace_tenantId_propertyId_active_idx" ON "EventSpace"("tenantId", "propertyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "EventSpace_tenantId_propertyId_code_key" ON "EventSpace"("tenantId", "propertyId", "code");

-- AddForeignKey
ALTER TABLE "GroupBlockLine" ADD CONSTRAINT "GroupBlockLine_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "GroupBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupRequest" ADD CONSTRAINT "GroupRequest_blockId_fkey" FOREIGN KEY ("blockId") REFERENCES "GroupBlock"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBid" ADD CONSTRAINT "GroupBid_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "GroupRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "GroupRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
