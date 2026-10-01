import { randomBytes } from "crypto";
import * as bcrypt from "bcryptjs";
import type { User } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";

export const BCRYPT_COST = 12;
export const MAX_FAILED = 5;
export const LOCK_MINUTES = 15;
export const DUMMY_HASH = bcrypt.hashSync(randomBytes(12).toString("hex"), BCRYPT_COST);

export const isLocked = (u: Pick<User, "lockedUntil"> | null | undefined) => !!u?.lockedUntil && u.lockedUntil > new Date();

/** Compara sempre com algum hash, para o tempo de resposta não revelar se o usuário existe. */
export async function passwordMatches(user: Pick<User, "passwordHash"> | null | undefined, password: string) {
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  return ok && !!user?.passwordHash;
}

/** Incremento atômico: tentativas em paralelo não podem ler o mesmo contador e escapar do bloqueio. */
export async function registerFailure(prisma: PrismaService, user: Pick<User, "id">) {
  const [row] = await prisma.$queryRaw<{ failed: number }[]>`
    UPDATE "User" u SET
      "failedAttempts" = CASE WHEN u."failedAttempts" + 1 >= ${MAX_FAILED}::int THEN 0 ELSE u."failedAttempts" + 1 END,
      "lockedUntil"    = CASE WHEN u."failedAttempts" + 1 >= ${MAX_FAILED}::int THEN (now() AT TIME ZONE 'UTC') + make_interval(mins => ${LOCK_MINUTES}::int) ELSE u."lockedUntil" END
    FROM (SELECT "id", "failedAttempts" FROM "User" WHERE "id" = ${user.id} FOR UPDATE) prev
    WHERE u."id" = prev."id"
    RETURNING prev."failedAttempts" + 1 AS failed`;
  return row?.failed ?? 0;
}

export async function clearFailures(prisma: PrismaService, user: Pick<User, "id" | "failedAttempts" | "lockedUntil">) {
  if (user.failedAttempts || user.lockedUntil) await prisma.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null } });
}
