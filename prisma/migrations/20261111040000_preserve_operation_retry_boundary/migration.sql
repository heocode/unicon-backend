-- Preserve all receipt values and the full existing GCRA NUMERIC time range.
ALTER TABLE "AuthenticationOperation"
ALTER COLUMN "retryNotBeforeMicros" TYPE NUMERIC;

ALTER TABLE "AuthenticationOperation"
ADD CONSTRAINT "AuthenticationOperation_retry_boundary_valid" CHECK (
  "retryNotBeforeMicros" IS NULL OR (
    "retryNotBeforeMicros" >= 0 AND "retryNotBeforeMicros" < 'Infinity'::numeric
    AND "retryNotBeforeMicros" = trunc("retryNotBeforeMicros")
  )
);
