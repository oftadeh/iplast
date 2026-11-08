-- CreateTable
CREATE TABLE "CustomerCategoryDiscount" (
    "customerId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "pct" DECIMAL(5,2) NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerCategoryDiscount_pkey" PRIMARY KEY ("customerId","categoryId")
);

-- AddForeignKey
ALTER TABLE "CustomerCategoryDiscount" ADD CONSTRAINT "CustomerCategoryDiscount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCategoryDiscount" ADD CONSTRAINT "CustomerCategoryDiscount_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

