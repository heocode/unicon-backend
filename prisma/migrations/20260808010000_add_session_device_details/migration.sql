-- CreateEnum
CREATE TYPE "SessionPlatform" AS ENUM ('IOS', 'ANDROID', 'WEB', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Session"
DROP COLUMN "deviceName",
ADD COLUMN "sessionName" TEXT,
ADD COLUMN "deviceModel" TEXT,
ADD COLUMN "platform" "SessionPlatform" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "osVersion" TEXT,
ADD COLUMN "appVersion" TEXT;
