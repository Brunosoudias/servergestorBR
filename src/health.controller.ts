import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "./common/decorators";
import { PrismaService } from "./prisma/prisma.service";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public() @SkipThrottle() @Get()
  async check() {
    try { await this.prisma.$queryRaw`SELECT 1`; return { status: "ok" }; }
    catch { throw new ServiceUnavailableException("Banco de dados indisponível."); }
  }
}
