-- Senha definida pelo superadmin: o usuário troca no primeiro acesso.
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
