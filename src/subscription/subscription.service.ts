import { Body, Controller, Get, Injectable, Module, Post } from "@nestjs/common";
import { IsIn } from "class-validator";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { AllowExpired, Auth, ClientIp, RequirePermission } from "../common/decorators";
import { PLAN_LIMITS, type PlanId } from "../common/plans";
import { effectiveStatus, trialDaysLeft } from "../common/subscription-state";
import { IntegrationsService } from "../integrations/integrations.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../uploads/storage.service";

export { PLAN_LIMITS, type PlanId };
export const TRIAL_DAYS = 14;

export class CheckoutDto { @IsIn(Object.keys(PLAN_LIMITS), { message: "Plano inválido." }) planId: PlanId; }

@Injectable()
export class SubscriptionService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly integrations: IntegrationsService, private readonly storage: StorageService) {}

  async current(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    const [users, products, customers, bytes] = await Promise.all([
      this.prisma.membership.count({ where: { organizationId: orgId, status: { not: "inativo" } } }),
      this.prisma.product.count({ where: { organizationId: orgId, deletedAt: null } }),
      this.prisma.customer.count({ where: { organizationId: orgId, deletedAt: null } }),
      this.storage.usedBytes(orgId),
    ]);
    const lim = PLAN_LIMITS[org.plan];
    return {
      planId: org.plan, status: effectiveStatus(org), trialDaysLeft: trialDaysLeft(org), cancelAtPeriodEnd: org.cancelAtPeriodEnd,
      nextBilling: (org.renewsAt ?? org.trialEndsAt ?? new Date()).toISOString().slice(0, 10),
      usage: {
        users: [users, lim.users], products: [products, lim.products], customers: [customers, lim.customers],
        storage: [Math.round((bytes / 1024 ** 3) * 100) / 100, lim.storageGb],
      } as Record<string, [number, number | null]>,
    };
  }

  async checkout(ctx: AuthContext, planId: PlanId, ip: string) {
    this.integrations.requireSandbox("O pagamento (gateway)");
    const orgId = orgOf(ctx);
    const renew = new Date(Date.now() + 30 * 86_400_000);
    await this.prisma.organization.update({ where: { id: orgId }, data: { plan: planId, subscriptionStatus: "active", cancelAtPeriodEnd: false, renewsAt: renew } });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "subscription.change", entity: "organization", entityId: orgId, text: `${ctx.user.name} alterou o plano para ${planId}`, ip });
    return { checkoutUrl: null as string | null, planId };
  }

  async cancel(ctx: AuthContext, ip: string) {
    const orgId = orgOf(ctx);
    await this.prisma.organization.update({ where: { id: orgId }, data: { cancelAtPeriodEnd: true } });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "subscription.cancel", entity: "organization", entityId: orgId, text: `${ctx.user.name} cancelou a assinatura ao fim do ciclo`, ip });
    return { ok: true };
  }
}

@Controller("subscription")
export class SubscriptionController {
  constructor(private readonly svc: SubscriptionService) {}
  @RequirePermission("settings:view") @Get() current(@Auth() ctx: AuthContext) { return this.svc.current(ctx); }
  @AllowExpired() @RequirePermission("settings:edit") @Post("checkout") checkout(@Auth() ctx: AuthContext, @Body() dto: CheckoutDto, @ClientIp() ip: string) { return this.svc.checkout(ctx, dto.planId, ip); }
  @AllowExpired() @RequirePermission("settings:edit") @Post("cancel") cancel(@Auth() ctx: AuthContext, @ClientIp() ip: string) { return this.svc.cancel(ctx, ip); }
}

@Module({ controllers: [SubscriptionController], providers: [SubscriptionService] })
export class SubscriptionModule {}
