import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthedRequest } from "../auth-context";
import { ALLOW_EXPIRED, IS_PUBLIC } from "../decorators";
import { effectiveStatus } from "../subscription-state";

const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);

/** Com o teste vencido a empresa continua vendo os dados, mas não grava até assinar. */
@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext) {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (READ_ONLY.has(req.method) || !req.auth?.organizationId) return true;
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_EXPIRED, targets)) return true;
    const org = await this.prisma.organization.findUnique({ where: { id: req.auth.organizationId }, select: { subscriptionStatus: true, trialEndsAt: true } });
    if (org && effectiveStatus(org) === "expired") {
      throw new HttpException({ statusCode: HttpStatus.PAYMENT_REQUIRED, message: "Seu período de teste terminou. Escolha um plano para continuar registrando dados.", code: "trial_expired" }, HttpStatus.PAYMENT_REQUIRED);
    }
    return true;
  }
}
