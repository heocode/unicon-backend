-- AlterTable
ALTER TABLE "User" ADD COLUMN     "hashedVerificationToken" TEXT,
ADD COLUMN     "verificationTokenExpires" TEXT;
