CREATE TABLE "AccountDeletionCancellationRateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "windowEndAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountDeletionCancellationRateLimit_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "AccountDeletionCancellationRateLimit_windowEndAt_idx"
ON "AccountDeletionCancellationRateLimit"("windowEndAt");
