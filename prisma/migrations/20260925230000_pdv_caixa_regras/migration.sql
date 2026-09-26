-- CreateEnum
CREATE TYPE "RefundMethod" AS ENUM ('dinheiro', 'credito_cliente', 'estorno_externo');

-- AlterEnum
ALTER TYPE "CashMovementType" ADD VALUE 'estorno';

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'credito_cliente';

-- AlterTable
ALTER TABLE "CashMovement" ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "method" "PaymentMethod" NOT NULL DEFAULT 'dinheiro',
ADD COLUMN     "saleId" TEXT;

-- AlterTable
ALTER TABLE "CashSession" ADD COLUMN     "closedById" TEXT,
ADD COLUMN     "collected" DECIMAL(14,2),
ADD COLUMN     "float" DECIMAL(14,2),
ADD COLUMN     "forced" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "staleNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "terminalId" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "creditBalance" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "FinanceEntry" ADD COLUMN     "saleId" TEXT;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "requestId" TEXT;

-- AlterTable
ALTER TABLE "SaleItem" ADD COLUMN     "returnedQty" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "SalePayment" ADD COLUMN     "change" DECIMAL(14,2),
ADD COLUMN     "received" DECIMAL(14,2);

-- CreateTable
CREATE TABLE "CashSessionCount" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "expected" DECIMAL(14,2) NOT NULL,
    "counted" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "CashSessionCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosTerminal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultFloat" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosTerminal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosSettings" (
    "organizationId" TEXT NOT NULL,
    "requireCustomer" BOOLEAN NOT NULL DEFAULT false,
    "allowNegativeStock" BOOLEAN NOT NULL DEFAULT false,
    "autoPrint" BOOLEAN NOT NULL DEFAULT false,
    "beep" BOOLEAN NOT NULL DEFAULT true,
    "blindClose" BOOLEAN NOT NULL DEFAULT false,
    "cancelSameDayOnly" BOOLEAN NOT NULL DEFAULT false,
    "cashLimit" DECIMAL(14,2),
    "maxDifference" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "withdrawalApprovalAbove" DECIMAL(14,2),
    "maxOpenHours" INTEGER NOT NULL DEFAULT 14,
    "discountLimits" JSONB NOT NULL DEFAULT '{}',
    "moveReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosSettings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "PaymentMethodConfig" (
    "organizationId" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "accountId" TEXT,
    "feePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "installmentFeePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "feeFixed" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "settlementDays" INTEGER NOT NULL DEFAULT 0,
    "enabledInPos" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PaymentMethodConfig_pkey" PRIMARY KEY ("organizationId","method")
);

-- CreateTable
CREATE TABLE "PosAuthorization" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "supervisorId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleReturn" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "cashSessionId" TEXT,
    "reason" TEXT NOT NULL,
    "refundMethod" "RefundMethod" NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleReturnItem" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "saleItemId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "restock" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "SaleReturnItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerCreditMovement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "TxType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "description" TEXT NOT NULL,
    "saleId" TEXT,
    "returnId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerCreditMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashSessionCount_sessionId_method_key" ON "CashSessionCount"("sessionId", "method");

-- CreateIndex
CREATE UNIQUE INDEX "PosTerminal_organizationId_name_key" ON "PosTerminal"("organizationId", "name");

-- CreateIndex
CREATE INDEX "PosAuthorization_organizationId_expiresAt_idx" ON "PosAuthorization"("organizationId", "expiresAt");

-- CreateIndex
CREATE INDEX "SaleReturn_saleId_idx" ON "SaleReturn"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "SaleReturn_organizationId_number_key" ON "SaleReturn"("organizationId", "number");

-- CreateIndex
CREATE INDEX "SaleReturnItem_returnId_idx" ON "SaleReturnItem"("returnId");

-- CreateIndex
CREATE INDEX "CustomerCreditMovement_customerId_createdAt_idx" ON "CustomerCreditMovement"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "CashMovement_saleId_idx" ON "CashMovement"("saleId");

-- CreateIndex
CREATE INDEX "CashSession_organizationId_openedAt_idx" ON "CashSession"("organizationId", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_organizationId_requestId_key" ON "Sale"("organizationId", "requestId");

-- AddForeignKey
ALTER TABLE "CashSession" ADD CONSTRAINT "CashSession_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "PosTerminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashSessionCount" ADD CONSTRAINT "CashSessionCount_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CashSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosTerminal" ADD CONSTRAINT "PosTerminal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSettings" ADD CONSTRAINT "PosSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethodConfig" ADD CONSTRAINT "PaymentMethodConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosAuthorization" ADD CONSTRAINT "PosAuthorization_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReturn" ADD CONSTRAINT "SaleReturn_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReturn" ADD CONSTRAINT "SaleReturn_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReturn" ADD CONSTRAINT "SaleReturn_cashSessionId_fkey" FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReturnItem" ADD CONSTRAINT "SaleReturnItem_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "SaleReturn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleReturnItem" ADD CONSTRAINT "SaleReturnItem_saleItemId_fkey" FOREIGN KEY ("saleItemId") REFERENCES "SaleItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditMovement" ADD CONSTRAINT "CustomerCreditMovement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerCreditMovement" ADD CONSTRAINT "CustomerCreditMovement_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceEntry" ADD CONSTRAINT "FinanceEntry_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Saldo de crédito do cliente nunca negativo e devolução nunca maior que a quantidade vendida.
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_creditBalance_nonneg" CHECK ("creditBalance" >= 0);
ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_returnedQty_range" CHECK ("returnedQty" >= 0 AND "returnedQty" <= "qty");
ALTER TABLE "SaleReturnItem" ADD CONSTRAINT "SaleReturnItem_qty_positive" CHECK ("qty" > 0);
ALTER TABLE "CashSessionCount" ADD CONSTRAINT "CashSessionCount_counted_nonneg" CHECK ("counted" >= 0);
