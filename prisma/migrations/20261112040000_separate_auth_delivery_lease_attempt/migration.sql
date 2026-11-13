ALTER TABLE "AuthenticationChallengeDelivery"
  ADD COLUMN "processingAttemptStarted" BOOLEAN NOT NULL DEFAULT false;
-- Existing PROCESSING claims have already charged their processing attempt.
UPDATE "AuthenticationChallengeDelivery"
SET "processingAttemptStarted" = true
WHERE "status" = 'PROCESSING' AND "attemptCount" > 0;
ALTER TABLE "AuthenticationChallengeDelivery"
  ADD CONSTRAINT "AuthenticationChallengeDelivery_started_attempt_valid"
  CHECK (NOT "processingAttemptStarted" OR ("status" = 'PROCESSING' AND "attemptCount" > 0));
