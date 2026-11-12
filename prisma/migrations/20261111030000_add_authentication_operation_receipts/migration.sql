CREATE TYPE "AuthenticationOperationKind" AS ENUM ('SIGN_IN_REQUEST', 'RESEND');
CREATE TYPE "AuthenticationOperationOutcome" AS ENUM ('CREATED', 'REUSED', 'EXISTING', 'DENIED');
CREATE TYPE "AuthenticationOperationDenial" AS ENUM ('RATE_LIMITED', 'CHALLENGE_UNAVAILABLE', 'DELIVERY_WINDOW_CLOSED');

-- No foreign keys: challenge/Delivery retention cannot erase an active receipt.
CREATE TABLE "AuthenticationOperation" (
  "id" UUID PRIMARY KEY,
  "kind" "AuthenticationOperationKind" NOT NULL,
  "requestHash" BYTEA NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "retentionExpiresAt" TIMESTAMP(3) NOT NULL,
  "outcome" "AuthenticationOperationOutcome" NOT NULL,
  "challengeId" TEXT,
  "challengeExpiresAt" TIMESTAMP(3),
  "deliveryId" TEXT,
  "deliveryOrigin" "AuthenticationDeliveryOrigin",
  "admissionNowMicros" BIGINT,
  "denial" "AuthenticationOperationDenial",
  "retryNotBeforeMicros" BIGINT,
  "deniedPolicyIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "evaluatedAtMicros" BIGINT NOT NULL,
  CONSTRAINT "AuthenticationOperation_protocol_valid" CHECK (
    substring("id"::text, 15, 1) = '7'
    AND octet_length("requestHash") = 32
    AND trunc(EXTRACT(EPOCH FROM "issuedAt") * 1000)::bigint =
      ('x' || substring(replace("id"::text, '-', ''), 1, 12))::bit(48)::bigint
    AND "expiresAt" = "issuedAt" + INTERVAL '24 hours'
    AND "retentionExpiresAt" = "expiresAt" + INTERVAL '5 minutes'
    AND "evaluatedAtMicros" >= trunc(EXTRACT(EPOCH FROM "issuedAt") * 1000000)::bigint
    AND "evaluatedAtMicros" < trunc(EXTRACT(EPOCH FROM "expiresAt") * 1000000)::bigint
  ),
  CONSTRAINT "AuthenticationOperation_result_valid" CHECK (
    (
      "outcome" = 'CREATED' AND "challengeId" IS NOT NULL AND "deliveryId" IS NOT NULL
      AND "deliveryOrigin" IS NOT NULL
      AND "admissionNowMicros" IS NOT NULL AND "admissionNowMicros" > 0
      AND "admissionNowMicros" <= "evaluatedAtMicros"
      AND (("kind" = 'SIGN_IN_REQUEST' AND "challengeExpiresAt" IS NOT NULL AND "deliveryOrigin" = 'INITIAL')
        OR ("kind" = 'RESEND' AND "challengeExpiresAt" IS NULL AND "deliveryOrigin" = 'RESEND'))
    ) OR (
      "outcome" = 'REUSED' AND "kind" = 'SIGN_IN_REQUEST'
      AND "challengeId" IS NOT NULL AND "challengeExpiresAt" IS NOT NULL
      AND "deliveryId" IS NULL AND "deliveryOrigin" IS NULL AND "admissionNowMicros" IS NULL
    ) OR (
      "outcome" = 'EXISTING' AND "kind" = 'RESEND'
      AND "challengeId" IS NOT NULL AND "challengeExpiresAt" IS NULL
      AND "deliveryId" IS NOT NULL AND "deliveryOrigin" IS NOT NULL AND "admissionNowMicros" IS NULL
    ) OR (
      "outcome" = 'DENIED' AND "challengeId" IS NULL AND "challengeExpiresAt" IS NULL
      AND "deliveryId" IS NULL AND "deliveryOrigin" IS NULL AND "admissionNowMicros" IS NULL
    )
  ),
  CONSTRAINT "AuthenticationOperation_denial_valid" CHECK (
    ("outcome" <> 'DENIED' AND "denial" IS NULL AND "retryNotBeforeMicros" IS NULL AND cardinality("deniedPolicyIds") = 0)
    OR ("outcome" = 'DENIED' AND "denial" IS NOT NULL AND (
      ("denial" = 'RATE_LIMITED' AND "retryNotBeforeMicros" IS NOT NULL
        AND "retryNotBeforeMicros" > "evaluatedAtMicros" AND cardinality("deniedPolicyIds") > 0)
      OR ("denial" <> 'RATE_LIMITED' AND "retryNotBeforeMicros" IS NULL AND cardinality("deniedPolicyIds") = 0)
    ))
  )
);

CREATE INDEX "AuthenticationOperation_retentionExpiresAt_id_idx"
ON "AuthenticationOperation"("retentionExpiresAt", "id");
