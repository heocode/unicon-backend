ALTER TABLE "AuthenticationChallenge"
ADD COLUMN "encryptionProtocolVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "AuthenticationChallenge"
ALTER COLUMN "encryptionProtocolVersion" DROP DEFAULT,
DROP CONSTRAINT "AuthenticationChallenge_proof_envelope_complete",
ADD CONSTRAINT "AuthenticationChallenge_proof_envelope_valid" CHECK (
    (
        "encryptedProof" IS NULL
        AND "proofEncryptionIv" IS NULL
        AND "proofEncryptionTag" IS NULL
    )
    OR
    (
        "encryptedProof" IS NOT NULL
        AND octet_length("encryptedProof") > 0
        AND "proofEncryptionIv" IS NOT NULL
        AND octet_length("proofEncryptionIv") = 12
        AND "proofEncryptionTag" IS NOT NULL
        AND octet_length("proofEncryptionTag") = 16
    )
),
ADD CONSTRAINT "AuthenticationChallenge_encryption_versions_valid" CHECK (
    "encryptionProtocolVersion" > 0
    AND "encryptionKeyVersion" > 0
);
