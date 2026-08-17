-- AlterEnum
ALTER TYPE "SecurityEventType" ADD VALUE 'PASSWORD_RESET_REQUESTED';
ALTER TYPE "SecurityEventType" ADD VALUE 'PASSWORD_RESET_COMPLETED';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'PASSWORD_RESET_REQUEST';
ALTER TYPE "NotificationType" ADD VALUE 'PASSWORD_RESET_COMPLETED';

-- AlterTable
ALTER TABLE "User" DROP COLUMN "hashedResetPasswordToken",
DROP COLUMN "resetPasswordExpires";

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetRateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "windowEndAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PasswordResetRateLimit_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_userId_createdAt_idx" ON "PasswordResetToken"("userId", "createdAt");
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");
CREATE INDEX "PasswordResetRateLimit_windowEndAt_idx" ON "PasswordResetRateLimit"("windowEndAt");

ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
