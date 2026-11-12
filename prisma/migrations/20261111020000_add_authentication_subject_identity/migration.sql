-- Legacy subjects retain their opaque keys, timestamps and challenge relations.
-- New SIGN_IN coordination rows populate both nullable identity fields.
ALTER TABLE "AuthenticationChallengeSubject"
ADD COLUMN "normalizedIdentity" TEXT,
ADD COLUMN "purpose" "AuthenticationChallengePurpose",
ADD CONSTRAINT "AuthenticationChallengeSubject_identity_complete" CHECK (
  ("normalizedIdentity" IS NULL AND "purpose" IS NULL)
  OR ("normalizedIdentity" IS NOT NULL AND "purpose" IS NOT NULL)
);

CREATE UNIQUE INDEX "AuthenticationChallengeSubject_normalizedIdentity_purpose_key"
ON "AuthenticationChallengeSubject"("normalizedIdentity", "purpose");

-- Initial resolution must also discover challenges linked to legacy subjects.
CREATE INDEX "AuthenticationChallenge_normalizedIdentity_purpose_idx"
ON "AuthenticationChallenge"("normalizedIdentity", "purpose");
