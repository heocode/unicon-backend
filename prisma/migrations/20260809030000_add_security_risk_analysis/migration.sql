-- AlterEnum
ALTER TYPE "SecurityEventType" ADD VALUE 'SUSPICIOUS_ACTIVITY_DETECTED';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'SUSPICIOUS_ACTIVITY';

-- CreateEnum
CREATE TYPE "SecurityRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "SecurityRiskSignal" AS ENUM (
  'NEW_DEVICE',
  'NEW_COUNTRY',
  'EXCESSIVE_LOGIN_FAILURES',
  'MANY_NEW_SESSIONS',
  'REFRESH_TOKEN_REUSE'
);

-- AlterTable
ALTER TABLE "SecurityEvent"
ADD COLUMN "riskLevel" "SecurityRiskLevel",
ADD COLUMN "riskSignals" "SecurityRiskSignal"[] NOT NULL DEFAULT ARRAY[]::"SecurityRiskSignal"[];
