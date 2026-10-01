import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "./common/decorators";
import { PrismaService } from "./prisma/prisma.service";

const startedAt = new Date();

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: o processo responde (não depende do banco, para o orquestrador não reiniciar em queda do Postgres). */
  @Public() @SkipThrottle() @Get("live")
  live() { return { status: "ok", uptimeSeconds: Math.round(process.uptime()), startedAt: startedAt.toISOString() }; }

  /** Readiness: pronto para receber tráfego (banco acessível). */
  @Public() @SkipThrottle() @Get()
  async check() {
    const t = Date.now();
    try { await this.prisma.$queryRaw`SELECT 1`; return { status: "ok", database: { latencyMs: Date.now() - t } }; }
    catch { throw new ServiceUnavailableException("Banco de dados indisponível."); }
  }
}
