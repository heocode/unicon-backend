-- AlterTable
ALTER TABLE "NotificationDelivery" ADD COLUMN "retentionExpiresAt" TIMESTAMP(3);

UPDATE "NotificationDelivery"
SET "retentionExpiresAt" = "createdAt" + INTERVAL '180 days';

ALTER TABLE "NotificationDelivery" ALTER COLUMN "retentionExpiresAt" SET NOT NULL;

-- CreateIndex
CREATE INDEX "NotificationDelivery_retentionExpiresAt_idx" ON "NotificationDelivery"("retentionExpiresAt");
