-- AlterTable
ALTER TABLE "AgentSession" ADD COLUMN     "title" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "proposalIds" TEXT[],
    "modelId" TEXT,
    "deterministic" BOOLEAN NOT NULL DEFAULT true,
    "correlationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentMessage_sessionId_createdAt_idx" ON "AgentMessage"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentMessage_tenantId_createdAt_idx" ON "AgentMessage"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentSession_tenantId_userId_updatedAt_idx" ON "AgentSession"("tenantId", "userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "AgentMessage" ADD CONSTRAINT "AgentMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
