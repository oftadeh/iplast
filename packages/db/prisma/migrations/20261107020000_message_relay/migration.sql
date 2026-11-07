-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "relayChatId" BIGINT,
ADD COLUMN     "relayMessageId" INTEGER;

-- CreateIndex
CREATE INDEX "Message_relayChatId_relayMessageId_idx" ON "Message"("relayChatId", "relayMessageId");

