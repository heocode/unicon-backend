BEGIN;

ALTER TYPE "AuthenticationOperationDenial" ADD VALUE 'DELIVERY_CAPACITY_UNAVAILABLE';

CREATE TABLE "AuthenticationDeliveryBacklogState" (
  "id" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuthenticationDeliveryBacklogState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuthenticationDeliveryBacklogState_singleton" CHECK ("id" = 1)
);

INSERT INTO "AuthenticationDeliveryBacklogState" ("id", "updatedAt")
VALUES (1, clock_timestamp());

COMMIT;
