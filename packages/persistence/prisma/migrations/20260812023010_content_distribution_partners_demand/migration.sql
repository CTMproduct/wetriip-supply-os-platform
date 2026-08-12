-- CreateEnum
CREATE TYPE "ContentLayer" AS ENUM ('EXTERNAL', 'MANAGED');

-- CreateEnum
CREATE TYPE "ContentSourceKind" AS ENUM ('MANUAL', 'CANONICAL_JSON', 'BOOKING', 'EXPEDIA', 'GIATA', 'GIMMONIX', 'CHANNEL_MANAGER');

-- CreateEnum
CREATE TYPE "ImageCategory" AS ENUM ('EXTERIOR', 'LOBBY', 'ROOM', 'BATHROOM', 'RESTAURANT', 'POOL', 'SPA', 'MEETING', 'BEACH', 'VIEW', 'OTHER');

-- CreateEnum
CREATE TYPE "DistributionMode" AS ENUM ('MARKETPLACE_OPEN', 'SELECTED_PARTNERS', 'CLOSED');

-- CreateEnum
CREATE TYPE "PartnerStatus" AS ENUM ('PENDING', 'ACTIVE', 'ON_HOLD', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PaymentTerms" AS ENUM ('PREPAY', 'NET_7', 'NET_15', 'NET_30', 'NET_45', 'NET_60', 'ON_ARRIVAL');

-- CreateEnum
CREATE TYPE "CreditEntryType" AS ENUM ('HOLD', 'RELEASE', 'CHARGE', 'PAYMENT', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "PropertyContent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "layer" "ContentLayer" NOT NULL,
    "source" "ContentSourceKind" NOT NULL DEFAULT 'MANUAL',
    "locale" TEXT NOT NULL DEFAULT 'es',
    "descriptionShort" TEXT,
    "descriptionLong" TEXT,
    "highlights" TEXT[],
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "postalCode" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "checkInFrom" TEXT,
    "checkInTo" TEXT,
    "checkOutBy" TEXT,
    "amenities" TEXT[],
    "policies" JSONB,
    "raw" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sourceReference" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PropertyContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PropertyImage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "roomTypeId" TEXT,
    "layer" "ContentLayer" NOT NULL DEFAULT 'MANAGED',
    "source" "ContentSourceKind" NOT NULL DEFAULT 'MANUAL',
    "url" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "caption" TEXT,
    "category" "ImageCategory" NOT NULL DEFAULT 'OTHER',
    "width" INTEGER,
    "height" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isHero" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "credit" TEXT,
    "licence" TEXT,
    "sourceReference" TEXT,
    "checksum" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PropertyImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentSource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "kind" "ContentSourceKind" NOT NULL,
    "displayName" TEXT NOT NULL,
    "credentialsRef" TEXT,
    "externalId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncOk" BOOLEAN,
    "lastSyncDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DistributionPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "mode" "DistributionMode" NOT NULL DEFAULT 'MARKETPLACE_OPEN',
    "allowedMarkets" TEXT[],
    "blockedMarkets" TEXT[],
    "allowedPartnerIds" TEXT[],
    "blockedPartnerIds" TEXT[],
    "allowedPartnerTypes" TEXT[],
    "allowedChannels" TEXT[],
    "minAdvanceDays" INTEGER,
    "maxAdvanceDays" INTEGER,
    "minLos" INTEGER,
    "floorRate" DECIMAL(14,4),
    "floorCurrency" TEXT,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "updatedBy" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DistributionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "partnerCode" TEXT NOT NULL,
    "status" "PartnerStatus" NOT NULL DEFAULT 'PENDING',
    "legalName" TEXT NOT NULL,
    "taxIdScheme" TEXT,
    "taxId" TEXT,
    "taxCountry" TEXT,
    "billingEmail" TEXT,
    "billingAddress" TEXT,
    "billingCity" TEXT,
    "billingCountry" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "sourceMarkets" TEXT[],
    "iataCode" TEXT,
    "memberships" TEXT[],
    "paymentTerms" "PaymentTerms" NOT NULL DEFAULT 'PREPAY',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "creditLimit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "creditUsed" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "creditWarningPct" INTEGER NOT NULL DEFAULT 80,
    "onboardedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "type" "CreditEntryType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "balanceAfter" DECIMAL(14,2) NOT NULL,
    "bookingId" TEXT,
    "reference" TEXT,
    "reason" TEXT,
    "actorId" TEXT,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchImpression" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "searchId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "buyerOrgId" TEXT NOT NULL,
    "sourceMarket" TEXT NOT NULL,
    "destinationCountry" TEXT NOT NULL,
    "destinationCity" TEXT NOT NULL,
    "checkIn" DATE NOT NULL,
    "nights" INTEGER NOT NULL,
    "adults" INTEGER NOT NULL,
    "rooms" INTEGER NOT NULL,
    "offered" BOOLEAN NOT NULL DEFAULT false,
    "offerCount" INTEGER NOT NULL DEFAULT 0,
    "lowestRate" DECIMAL(14,4),
    "currency" TEXT,
    "blockedBy" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchImpression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PropertyContent_tenantId_propertyId_idx" ON "PropertyContent"("tenantId", "propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "PropertyContent_propertyId_layer_locale_key" ON "PropertyContent"("propertyId", "layer", "locale");

-- CreateIndex
CREATE INDEX "PropertyImage_propertyId_category_position_idx" ON "PropertyImage"("propertyId", "category", "position");

-- CreateIndex
CREATE INDEX "PropertyImage_tenantId_propertyId_idx" ON "PropertyImage"("tenantId", "propertyId");

-- CreateIndex
CREATE INDEX "ContentSource_tenantId_enabled_idx" ON "ContentSource"("tenantId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "ContentSource_propertyId_kind_key" ON "ContentSource"("propertyId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "DistributionPolicy_propertyId_key" ON "DistributionPolicy"("propertyId");

-- CreateIndex
CREATE INDEX "DistributionPolicy_tenantId_mode_idx" ON "DistributionPolicy"("tenantId", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerProfile_organizationId_key" ON "PartnerProfile"("organizationId");

-- CreateIndex
CREATE INDEX "PartnerProfile_tenantId_status_idx" ON "PartnerProfile"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerProfile_tenantId_partnerCode_key" ON "PartnerProfile"("tenantId", "partnerCode");

-- CreateIndex
CREATE INDEX "CreditEntry_partnerId_createdAt_idx" ON "CreditEntry"("partnerId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditEntry_tenantId_bookingId_idx" ON "CreditEntry"("tenantId", "bookingId");

-- CreateIndex
CREATE INDEX "SearchImpression_tenantId_propertyId_createdAt_idx" ON "SearchImpression"("tenantId", "propertyId", "createdAt");

-- CreateIndex
CREATE INDEX "SearchImpression_tenantId_buyerOrgId_createdAt_idx" ON "SearchImpression"("tenantId", "buyerOrgId", "createdAt");

-- CreateIndex
CREATE INDEX "SearchImpression_tenantId_sourceMarket_destinationCountry_c_idx" ON "SearchImpression"("tenantId", "sourceMarket", "destinationCountry", "createdAt");

-- AddForeignKey
ALTER TABLE "PropertyContent" ADD CONSTRAINT "PropertyContent_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PropertyImage" ADD CONSTRAINT "PropertyImage_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentSource" ADD CONSTRAINT "ContentSource_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributionPolicy" ADD CONSTRAINT "DistributionPolicy_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerProfile" ADD CONSTRAINT "PartnerProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditEntry" ADD CONSTRAINT "CreditEntry_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "PartnerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
