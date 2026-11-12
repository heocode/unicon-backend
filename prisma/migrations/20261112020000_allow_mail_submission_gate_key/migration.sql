BEGIN;
-- Keep v1 characteristic keys unchanged. Permit only the two explicitly bound
-- system keys, with distinct creation-admission and mail-permission policies.
ALTER TABLE "GcraRateLimit"
  DROP CONSTRAINT "GcraRateLimit_key_valid",
  ADD CONSTRAINT "GcraRateLimit_key_valid" CHECK (
    ("key" ~ '^rl:v1:k[1-9][0-9]*:[0-9a-f]{64}$'
      AND "policyId" NOT IN ('AUTH_DELIVERY_GLOBAL', 'MAIL_RESEND_SUBMISSION'))
    OR ("key" = 'gcra:auth:delivery-admission:v1' AND "policyId" = 'AUTH_DELIVERY_GLOBAL')
    OR ("key" = 'gcra:mail:resend-submission:v1' AND "policyId" = 'MAIL_RESEND_SUBMISSION')
  );
COMMIT;
