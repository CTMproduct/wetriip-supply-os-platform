-- CreateEnum
CREATE TYPE "OrgType" AS ENUM ('HOTEL', 'CHAIN', 'DMC', 'WHOLESALER', 'AGENCY', 'OTA', 'CORPORATE', 'TOUR_OPERATOR', 'PLATFORM');

-- CreateEnum
CREATE TYPE "OrgStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PENDING');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('HOTEL_OWNER', 'REVENUE_MANAGER', 'RESERVATION_AGENT', 'FINANCE', 'CONNECTIVITY_ADMIN', 'AGENCY_ADMIN', 'SUPPORT', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "PropertyStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "CatalogSource" AS ENUM ('EXTERNAL', 'MANAGED');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('MOCK_CM', 'CANONICAL_JSON', 'SITEMINDER', 'DINGUS', 'CLOUDBEDS', 'DERBYSOFT');

-- CreateEnum
CREATE TYPE "TransportMode" AS ENUM ('PUSH', 'PULL', 'BOTH');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAUSED', 'ERROR');

-- CreateEnum
CREATE TYPE "MappingStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "MappedEntity" AS ENUM ('PROPERTY', 'ROOM_TYPE', 'RATE_PLAN');

-- CreateEnum
CREATE TYPE "EnvelopeOutcome" AS ENUM ('ACCEPTED', 'PARTIAL', 'REJECTED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "AriLayer" AS ENUM ('EXTERNAL', 'MANAGED');

-- CreateEnum
CREATE TYPE "AriEventType" AS ENUM ('RATE_UPDATED', 'AVAILABILITY_UPDATED', 'RESTRICTION_UPDATED', 'FULL_SYNC');

-- CreateEnum
CREATE TYPE "AriEventStatus" AS ENUM ('ACCEPTED', 'REJECTED', 'DUPLICATE', 'OUT_OF_ORDER');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'SUSPENDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentModel" AS ENUM ('NET', 'COMMISSION', 'PREPAID');

-- CreateEnum
CREATE TYPE "PromotionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('DRAFT', 'PENDING', 'UNKNOWN', 'CONFIRMED', 'REJECTED', 'CANCEL_PENDING', 'CANCELLED', 'MANUAL_REVIEW');

-- CreateEnum
CREATE TYPE "AgentChannel" AS ENUM ('VOICE', 'CHAT', 'API');

-- CreateEnum
CREATE TYPE "AgentActionStatus" AS ENUM ('PROPOSED', 'AWAITING_CONFIRMATION', 'APPROVED', 'REJECTED', 'EXECUTING', 'EXECUTED', 'FAILED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ReconStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "type" "OrgType" NOT NULL,
    "country" TEXT NOT NULL,
    "defaultCurrency" TEXT NOT NULL DEFAULT 'USD',
    "defaultCommissionPct" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "status" "OrgStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "maxAutonomy" INTEGER NOT NULL DEFAULT 2,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Property" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Bogota',
    "currency" TEXT NOT NULL DEFAULT 'COP',
    "stars" INTEGER,
    "status" "PropertyStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomType" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "maxOccupancy" INTEGER NOT NULL DEFAULT 2,
    "maxAdults" INTEGER NOT NULL DEFAULT 2,
    "maxChildren" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RoomType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RatePlan" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mealPlan" TEXT NOT NULL DEFAULT 'RO',
    "currency" TEXT NOT NULL,
    "source" "CatalogSource" NOT NULL DEFAULT 'EXTERNAL',
    "refundable" BOOLEAN NOT NULL DEFAULT true,
    "cancellationDsl" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RatePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxRule" (
    "id" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "value" DECIMAL(12,4) NOT NULL,
    "currency" TEXT,
    "included" BOOLEAN NOT NULL DEFAULT false,
    "appliesTo" TEXT NOT NULL DEFAULT 'ALL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "provider" "Provider" NOT NULL,
    "displayName" TEXT NOT NULL,
    "mode" "TransportMode" NOT NULL DEFAULT 'BOTH',
    "status" "ConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "credentialsRef" TEXT,
    "webhookSecret" TEXT,
    "checkpoint" JSONB,
    "lastHealthAt" TIMESTAMP(3),
    "lastHealthOk" BOOLEAN,
    "lastHealthDetail" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MappingVersion" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "MappingStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "createdBy" TEXT,
    "approvedBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MappingVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MappingEntry" (
    "id" TEXT NOT NULL,
    "mappingVersionId" TEXT NOT NULL,
    "entityType" "MappedEntity" NOT NULL,
    "remoteCode" TEXT NOT NULL,
    "remoteName" TEXT,
    "localPropertyId" TEXT,
    "localRoomTypeId" TEXT,
    "localRatePlanId" TEXT,

    CONSTRAINT "MappingEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawEnvelope" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'INBOUND',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "correlationId" TEXT NOT NULL,
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "outcome" "EnvelopeOutcome" NOT NULL DEFAULT 'ACCEPTED',
    "rejectReason" TEXT,
    "eventCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RawEnvelope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AriEvent" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "ratePlanId" TEXT NOT NULL,
    "stayDate" DATE NOT NULL,
    "occupancy" INTEGER NOT NULL DEFAULT 2,
    "layer" "AriLayer" NOT NULL,
    "eventType" "AriEventType" NOT NULL,
    "source" TEXT NOT NULL,
    "sourceSequence" BIGINT,
    "before" JSONB,
    "after" JSONB NOT NULL,
    "sourceTimestamp" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "payloadHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "mappingVersion" INTEGER,
    "rawEnvelopeId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'CONNECTOR',
    "actorId" TEXT,
    "reason" TEXT,
    "status" "AriEventStatus" NOT NULL DEFAULT 'ACCEPTED',
    "rejectReason" TEXT,

    CONSTRAINT "AriEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AriCell" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "ratePlanId" TEXT NOT NULL,
    "stayDate" DATE NOT NULL,
    "occupancy" INTEGER NOT NULL DEFAULT 2,
    "layer" "AriLayer" NOT NULL,
    "allotment" INTEGER,
    "available" INTEGER,
    "sold" INTEGER,
    "overbookingLimit" INTEGER,
    "currency" TEXT,
    "baseAmount" DECIMAL(14,4),
    "adultPrices" JSONB,
    "childPrices" JSONB,
    "open" BOOLEAN,
    "stopSell" BOOLEAN,
    "closedToArrival" BOOLEAN,
    "closedToDeparture" BOOLEAN,
    "minLos" INTEGER,
    "maxLos" INTEGER,
    "releaseDays" INTEGER,
    "bookingGap" INTEGER,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "reason" TEXT,
    "approvedBy" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL,
    "sourceTimestamp" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEventId" BIGINT,
    "mappingVersion" INTEGER,

    CONSTRAINT "AriCell_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EffectiveAri" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "ratePlanId" TEXT NOT NULL,
    "stayDate" DATE NOT NULL,
    "occupancy" INTEGER NOT NULL DEFAULT 2,
    "currency" TEXT,
    "baseAmount" DECIMAL(14,4),
    "available" INTEGER NOT NULL DEFAULT 0,
    "open" BOOLEAN NOT NULL DEFAULT false,
    "closedToArrival" BOOLEAN NOT NULL DEFAULT false,
    "closedToDeparture" BOOLEAN NOT NULL DEFAULT false,
    "minLos" INTEGER NOT NULL DEFAULT 1,
    "maxLos" INTEGER,
    "releaseDays" INTEGER NOT NULL DEFAULT 0,
    "bookingGap" INTEGER NOT NULL DEFAULT 0,
    "freshnessSeconds" INTEGER NOT NULL DEFAULT 0,
    "stale" BOOLEAN NOT NULL DEFAULT true,
    "explanation" JSONB NOT NULL,
    "externalVersion" INTEGER NOT NULL DEFAULT 0,
    "managedVersion" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EffectiveAri_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "supplierOrgId" TEXT NOT NULL,
    "buyerOrgId" TEXT NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL,
    "paymentModel" "PaymentModel" NOT NULL DEFAULT 'COMMISSION',
    "commissionPct" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "markupPct" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "creditLimit" DECIMAL(14,2),
    "markets" TEXT[],
    "channels" TEXT[],
    "propertyIds" TEXT[],
    "cancellationPolicy" JSONB,
    "promotionPermissions" JSONB,
    "distributionPermissions" JSONB,
    "maxResaleDepth" INTEGER NOT NULL DEFAULT 2,
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractVersion" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "PromotionStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "definition" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionVersion" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "status" "PromotionStatus" NOT NULL,
    "reason" TEXT,
    "supersedesVersion" INTEGER,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "buyerOrgId" TEXT NOT NULL,
    "destination" TEXT,
    "propertyIds" TEXT[],
    "checkIn" DATE NOT NULL,
    "checkOut" DATE NOT NULL,
    "rooms" INTEGER NOT NULL DEFAULT 1,
    "adults" INTEGER NOT NULL DEFAULT 2,
    "children" INTEGER NOT NULL DEFAULT 0,
    "market" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "searchId" TEXT NOT NULL,
    "buyerOrgId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "ratePlanId" TEXT NOT NULL,
    "checkIn" DATE NOT NULL,
    "checkOut" DATE NOT NULL,
    "nights" INTEGER NOT NULL,
    "adults" INTEGER NOT NULL,
    "children" INTEGER NOT NULL,
    "supplierCurrency" TEXT NOT NULL,
    "supplierAmount" DECIMAL(14,4) NOT NULL,
    "normalizedCurrency" TEXT NOT NULL,
    "normalizedAmount" DECIMAL(14,4) NOT NULL,
    "fxRate" DECIMAL(18,8) NOT NULL,
    "fxSource" TEXT NOT NULL,
    "fxTimestamp" TIMESTAMP(3) NOT NULL,
    "buyerCurrency" TEXT NOT NULL,
    "buyerAmount" DECIMAL(14,4) NOT NULL,
    "netAmount" DECIMAL(14,4) NOT NULL,
    "taxAmount" DECIMAL(14,4) NOT NULL,
    "feeAmount" DECIMAL(14,4) NOT NULL,
    "commissionAmount" DECIMAL(14,4) NOT NULL,
    "grossAmount" DECIMAL(14,4) NOT NULL,
    "promotionIds" TEXT[],
    "contractId" TEXT,
    "mealPlan" TEXT NOT NULL DEFAULT 'RO',
    "cancellation" JSONB,
    "provenance" JSONB NOT NULL,
    "explanation" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "buyerOrgId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "offerId" TEXT,
    "status" "BookingStatus" NOT NULL DEFAULT 'DRAFT',
    "checkIn" DATE NOT NULL,
    "checkOut" DATE NOT NULL,
    "nights" INTEGER NOT NULL,
    "adults" INTEGER NOT NULL,
    "children" INTEGER NOT NULL,
    "guestName" TEXT NOT NULL,
    "guestEmail" TEXT,
    "guestPhone" TEXT,
    "amount" DECIMAL(14,4) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "supplierReference" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "timeline" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingAttempt" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "operation" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "response" JSONB,
    "outcome" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "AgentChannel" NOT NULL DEFAULT 'CHAT',
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentAction" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "modelId" TEXT,
    "deterministicIntent" BOOLEAN NOT NULL DEFAULT false,
    "utterance" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "command" JSONB NOT NULL,
    "policyDecision" JSONB,
    "simulation" JSONB,
    "status" "AgentActionStatus" NOT NULL DEFAULT 'PROPOSED',
    "autonomyLevel" INTEGER NOT NULL DEFAULT 1,
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "requiresStepUp" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "confirmedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "executedAt" TIMESTAMP(3),
    "result" JSONB,
    "error" TEXT,
    "rollbackOfId" TEXT,
    "rolledBackById" TEXT,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "organizationId" TEXT,
    "propertyId" TEXT,
    "name" TEXT NOT NULL,
    "goal" JSONB NOT NULL,
    "constraints" JSONB NOT NULL,
    "autonomy" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "correlationId" TEXT NOT NULL,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" BIGSERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT,
    "scope" JSONB NOT NULL,
    "status" "ReconStatus" NOT NULL DEFAULT 'RUNNING',
    "compared" INTEGER NOT NULL DEFAULT 0,
    "divergences" INTEGER NOT NULL DEFAULT 0,
    "report" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Divergence" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" JSONB NOT NULL,
    "sourceValue" JSONB,
    "ledgerValue" JSONB,
    "effectiveValue" JSONB,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Divergence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_code_key" ON "Tenant"("code");

-- CreateIndex
CREATE INDEX "Organization_tenantId_type_idx" ON "Organization"("tenantId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_tenantId_code_key" ON "Organization"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_email_key" ON "User"("tenantId", "email");

-- CreateIndex
CREATE INDEX "Property_tenantId_status_idx" ON "Property"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Property_tenantId_code_key" ON "Property"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "RoomType_propertyId_code_key" ON "RoomType"("propertyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "RatePlan_propertyId_code_key" ON "RatePlan"("propertyId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "TaxRule_propertyId_code_key" ON "TaxRule"("propertyId", "code");

-- CreateIndex
CREATE INDEX "Connection_tenantId_status_idx" ON "Connection"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Connection_propertyId_idx" ON "Connection"("propertyId");

-- CreateIndex
CREATE INDEX "MappingVersion_connectionId_status_idx" ON "MappingVersion"("connectionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MappingVersion_connectionId_version_key" ON "MappingVersion"("connectionId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "MappingEntry_mappingVersionId_entityType_remoteCode_key" ON "MappingEntry"("mappingVersionId", "entityType", "remoteCode");

-- CreateIndex
CREATE INDEX "RawEnvelope_connectionId_receivedAt_idx" ON "RawEnvelope"("connectionId", "receivedAt");

-- CreateIndex
CREATE INDEX "RawEnvelope_correlationId_idx" ON "RawEnvelope"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "AriEvent_idempotencyKey_key" ON "AriEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AriEvent_tenantId_propertyId_stayDate_idx" ON "AriEvent"("tenantId", "propertyId", "stayDate");

-- CreateIndex
CREATE INDEX "AriEvent_propertyId_roomTypeId_ratePlanId_stayDate_layer_idx" ON "AriEvent"("propertyId", "roomTypeId", "ratePlanId", "stayDate", "layer");

-- CreateIndex
CREATE INDEX "AriEvent_correlationId_idx" ON "AriEvent"("correlationId");

-- CreateIndex
CREATE INDEX "AriEvent_receivedAt_idx" ON "AriEvent"("receivedAt");

-- CreateIndex
CREATE INDEX "AriCell_propertyId_stayDate_idx" ON "AriCell"("propertyId", "stayDate");

-- CreateIndex
CREATE UNIQUE INDEX "AriCell_tenantId_propertyId_roomTypeId_ratePlanId_stayDate__key" ON "AriCell"("tenantId", "propertyId", "roomTypeId", "ratePlanId", "stayDate", "occupancy", "layer");

-- CreateIndex
CREATE INDEX "EffectiveAri_propertyId_stayDate_idx" ON "EffectiveAri"("propertyId", "stayDate");

-- CreateIndex
CREATE INDEX "EffectiveAri_tenantId_stale_idx" ON "EffectiveAri"("tenantId", "stale");

-- CreateIndex
CREATE UNIQUE INDEX "EffectiveAri_tenantId_propertyId_roomTypeId_ratePlanId_stay_key" ON "EffectiveAri"("tenantId", "propertyId", "roomTypeId", "ratePlanId", "stayDate", "occupancy");

-- CreateIndex
CREATE INDEX "Contract_tenantId_status_idx" ON "Contract"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Contract_buyerOrgId_status_idx" ON "Contract"("buyerOrgId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Contract_tenantId_code_key" ON "Contract"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ContractVersion_contractId_version_key" ON "ContractVersion"("contractId", "version");

-- CreateIndex
CREATE INDEX "Promotion_propertyId_status_idx" ON "Promotion"("propertyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Promotion_tenantId_code_key" ON "Promotion"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionVersion_promotionId_version_key" ON "PromotionVersion"("promotionId", "version");

-- CreateIndex
CREATE INDEX "SearchRequest_tenantId_createdAt_idx" ON "SearchRequest"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Offer_tenantId_expiresAt_idx" ON "Offer"("tenantId", "expiresAt");

-- CreateIndex
CREATE INDEX "Offer_searchId_idx" ON "Offer"("searchId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_reference_key" ON "Booking"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_idempotencyKey_key" ON "Booking"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Booking_tenantId_status_idx" ON "Booking"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Booking_propertyId_checkIn_idx" ON "Booking"("propertyId", "checkIn");

-- CreateIndex
CREATE UNIQUE INDEX "BookingAttempt_bookingId_operation_attemptNo_key" ON "BookingAttempt"("bookingId", "operation", "attemptNo");

-- CreateIndex
CREATE INDEX "AgentAction_tenantId_status_idx" ON "AgentAction"("tenantId", "status");

-- CreateIndex
CREATE INDEX "AgentAction_tenantId_createdAt_idx" ON "AgentAction"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentAction_correlationId_idx" ON "AgentAction"("correlationId");

-- CreateIndex
CREATE INDEX "AgentPolicy_tenantId_active_idx" ON "AgentPolicy"("tenantId", "active");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_scope_status_idx" ON "IdempotencyRecord"("scope", "status");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_resourceType_resourceId_idx" ON "AuditEvent"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "AuditEvent_correlationId_idx" ON "AuditEvent"("correlationId");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_idx" ON "OutboxEvent"("publishedAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_tenantId_type_idx" ON "OutboxEvent"("tenantId", "type");

-- CreateIndex
CREATE INDEX "ReconciliationRun_tenantId_startedAt_idx" ON "ReconciliationRun"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "Divergence_runId_status_idx" ON "Divergence"("runId", "status");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomType" ADD CONSTRAINT "RoomType_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RatePlan" ADD CONSTRAINT "RatePlan_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRule" ADD CONSTRAINT "TaxRule_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MappingVersion" ADD CONSTRAINT "MappingVersion_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MappingEntry" ADD CONSTRAINT "MappingEntry_mappingVersionId_fkey" FOREIGN KEY ("mappingVersionId") REFERENCES "MappingVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawEnvelope" ADD CONSTRAINT "RawEnvelope_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_supplierOrgId_fkey" FOREIGN KEY ("supplierOrgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_buyerOrgId_fkey" FOREIGN KEY ("buyerOrgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractVersion" ADD CONSTRAINT "ContractVersion_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionVersion" ADD CONSTRAINT "PromotionVersion_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "SearchRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAttempt" ADD CONSTRAINT "BookingAttempt_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Divergence" ADD CONSTRAINT "Divergence_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
