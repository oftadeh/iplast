-- CreateEnum
CREATE TYPE "DocKind" AS ENUM ('RECEIPT', 'CHEQUE', 'INVOICE', 'WAYBILL', 'CONTRACT', 'OTHER');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "discount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "shipping" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Proforma" ADD COLUMN     "breakdown" JSONB,
ADD COLUMN     "changed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "items" JSONB;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "cashDiscount" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "chequeMarkup" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "remindedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "waybillNo" TEXT,
    "carrier" TEXT,
    "driverName" TEXT,
    "driverPhone" TEXT,
    "plate" TEXT,
    "freight" BIGINT,
    "freightBy" TEXT,
    "note" TEXT,
    "shippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT,
    "paymentId" TEXT,
    "invoiceId" TEXT,
    "shipmentId" TEXT,
    "kind" "DocKind" NOT NULL,
    "title" TEXT,
    "fileKey" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "byCustomer" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Document_customerId_createdAt_idx" ON "Document"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "Document_orderId_idx" ON "Document"("orderId");

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

