BEGIN;
-- Preserve the exact v1 characteristic-key contract. The only system-key
-- exception belongs to the fixed, non-identifying global creation policy.
ALTER TABLE "GcraRateLimit"
  DROP CONSTRAINT "GcraRateLimit_key_valid",
  ADD CONSTRAINT "GcraRateLimit_key_valid" CHECK (
    ("key" ~ '^rl:v1:k[1-9][0-9]*:[0-9a-f]{64}$' AND "policyId" <> 'AUTH_DELIVERY_GLOBAL')
    OR ("key" = 'gcra:auth:delivery-admission:v1' AND "policyId" = 'AUTH_DELIVERY_GLOBAL')
  );
COMMIT;
