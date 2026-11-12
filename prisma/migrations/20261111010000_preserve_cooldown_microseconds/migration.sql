-- Preserve every existing value while increasing boundary precision.
-- Timestamp remains without time zone, with the existing UTC epoch convention.
ALTER TABLE "AuthenticationRateLimit"
ALTER COLUMN "windowEndAt" TYPE TIMESTAMP(6);
