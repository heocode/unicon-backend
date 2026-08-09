-- CreateEnum
CREATE TYPE "SecurityEventType" AS ENUM (
  'LOGIN_SUCCEEDED',
  'LOGIN_FAILED',
  'SESSION_CREATED',
  'SESSION_CREATION_FAILED',
  'SESSION_REVOKED',
  'OTHER_SESSIONS_REVOKED'
);

-- CreateEnum
CREATE TYPE "SecurityEventReason" AS ENUM (
  'INVALID_CREDENTIALS',
  'ACTIVE_SESSION_LIMIT_REACHED',
  'LOGOUT',
  'SESSION_MANAGEMENT'
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
  "id" TEXT NOT NULL,
  "type" "SecurityEventType" NOT NULL,
  "reason" "SecurityEventReason",
  "userId" TEXT,
  "actorSessionId" TEXT,
  "subjectSessionId" TEXT,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "deviceModel" TEXT,
  "platform" "SessionPlatform",
  "osVersion" TEXT,
  "appVersion" TEXT,
  "locationCountryCode" TEXT,
  "locationCity" TEXT,
  "affectedSessionCount" INTEGER,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retentionExpiresAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityEvent_userId_occurredAt_idx" ON "SecurityEvent"("userId", "occurredAt");
CREATE INDEX "SecurityEvent_type_occurredAt_idx" ON "SecurityEvent"("type", "occurredAt");
CREATE INDEX "SecurityEvent_actorSessionId_idx" ON "SecurityEvent"("actorSessionId");
CREATE INDEX "SecurityEvent_subjectSessionId_idx" ON "SecurityEvent"("subjectSessionId");
CREATE INDEX "SecurityEvent_retentionExpiresAt_idx" ON "SecurityEvent"("retentionExpiresAt");

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_actorSessionId_fkey" FOREIGN KEY ("actorSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_subjectSessionId_fkey" FOREIGN KEY ("subjectSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
