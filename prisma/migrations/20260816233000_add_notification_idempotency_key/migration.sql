-- DropIndex
DROP INDEX "NotificationDelivery_type_channel_sessionId_key";

-- AlterTable
ALTER TABLE "NotificationDelivery" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_idempotencyKey_key" ON "NotificationDelivery"("idempotencyKey");
