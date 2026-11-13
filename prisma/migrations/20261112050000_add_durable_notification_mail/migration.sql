ALTER TYPE "NotificationType" ADD VALUE 'LEGACY_EMAIL_VERIFICATION';
ALTER TABLE "NotificationDelivery"
  ADD COLUMN "mailQueuedAt" TIMESTAMP(3),
  ADD COLUMN "mailExpiresAt" TIMESTAMP(3),
  ADD COLUMN "mailPayload" BYTEA,
  ADD COLUMN "mailIv" BYTEA,
  ADD COLUMN "mailTag" BYTEA,
  ADD COLUMN "mailProtocol" INTEGER,
  ADD COLUMN "mailKeyVersion" INTEGER,
  ADD COLUMN "mailAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "mailAttemptStarted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "mailNextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "mailLeaseId" UUID,
  ADD COLUMN "mailLeaseExpiresAt" TIMESTAMP(3),
  ADD CONSTRAINT "NotificationDelivery_mail_envelope_valid" CHECK (
    ("mailPayload" IS NULL AND "mailIv" IS NULL AND "mailTag" IS NULL AND "mailProtocol" IS NULL AND "mailKeyVersion" IS NULL)
    OR ("mailPayload" IS NOT NULL AND octet_length("mailPayload") > 0 AND octet_length("mailIv") = 12 AND "mailIv" IS NOT NULL
      AND octet_length("mailTag") = 16 AND "mailTag" IS NOT NULL AND "mailProtocol" > 0 AND "mailProtocol" IS NOT NULL AND "mailKeyVersion" > 0 AND "mailKeyVersion" IS NOT NULL)
  ),
  ADD CONSTRAINT "NotificationDelivery_mail_lifecycle_valid" CHECK (
    ("mailQueuedAt" IS NULL AND "mailExpiresAt" IS NULL AND "mailPayload" IS NULL AND "mailLeaseId" IS NULL AND "mailLeaseExpiresAt" IS NULL AND NOT "mailAttemptStarted" AND "mailNextAttemptAt" IS NULL AND "mailAttemptCount" = 0)
    OR ("mailQueuedAt" IS NOT NULL AND "mailExpiresAt" IS NOT NULL AND "idempotencyKey" IS NOT NULL
      AND "mailExpiresAt" > "mailQueuedAt" AND "mailExpiresAt" < "mailQueuedAt" + interval '24 hours'
      AND "retentionExpiresAt" >= "mailExpiresAt" AND "mailAttemptCount" BETWEEN 0 AND 5
      AND (("status" = 'PENDING' AND "mailPayload" IS NOT NULL) OR ("status" <> 'PENDING' AND "mailPayload" IS NULL AND "mailLeaseId" IS NULL AND "mailLeaseExpiresAt" IS NULL AND "mailNextAttemptAt" IS NULL AND NOT "mailAttemptStarted"))
      AND (("mailLeaseId" IS NULL AND "mailLeaseExpiresAt" IS NULL AND NOT "mailAttemptStarted") OR ("mailLeaseId" IS NOT NULL AND "mailLeaseExpiresAt" IS NOT NULL AND "mailNextAttemptAt" IS NULL))
      AND (NOT "mailAttemptStarted" OR "mailAttemptCount" > 0))
  );
CREATE INDEX "NotificationDelivery_status_mailNextAttemptAt_idx" ON "NotificationDelivery"("status", "mailNextAttemptAt");
CREATE INDEX "NotificationDelivery_mailExpiresAt_idx" ON "NotificationDelivery"("mailExpiresAt");
