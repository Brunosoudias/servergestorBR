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

export async function registerFailure(prisma: PrismaService, user: Pick<User, "id" | "failedAttempts">) {
  const failed = user.failedAttempts + 1;
  await prisma.user.update({
    where: { id: user.id },
    data: failed >= MAX_FAILED ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000) } : { failedAttempts: failed },
  });
  return failed;
}

export async function clearFailures(prisma: PrismaService, user: Pick<User, "id" | "failedAttempts" | "lockedUntil">) {
  if (user.failedAttempts || user.lockedUntil) await prisma.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null } });
}
