-- Additive only: no existing challenge, cooldown, or user state is rewritten.
CREATE TABLE "GcraRateLimit" (
    "key" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "tatNumerator" NUMERIC NOT NULL,
    "tatDenominator" NUMERIC NOT NULL,
    "idleAfterMicros" NUMERIC NOT NULL,
    "burst" BIGINT NOT NULL,
    "rate" BIGINT NOT NULL,
    "periodSeconds" BIGINT NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "GcraRateLimit_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "GcraRateLimit_key_valid" CHECK (
        "key" ~ '^rl:v1:k[1-9][0-9]*:[0-9a-f]{64}$'
    ),
    CONSTRAINT "GcraRateLimit_policy_id_valid" CHECK (
        length("policyId") BETWEEN 1 AND 96
        AND "policyId" ~ '^[A-Z][A-Z0-9_]*$'
    ),
    CONSTRAINT "GcraRateLimit_tat_numerator_valid" CHECK (
        "tatNumerator" >= 0 AND "tatNumerator" < 'Infinity'::numeric
        AND "tatNumerator" = trunc("tatNumerator")
    ),
    CONSTRAINT "GcraRateLimit_tat_denominator_valid" CHECK (
        "tatDenominator" > 0 AND "tatDenominator" < 'Infinity'::numeric
        AND "tatDenominator" = trunc("tatDenominator")
    ),
    CONSTRAINT "GcraRateLimit_idle_after_valid" CHECK (
        "idleAfterMicros" >= 0 AND "idleAfterMicros" < 'Infinity'::numeric
        AND "idleAfterMicros" = trunc("idleAfterMicros")
        AND "idleAfterMicros" = div("tatNumerator", NULLIF("tatDenominator", 0))
          + CASE WHEN mod("tatNumerator", NULLIF("tatDenominator", 0)) > 0 THEN 1 ELSE 0 END
    ),
    CONSTRAINT "GcraRateLimit_policy_snapshot_valid" CHECK (
        "burst" BETWEEN 1 AND 9007199254740991
        AND "rate" BETWEEN 1 AND 9007199254740991
        AND "periodSeconds" BETWEEN 1 AND 9007199254740991
    )
);

CREATE INDEX "GcraRateLimit_policyId_idx" ON "GcraRateLimit"("policyId");
CREATE INDEX "GcraRateLimit_idleAfterMicros_idx" ON "GcraRateLimit"("idleAfterMicros");
