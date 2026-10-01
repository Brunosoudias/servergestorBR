import type { Logger } from "@nestjs/common";
import { randomBytes } from "crypto";
import { hostname } from "os";
import type { PrismaService } from "../prisma/prisma.service";

const INSTANCE = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;

/** Tenta assumir o job por `ttlMs`. Só uma instância consegue enquanto a concessão anterior não vencer. */
export async function acquireLease(prisma: PrismaService, name: string, ttlMs: number) {
  // Horário calculado no próprio Postgres: relógios diferentes entre instâncias não afetam a concessão.
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    INSERT INTO "JobLease" ("name", "owner", "lockedUntil") VALUES (${name}, ${INSTANCE}, now() + make_interval(secs => ${ttlMs / 1000}))
    ON CONFLICT ("name") DO UPDATE SET "owner" = EXCLUDED."owner", "lockedUntil" = EXCLUDED."lockedUntil"
    WHERE "JobLease"."lockedUntil" < now()
    RETURNING "name"`;
  return rows.length === 1;
}

/**
 * Agenda `run` a cada `everyMs` em todas as instâncias, mas executa em uma só por ciclo.
 * Retorna a função que cancela o agendamento.
 */
export function scheduleJob(prisma: PrismaService, log: Logger, name: string, everyMs: number, run: () => Promise<unknown>) {
  if (process.env.NODE_ENV === "test") return () => undefined;
  const ttl = Math.max(1000, everyMs - 1000);
  const tick = async () => {
    try { if (await acquireLease(prisma, name, ttl)) await run(); }
    catch (e) { log.error(`Falha no job ${name}: ${(e as Error).message}`); }
  };
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
