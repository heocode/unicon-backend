CREATE TABLE "MailProviderPressure" (
    "id" INTEGER NOT NULL PRIMARY KEY CHECK ("id" = 1),
    "retryNotBeforeMicros" BIGINT NOT NULL DEFAULT 0 CHECK ("retryNotBeforeMicros" >= 0),
    "dailyNotBeforeMicros" BIGINT NOT NULL DEFAULT 0 CHECK ("dailyNotBeforeMicros" >= 0),
    "monthlyBlocked" BOOLEAN NOT NULL DEFAULT false,
    "revision" BIGINT NOT NULL DEFAULT 0 CHECK ("revision" >= 0)
);
INSERT INTO "MailProviderPressure" ("id") VALUES (1);
