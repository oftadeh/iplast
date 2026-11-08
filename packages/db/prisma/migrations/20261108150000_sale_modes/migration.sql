-- CreateEnum
CREATE TYPE "PayMode" AS ENUM ('CASH', 'TERM');

-- AlterTable
ALTER TABLE "CustomerCategoryDiscount" ADD COLUMN     "termPct" DECIMAL(5,2),
ALTER COLUMN "pct" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PaymentTerms" ADD COLUMN     "allowCash" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowTerm" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "termDiscountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
ADD COLUMN     "termMonths" INTEGER NOT NULL DEFAULT 3;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "payMode" "PayMode" NOT NULL DEFAULT 'CASH',
ADD COLUMN     "termMonths" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "listPrice" BIGINT,
ADD COLUMN     "salePct" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "listTotal" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "payMode" "PayMode" NOT NULL DEFAULT 'CASH',
ADD COLUMN     "termMonths" INTEGER NOT NULL DEFAULT 0;

