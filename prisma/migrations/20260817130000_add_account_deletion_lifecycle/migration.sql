-- AlterEnum
ALTER TYPE "UserStatus" ADD VALUE 'DELETION_SCHEDULED';

-- AlterEnum
ALTER TYPE "SecurityEventType" ADD VALUE 'ACCOUNT_DELETION_REQUESTED';
ALTER TYPE "SecurityEventType" ADD VALUE 'ACCOUNT_DELETION_CANCELLED';
ALTER TYPE "SecurityEventType" ADD VALUE 'ACCOUNT_DELETED';

-- AlterEnum
ALTER TYPE "SecurityEventReason" ADD VALUE 'GRACE_PERIOD_EXPIRED';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'ACCOUNT_DELETION_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'ACCOUNT_DELETION_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE 'ACCOUNT_DELETED';

-- AlterTable
ALTER TABLE "User"
ADD COLUMN "deletionRequestedAt" TIMESTAMP(3),
ADD COLUMN "deletionScheduledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_status_deletionScheduledAt_idx"
ON "User"("status", "deletionScheduledAt");
