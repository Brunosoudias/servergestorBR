/**
 * Cria (ou promove) o superadmin da plataforma: acesso de owner em todas as empresas.
 * Uso: SUPERADMIN_EMAIL=... SUPERADMIN_PASSWORD=... SUPERADMIN_NAME="..." npm run db:superadmin
 * Se o e-mail já existir, o usuário é promovido e a senha é trocada.
 * Os poderes de superadmin exigem verificação em duas etapas: se ainda não estiver ativa, o script
 * ativa e imprime o segredo/URL otpauth para cadastrar no app autenticador.
 */
import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { loadEnv } from "../src/config/env";
import { encryptSecret } from "../src/common/secret";
import { generateTotpSecret, otpauthUrl } from "../src/common/totp";
import { createPrismaAdapter } from "../src/prisma/prisma-adapter";

const prisma = new PrismaClient({ adapter: createPrismaAdapter() });
const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{14,72}$/;

async function main() {
  const env = loadEnv();
  const email = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD ?? "";
  const name = process.env.SUPERADMIN_NAME?.trim() || "Superadmin";
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new Error("Defina SUPERADMIN_EMAIL com um e-mail válido.");
  if (!PASSWORD_RULE.test(password)) throw new Error("Defina SUPERADMIN_PASSWORD com 14 a 72 caracteres, com letras e números.");

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { email },
    update: { isSuperAdmin: true, passwordHash, mustChangePassword: false, failedAttempts: 0, lockedUntil: null },
    create: { email, name, passwordHash, isSuperAdmin: true },
    include: { memberships: true },
  });
  // Sessões abertas antes da promoção/troca de senha não podem herdar os poderes de superadmin.
  const { count: ended } = await prisma.session.deleteMany({ where: { userId: user.id } });
  if (ended) console.log(`${ended} sessão(ões) aberta(s) encerrada(s).`);

  if (!user.memberships.length && !(await prisma.organization.count())) {
    await prisma.organization.create({
      data: { name: "BRCoder", email, onboarded: true, subscriptionStatus: "active", memberships: { create: { userId: user.id, role: "owner", status: "ativo" } } },
    });
  }

  if (!user.mfaEnabledAt) {
    const secret = generateTotpSecret();
    await prisma.user.update({ where: { id: user.id }, data: { mfaSecretEnc: encryptSecret(secret, env.secretsKey), mfaEnabledAt: new Date(), mfaLastStep: 0 } });
    console.log("Verificação em duas etapas ativada. Cadastre no app autenticador (Google Authenticator, Authy, 1Password...):");
    console.log(`  Segredo: ${secret}`);
    console.log(`  URL:     ${otpauthUrl("Gestor Br", user.email, secret)}`);
  }
  console.log(`Superadmin pronto: ${user.email}`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
