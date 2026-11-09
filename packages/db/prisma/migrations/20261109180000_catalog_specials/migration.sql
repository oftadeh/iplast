-- Products sold only in whole packs; stock by hand; «تخفیف ویژه» per product.
ALTER TABLE "ProductFamily" ADD COLUMN "packOnly" BOOLEAN NOT NULL DEFAULT false;
-- the factory sells full cartons / bags: products that have a pack start as pack-only (a manager can turn it off)
UPDATE "ProductFamily" SET "packOnly" = true WHERE "packName" IS NOT NULL AND "packName" <> '';

ALTER TABLE "Variant" ADD COLUMN "stock" INTEGER;
ALTER TABLE "OrderItem" ADD COLUMN "specialPct" DECIMAL(5,2);

CREATE TYPE "SpecialKind" AS ENUM ('EXTRA', 'FIXED');

CREATE TABLE "SpecialDiscount" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "customerId" TEXT,
    "payMode" "PayMode",
    "kind" "SpecialKind" NOT NULL DEFAULT 'EXTRA',
    "pct" DECIMAL(5,2) NOT NULL,
    "minPacks" INTEGER,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SpecialDiscount_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SpecialDiscount_familyId_idx" ON "SpecialDiscount"("familyId");
CREATE INDEX "SpecialDiscount_customerId_idx" ON "SpecialDiscount"("customerId");
ALTER TABLE "SpecialDiscount" ADD CONSTRAINT "SpecialDiscount_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "ProductFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SpecialDiscount" ADD CONSTRAINT "SpecialDiscount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
