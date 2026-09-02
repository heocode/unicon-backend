-- CreateEnum
CREATE TYPE "AuthenticationIdentityType" AS ENUM ('INSTITUTIONAL_EMAIL');

-- CreateEnum
CREATE TYPE "AuthenticationChallengePurpose" AS ENUM ('SIGN_IN', 'STEP_UP');

-- CreateEnum
CREATE TYPE "AuthenticationMethod" AS ENUM ('EMAIL_OTP', 'EMAIL_MAGIC_LINK');

-- CreateEnum
CREATE TYPE "AuthenticationDeliveryMethod" AS ENUM ('EMAIL');

-- CreateEnum
CREATE TYPE "AuthenticationDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "Session"
ADD COLUMN "authenticationMethod" "AuthenticationMethod",
ADD COLUMN "authenticatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AuthenticationChallengeSubject" (
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthenticationChallengeSubject_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuthenticationChallenge" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "subjectKey" TEXT NOT NULL,
    "identityType" "AuthenticationIdentityType" NOT NULL,
    "normalizedIdentity" TEXT NOT NULL,
    "purpose" "AuthenticationChallengePurpose" NOT NULL,
    "userId" TEXT,
    "boundSessionId" TEXT,
    "otpHash" TEXT NOT NULL,
    "linkTokenHash" TEXT NOT NULL,
    "hashKeyVersion" INTEGER NOT NULL,
    "encryptedProof" BYTEA,
    "proofEncryptionIv" BYTEA,
    "proofEncryptionTag" BYTEA,
    "encryptionKeyVersion" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "failedAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "retentionExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthenticationChallenge_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuthenticationChallenge_proof_envelope_complete" CHECK (
        ("encryptedProof" IS NULL AND "proofEncryptionIv" IS NULL AND "proofEncryptionTag" IS NULL)
        OR
        ("encryptedProof" IS NOT NULL AND "proofEncryptionIv" IS NOT NULL AND "proofEncryptionTag" IS NOT NULL)
    ),
    CONSTRAINT "AuthenticationChallenge_attempts_valid" CHECK (
        "maxAttempts" > 0
        AND "failedAttemptCount" >= 0
        AND "failedAttemptCount" <= "maxAttempts"
    ),
    CONSTRAINT "AuthenticationChallenge_terminal_state_valid" CHECK (
        NOT ("consumedAt" IS NOT NULL AND "lockedAt" IS NOT NULL)
        AND (
            ("consumedAt" IS NULL AND "lockedAt" IS NULL)
            OR
            ("encryptedProof" IS NULL AND "proofEncryptionIv" IS NULL AND "proofEncryptionTag" IS NULL)
        )
    ),
    CONSTRAINT "AuthenticationChallenge_purpose_binding_valid" CHECK (
        ("purpose" = 'SIGN_IN' AND "boundSessionId" IS NULL)
        OR
        ("purpose" = 'STEP_UP' AND "boundSessionId" IS NOT NULL AND "userId" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "AuthenticationChallengeDelivery" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "challengeId" TEXT NOT NULL,
    "method" "AuthenticationDeliveryMethod" NOT NULL,
    "status" "AuthenticationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "recipientSnapshot" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "failureCode" TEXT,
    "attemptedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "retentionExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthenticationChallengeDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthenticationRateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "windowEndAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthenticationRateLimit_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "AuthenticationRateLimit_count_valid" CHECK ("count" > 0)
);

-- CreateIndex
CREATE INDEX "AuthenticationChallenge_subjectKey_createdAt_idx"
ON "AuthenticationChallenge"("subjectKey", "createdAt");

-- CreateIndex
CREATE INDEX "AuthenticationChallenge_userId_createdAt_idx"
ON "AuthenticationChallenge"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuthenticationChallenge_boundSessionId_idx"
ON "AuthenticationChallenge"("boundSessionId");

-- CreateIndex
CREATE INDEX "AuthenticationChallenge_expiresAt_idx"
ON "AuthenticationChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "AuthenticationChallenge_retentionExpiresAt_idx"
ON "AuthenticationChallenge"("retentionExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthenticationChallengeDelivery_idempotencyKey_key"
ON "AuthenticationChallengeDelivery"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AuthenticationChallengeDelivery_challengeId_createdAt_idx"
ON "AuthenticationChallengeDelivery"("challengeId", "createdAt");

-- CreateIndex
CREATE INDEX "AuthenticationChallengeDelivery_status_createdAt_idx"
ON "AuthenticationChallengeDelivery"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AuthenticationChallengeDelivery_retentionExpiresAt_idx"
ON "AuthenticationChallengeDelivery"("retentionExpiresAt");

-- CreateIndex
CREATE INDEX "AuthenticationRateLimit_windowEndAt_idx"
ON "AuthenticationRateLimit"("windowEndAt");

-- AddForeignKey
ALTER TABLE "AuthenticationChallenge"
ADD CONSTRAINT "AuthenticationChallenge_subjectKey_fkey"
FOREIGN KEY ("subjectKey") REFERENCES "AuthenticationChallengeSubject"("key")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthenticationChallenge"
ADD CONSTRAINT "AuthenticationChallenge_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthenticationChallenge"
ADD CONSTRAINT "AuthenticationChallenge_boundSessionId_fkey"
FOREIGN KEY ("boundSessionId") REFERENCES "Session"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthenticationChallengeDelivery"
ADD CONSTRAINT "AuthenticationChallengeDelivery_challengeId_fkey"
FOREIGN KEY ("challengeId") REFERENCES "AuthenticationChallenge"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
