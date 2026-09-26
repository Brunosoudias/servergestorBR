-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pendente', 'confirmado');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'fiado';

-- Product: unidade, fracionado e campos fiscais
ALTER TABLE "Product" ADD COLUMN     "unit" TEXT NOT NULL DEFAULT 'UN';
ALTER TABLE "Product" ADD COLUMN     "fractional" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN     "ncm" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN     "cest" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN     "cfop" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN     "origin" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Product" ADD COLUMN     "cst" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN     "taxableUnit" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ALTER COLUMN "stock" TYPE DECIMAL(14,3) USING "stock"::decimal;
ALTER TABLE "Product" ALTER COLUMN "minStock" TYPE DECIMAL(14,3) USING "minStock"::decimal;

-- Quantidades fracionadas
ALTER TABLE "SaleItem" ALTER COLUMN "qty" TYPE DECIMAL(14,3) USING "qty"::decimal;
ALTER TABLE "SaleItem" ALTER COLUMN "returnedQty" TYPE DECIMAL(14,3) USING "returnedQty"::decimal;
ALTER TABLE "StockMovement" ALTER COLUMN "quantity" TYPE DECIMAL(14,3) USING "quantity"::decimal;
ALTER TABLE "SaleReturnItem" ALTER COLUMN "qty" TYPE DECIMAL(14,3) USING "qty"::decimal;

-- CPF/CNPJ na nota e dados de cartão/PIX
ALTER TABLE "Sale" ADD COLUMN     "document" TEXT NOT NULL DEFAULT '';
ALTER TABLE "SalePayment" ADD COLUMN     "status" "PaymentStatus" NOT NULL DEFAULT 'confirmado';
ALTER TABLE "SalePayment" ADD COLUMN     "brand" TEXT;
ALTER TABLE "SalePayment" ADD COLUMN     "nsu" TEXT;
ALTER TABLE "SalePayment" ADD COLUMN     "authorizationCode" TEXT;
ALTER TABLE "SalePayment" ADD COLUMN     "acquirer" TEXT;

-- Fiado
ALTER TABLE "Customer" ADD COLUMN     "creditLimit" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- Regras extras do PDV
ALTER TABLE "PosSettings" ADD COLUMN     "requireDocumentAbove" DECIMAL(14,2);
ALTER TABLE "PosSettings" ADD COLUMN     "blockBelowCost" BOOLEAN NOT NULL DEFAULT false;
