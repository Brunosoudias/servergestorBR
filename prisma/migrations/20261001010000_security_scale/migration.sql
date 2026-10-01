-- CNPJ: vazio vira NULL e o valor preenchido passa a ser único.
ALTER TABLE "Organization" ALTER COLUMN "cnpj" DROP NOT NULL, ALTER COLUMN "cnpj" DROP DEFAULT;
UPDATE "Organization" SET "cnpj" = NULL WHERE "cnpj" = '';

DO $$
DECLARE dup text;
BEGIN
  SELECT string_agg(c, ', ') INTO dup FROM (SELECT "cnpj" AS c FROM "Organization" WHERE "cnpj" IS NOT NULL GROUP BY "cnpj" HAVING count(*) > 1) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'Há empresas com CNPJ duplicado (%). Corrija ou limpe o CNPJ das duplicadas antes de aplicar esta migração.', dup;
  END IF;
END $$;

CREATE UNIQUE INDEX "Organization_cnpj_key" ON "Organization"("cnpj");

-- Uso de armazenamento por empresa (cota do plano).
ALTER TABLE "Organization" ADD COLUMN "storageBytes" BIGINT NOT NULL DEFAULT 0;

-- Códigos de recuperação do 2FA (hash SHA-256).
ALTER TABLE "User" ADD COLUMN "mfaRecoveryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Dispositivos já usados no login (alerta de novo dispositivo).
CREATE TABLE "UserDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceHash" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL DEFAULT '',
    "lastIp" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserDevice_userId_deviceHash_key" ON "UserDevice"("userId", "deviceHash");
ALTER TABLE "UserDevice" ADD CONSTRAINT "UserDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
