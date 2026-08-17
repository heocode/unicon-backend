-- AlterTable
ALTER TABLE "Session"
ADD COLUMN "deviceModelIdentifier" TEXT;

-- AlterTable
ALTER TABLE "SecurityEvent"
ADD COLUMN "deviceModelIdentifier" TEXT;
