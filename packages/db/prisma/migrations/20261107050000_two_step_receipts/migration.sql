-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'SALES_APPROVED';

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'REPORTED';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "receiptKey" TEXT,
ADD COLUMN     "reportedById" TEXT;

