-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trial', 'active', 'cancelled');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('banco', 'caixa', 'carteira', 'investimento');

-- CreateEnum
CREATE TYPE "CategoryType" AS ENUM ('receita', 'despesa');

-- CreateEnum
CREATE TYPE "EntryKind" AS ENUM ('pagar', 'receber');

-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('pendente', 'liquidado', 'cancelado');

-- CreateEnum
CREATE TYPE "TxType" AS ENUM ('entrada', 'saida');

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('confirmada', 'pendente');

-- CreateEnum
CREATE TYPE "AutomationStatus" AS ENUM ('ativa', 'pausada', 'erro');

-- CreateEnum
CREATE TYPE "FiscalEnvironment" AS ENUM ('homologacao', 'producao');

-- CreateEnum
CREATE TYPE "TaxRegime" AS ENUM ('simples', 'presumido', 'real');

-- CreateEnum
CREATE TYPE "FiscalType" AS ENUM ('nfe', 'nfce');

-- CreateEnum
CREATE TYPE "FiscalStatus" AS ENUM ('autorizada', 'pendente', 'rejeitada', 'cancelada');

-- CreateEnum
CREATE TYPE "PixKeyType" AS ENUM ('cnpj', 'email', 'telefone', 'aleatoria');

-- CreateEnum
CREATE TYPE "PixStatus" AS ENUM ('ativa', 'paga', 'expirada', 'cancelada');

-- CreateEnum
CREATE TYPE "BankLineStatus" AS ENUM ('pendente', 'conciliado', 'ignorado');

-- CreateEnum
CREATE TYPE "Marketplace" AS ENUM ('mercadolivre', 'shopee', 'amazon', 'magalu');

-- CreateEnum
CREATE TYPE "MarketplaceOrderStatus" AS ENUM ('novo', 'faturado', 'enviado', 'entregue', 'cancelado');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "renewsAt" TIMESTAMP(3),
ADD COLUMN     "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'trial',
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceCategory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CategoryType" NOT NULL,

    CONSTRAINT "FinanceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "EntryKind" NOT NULL,
    "party" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "amount" DECIMAL(14,2) NOT NULL,
    "dueDate" DATE NOT NULL,
    "method" TEXT NOT NULL DEFAULT '',
    "status" "EntryStatus" NOT NULL DEFAULT 'pendente',
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" "TxType" NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "TxStatus" NOT NULL DEFAULT 'confirmada',
    "entryId" TEXT,
    "saleId" TEXT,
    "pixChargeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "readBy" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Automation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "condition" TEXT NOT NULL DEFAULT 'Sempre',
    "action" TEXT NOT NULL,
    "status" "AutomationStatus" NOT NULL DEFAULT 'ativa',
    "lastRunAt" TIMESTAMP(3),
    "runs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalSettings" (
    "organizationId" TEXT NOT NULL,
    "environment" "FiscalEnvironment" NOT NULL DEFAULT 'homologacao',
    "regime" "TaxRegime" NOT NULL DEFAULT 'simples',
    "nfeSeries" TEXT NOT NULL DEFAULT '1',
    "nfceSeries" TEXT NOT NULL DEFAULT '1',
    "cscId" TEXT NOT NULL DEFAULT '',
    "cscTokenEnc" TEXT NOT NULL DEFAULT '',
    "certName" TEXT,
    "certExpiresAt" DATE,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalSettings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "FiscalNote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "type" "FiscalType" NOT NULL,
    "number" INTEGER NOT NULL,
    "series" TEXT NOT NULL DEFAULT '1',
    "key" TEXT NOT NULL,
    "protocol" TEXT,
    "status" "FiscalStatus" NOT NULL DEFAULT 'pendente',
    "rejectReason" TEXT,
    "total" DECIMAL(14,2) NOT NULL,
    "customerName" TEXT NOT NULL DEFAULT '',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FiscalNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PixSettings" (
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL DEFAULT '',
    "keyType" "PixKeyType" NOT NULL DEFAULT 'cnpj',
    "merchantName" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PixSettings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "PixCharge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "txid" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "customerName" TEXT NOT NULL DEFAULT '',
    "amount" DECIMAL(14,2) NOT NULL,
    "payload" TEXT NOT NULL,
    "status" "PixStatus" NOT NULL DEFAULT 'ativa',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PixCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bank" TEXT NOT NULL,
    "account" TEXT NOT NULL DEFAULT '',
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),

    CONSTRAINT "BankConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT,
    "date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" "BankLineStatus" NOT NULL DEFAULT 'pendente',
    "matchText" TEXT,
    "transactionId" TEXT,
    "suggestedTransactionId" TEXT,
    "suggestionScore" INTEGER,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "account" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "autoStock" BOOLEAN NOT NULL DEFAULT false,
    "autoOrders" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "MarketplaceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceOrder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "number" TEXT NOT NULL,
    "customerName" TEXT NOT NULL DEFAULT '',
    "total" DECIMAL(14,2) NOT NULL,
    "status" "MarketplaceOrderStatus" NOT NULL DEFAULT 'novo',
    "invoiced" BOOLEAN NOT NULL DEFAULT false,
    "saleId" TEXT,
    "orderedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductListing" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProductListing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_organizationId_name_key" ON "Account"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceCategory_organizationId_name_key" ON "FinanceCategory"("organizationId", "name");

