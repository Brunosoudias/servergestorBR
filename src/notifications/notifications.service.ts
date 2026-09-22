import { Body, Controller, Get, Global, Injectable, Module, NotFoundException, Param, Post } from "@nestjs/common";
import type { AuthContext } from "../common/auth-context";
import { orgOf } from "../common/auth-context";
import { Auth, RequirePermission } from "../common/decorators";
import { PrismaService } from "../prisma/prisma.service";

export const NOTIFICATION_CATEGORIES = ["Financeiro", "Estoque", "Venda", "PDV", "Automação", "Sistema", "Segurança"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async notify(organizationId: string, category: NotificationCategory, title: string, body = "") {
    try { await this.prisma.notification.create({ data: { organizationId, category, title: title.slice(0, 160), body: body.slice(0, 500) } }); }
    catch { /* notificação nunca derruba a operação principal */ }
  }

  async list(ctx: AuthContext) {
    const rows = await this.prisma.notification.findMany({ where: { organizationId: orgOf(ctx) }, orderBy: { createdAt: "desc" }, take: 100 });
    return rows.map((n) => ({ id: n.id, category: n.category, title: n.title, body: n.body, date: n.createdAt.toISOString(), read: n.readBy.includes(ctx.user.id) }));
  }

  async markRead(ctx: AuthContext, id: string) {
    const n = await this.prisma.notification.findFirst({ where: { id, organizationId: orgOf(ctx) }, select: { id: true, readBy: true } });
    if (!n) throw new NotFoundException();
    if (!n.readBy.includes(ctx.user.id)) await this.prisma.notification.update({ where: { id }, data: { readBy: { push: ctx.user.id } } });
  }

  async markAllRead(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    const unread = await this.prisma.notification.findMany({ where: { organizationId: orgId, NOT: { readBy: { has: ctx.user.id } } }, select: { id: true } });
    await this.prisma.$transaction(unread.map((n) => this.prisma.notification.update({ where: { id: n.id }, data: { readBy: { push: ctx.user.id } } })));
  }
}

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}
  @RequirePermission("dashboard:view") @Get() list(@Auth() ctx: AuthContext) { return this.svc.list(ctx); }
  @RequirePermission("dashboard:view") @Post("read-all") async readAll(@Auth() ctx: AuthContext) { await this.svc.markAllRead(ctx); }
  @RequirePermission("dashboard:view") @Post(":id/read") async read(@Auth() ctx: AuthContext, @Param("id") id: string) { await this.svc.markRead(ctx, id); }
}

@Global()
@Module({ controllers: [NotificationsController], providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
