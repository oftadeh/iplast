-- CreateEnum
CREATE TYPE "JoinStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "code" SERIAL NOT NULL;

-- CreateTable
CREATE TABLE "JoinRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'BUYER',
    "note" TEXT,
    "status" "JoinStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JoinRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JoinRequest_status_createdAt_idx" ON "JoinRequest"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_code_key" ON "Customer"("code");

-- AddForeignKey
ALTER TABLE "JoinRequest" ADD CONSTRAINT "JoinRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JoinRequest" ADD CONSTRAINT "JoinRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Customer codes start at 1001, oldest customer first
UPDATE "Customer" c SET "code" = 1000 + r.n FROM (SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt", "id") AS n FROM "Customer") r WHERE r."id" = c."id";
SELECT setval(pg_get_serial_sequence('"Customer"', 'code'), GREATEST(1000, (SELECT COALESCE(MAX("code"), 1000) FROM "Customer")));