-- CreateIndex
CREATE INDEX "FinanceEntry_organizationId_kind_status_idx" ON "FinanceEntry"("organizationId", "kind", "status");

-- CreateIndex
CREATE INDEX "FinanceEntry_organizationId_dueDate_idx" ON "FinanceEntry"("organizationId", "dueDate");

-- CreateIndex
CREATE INDEX "Transaction_organizationId_date_idx" ON "Transaction"("organizationId", "date");

-- CreateIndex
CREATE INDEX "Transaction_accountId_idx" ON "Transaction"("accountId");

-- CreateIndex
CREATE INDEX "Notification_organizationId_createdAt_idx" ON "Notification"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Automation_organizationId_status_idx" ON "Automation"("organizationId", "status");

-- CreateIndex
CREATE INDEX "FiscalNote_organizationId_status_idx" ON "FiscalNote"("organizationId", "status");

-- CreateIndex
CREATE INDEX "FiscalNote_saleId_idx" ON "FiscalNote"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalNote_organizationId_type_series_number_key" ON "FiscalNote"("organizationId", "type", "series", "number");

-- CreateIndex
CREATE INDEX "PixCharge_organizationId_status_idx" ON "PixCharge"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PixCharge_organizationId_txid_key" ON "PixCharge"("organizationId", "txid");

-- CreateIndex
CREATE UNIQUE INDEX "BankConnection_organizationId_bank_key" ON "BankConnection"("organizationId", "bank");

-- CreateIndex
CREATE UNIQUE INDEX "BankLine_transactionId_key" ON "BankLine"("transactionId");

-- CreateIndex
CREATE INDEX "BankLine_organizationId_status_idx" ON "BankLine"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BankLine_organizationId_externalId_key" ON "BankLine"("organizationId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceConnection_organizationId_marketplace_key" ON "MarketplaceConnection"("organizationId", "marketplace");

-- CreateIndex
CREATE INDEX "MarketplaceOrder_organizationId_status_idx" ON "MarketplaceOrder"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceOrder_organizationId_marketplace_number_key" ON "MarketplaceOrder"("organizationId", "marketplace", "number");

-- CreateIndex
CREATE INDEX "ProductListing_organizationId_idx" ON "ProductListing"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductListing_productId_marketplace_key" ON "ProductListing"("productId", "marketplace");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceCategory" ADD CONSTRAINT "FinanceCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceEntry" ADD CONSTRAINT "FinanceEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "FinanceEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalSettings" ADD CONSTRAINT "FiscalSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalNote" ADD CONSTRAINT "FiscalNote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalNote" ADD CONSTRAINT "FiscalNote_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PixSettings" ADD CONSTRAINT "PixSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PixCharge" ADD CONSTRAINT "PixCharge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankConnection" ADD CONSTRAINT "BankConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankLine" ADD CONSTRAINT "BankLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankLine" ADD CONSTRAINT "BankLine_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BankConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankLine" ADD CONSTRAINT "BankLine_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceConnection" ADD CONSTRAINT "MarketplaceConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceOrder" ADD CONSTRAINT "MarketplaceOrder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductListing" ADD CONSTRAINT "ProductListing_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductListing" ADD CONSTRAINT "ProductListing_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
