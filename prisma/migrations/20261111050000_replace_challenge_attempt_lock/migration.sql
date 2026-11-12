BEGIN;

-- Preserve the terminal meaning of legacy exhausted rows before removing the
-- threshold. Existing locked/consumed records and GCRA debt remain unchanged.
UPDATE "AuthenticationChallenge"
SET "lockedAt" = clock_timestamp(),
    "encryptedProof" = NULL,
    "proofEncryptionIv" = NULL,
    "proofEncryptionTag" = NULL,
    "updatedAt" = clock_timestamp()
WHERE "consumedAt" IS NULL AND "lockedAt" IS NULL
  AND "failedAttemptCount" >= "maxAttempts";

ALTER TABLE "AuthenticationChallenge"
  DROP CONSTRAINT "AuthenticationChallenge_attempts_valid",
  DROP COLUMN "maxAttempts",
  ADD CONSTRAINT "AuthenticationChallenge_failed_attempt_count_valid"
    CHECK ("failedAttemptCount" >= 0);

COMMIT;
