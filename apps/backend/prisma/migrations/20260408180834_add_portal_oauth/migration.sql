-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN "accessToken" TEXT;
ALTER TABLE "AppSettings" ADD COLUMN "authExpiresAt" DATETIME;
ALTER TABLE "AppSettings" ADD COLUMN "memberId" TEXT;
ALTER TABLE "AppSettings" ADD COLUMN "refreshToken" TEXT;
