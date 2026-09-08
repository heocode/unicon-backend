-- CreateEnum
CREATE TYPE "AuthenticationDeliveryOrigin" AS ENUM ('INITIAL', 'RESEND');

-- AlterEnum
ALTER TYPE "AuthenticationDeliveryStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "AuthenticationDeliveryStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "AuthenticationChallengeDelivery"
RENAME COLUMN "failureCode" TO "lastSafeFailureCode";

UPDATE "AuthenticationChallengeDelivery"
SET "lastSafeFailureCode" = 'LEGACY_UNSPECIFIED'
WHERE "status" = 'FAILED' AND "lastSafeFailureCode" IS NULL;

ALTER TABLE "AuthenticationChallengeDelivery"
ADD COLUMN "origin" "AuthenticationDeliveryOrigin" NOT NULL DEFAULT 'INITIAL',
ADD COLUMN "templateProtocolVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN "processingLeaseId" UUID,
ADD COLUMN "processingLeaseExpiresAt" TIMESTAMP(3);

ALTER TABLE "AuthenticationChallengeDelivery"
ALTER COLUMN "origin" DROP DEFAULT,
ALTER COLUMN "templateProtocolVersion" DROP DEFAULT,
ADD CONSTRAINT "AuthenticationChallengeDelivery_attempt_count_valid" CHECK (
    "attemptCount" >= 0
),
ADD CONSTRAINT "AuthenticationChallengeDelivery_template_protocol_valid" CHECK (
    "templateProtocolVersion" > 0
),
ADD CONSTRAINT "AuthenticationChallengeDelivery_processing_lease_valid" CHECK (
    (
        "status" = 'PROCESSING'
        AND "processingLeaseId" IS NOT NULL
        AND "processingLeaseExpiresAt" IS NOT NULL
        AND "nextAttemptAt" IS NULL
    )
    OR
    (
        "status" <> 'PROCESSING'
        AND "processingLeaseId" IS NULL
        AND "processingLeaseExpiresAt" IS NULL
    )
),
ADD CONSTRAINT "AuthenticationChallengeDelivery_sent_state_valid" CHECK (
    ("status" = 'SENT' AND "sentAt" IS NOT NULL)
    OR
    ("status" <> 'SENT' AND "sentAt" IS NULL)
),
ADD CONSTRAINT "AuthenticationChallengeDelivery_terminal_retry_valid" CHECK (
    "status" NOT IN ('SENT', 'FAILED', 'CANCELLED')
    OR "nextAttemptAt" IS NULL
),
ADD CONSTRAINT "AuthenticationChallengeDelivery_terminal_reason_valid" CHECK (
    "status" NOT IN ('FAILED', 'CANCELLED')
    OR "lastSafeFailureCode" IS NOT NULL
);

-- CreateIndex
CREATE INDEX "AuthenticationChallengeDelivery_challengeId_status_idx"
ON "AuthenticationChallengeDelivery"("challengeId", "status");

CREATE INDEX "AuthenticationChallengeDelivery_status_nextAttemptAt_idx"
ON "AuthenticationChallengeDelivery"("status", "nextAttemptAt");

CREATE INDEX "AuthenticationChallengeDelivery_status_processingLeaseExpiresAt_idx"
ON "AuthenticationChallengeDelivery"("status", "processingLeaseExpiresAt");
