-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "handoffAt" TIMESTAMP(3),
ADD COLUMN "handoffReason" TEXT;
