-- Preserve the previous deduplication behavior for existing session-scoped
-- deliveries after replacing the composite unique index.
UPDATE "NotificationDelivery"
SET "idempotencyKey" = "type"::text || ':' || "sessionId"
WHERE "sessionId" IS NOT NULL
  AND "type" IN ('NEW_SESSION', 'SUSPICIOUS_ACTIVITY');
