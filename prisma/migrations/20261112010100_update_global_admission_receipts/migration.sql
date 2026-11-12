BEGIN;
ALTER TABLE "AuthenticationOperation"
  DROP CONSTRAINT "AuthenticationOperation_denial_valid",
  ADD CONSTRAINT "AuthenticationOperation_denial_valid" CHECK (
    ("outcome" <> 'DENIED' AND "denial" IS NULL AND "retryNotBeforeMicros" IS NULL AND cardinality("deniedPolicyIds") = 0)
    OR ("outcome" = 'DENIED' AND "denial" IS NOT NULL AND (
      ("denial" IN ('RATE_LIMITED', 'GLOBAL_RATE_DENIED') AND "retryNotBeforeMicros" IS NOT NULL
        AND "retryNotBeforeMicros" > "evaluatedAtMicros" AND cardinality("deniedPolicyIds") > 0
        AND (("denial" = 'GLOBAL_RATE_DENIED' AND 'AUTH_DELIVERY_GLOBAL' = ANY("deniedPolicyIds"))
          OR ("denial" = 'RATE_LIMITED' AND NOT ('AUTH_DELIVERY_GLOBAL' = ANY("deniedPolicyIds")))))
      OR ("denial" NOT IN ('RATE_LIMITED', 'GLOBAL_RATE_DENIED') AND "retryNotBeforeMicros" IS NULL AND cardinality("deniedPolicyIds") = 0)
    ))
  );
COMMIT;
