-- CreateTable
CREATE TABLE "AssistantDraft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "inputText" TEXT NOT NULL,
    "reply" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "unclear" JSONB,
    "model" TEXT,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssistantDraft_userId_createdAt_idx" ON "AssistantDraft"("userId", "createdAt");

