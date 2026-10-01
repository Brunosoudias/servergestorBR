import { Body, ConflictException, Controller, Get, Injectable, Module, NotFoundException, Param, Post, Put, Query } from "@nestjs/common";
import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
import type { PixCharge, PixSettings as PixSettingsRow, Prisma } from "@prisma/client";
import { randomInt } from "crypto";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { Auth, ClientIp, RequirePermission } from "../common/decorators";
import { num } from "../common/money";
import { ListQuery, page, skipTake } from "../common/pagination";
import { buildPixPayload } from "../common/pix";
import { FinanceModule } from "../finance/finance.module";
import { FinanceService } from "../finance/finance.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class ChargeDto {
  @Transform(trim) @IsString() @MinLength(2, { message: "Informe a descrição." }) @MaxLength(140) description: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) customer?: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01, { message: "Informe o valor." }) @Max(99_999_999.99) amount: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(60 * 24 * 30) expiresInMinutes: number;
}
export class PixSettingsDto {
  @Transform(trim) @IsString() @MinLength(3, { message: "Informe a chave PIX." }) @MaxLength(77) key: string;
  @IsIn(["cnpj", "email", "telefone", "aleatoria"]) keyType: "cnpj" | "email" | "telefone" | "aleatoria";
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(25) merchantName: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(15) city: string;
}

@Injectable()
export class PixService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly finance: FinanceService, private readonly integrations: IntegrationsService, private readonly notifications: NotificationsService) {}

  private async settingsRow(orgId: string): Promise<PixSettingsRow> {
    const cur = await this.prisma.pixSettings.findUnique({ where: { organizationId: orgId } });
    if (cur) return cur;
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    return this.prisma.pixSettings.upsert({ where: { organizationId: orgId }, create: { organizationId: orgId, key: (org.cnpj ?? "").replace(/\D/g, ""), keyType: "cnpj", merchantName: org.name.slice(0, 25), city: (org.city || "Sao Paulo").slice(0, 15) }, update: {} });
  }
  private settingsDto(s: PixSettingsRow) { return { key: s.key, keyType: s.keyType, merchantName: s.merchantName, city: s.city }; }
  async settings(ctx: AuthContext) { return { ...this.settingsDto(await this.settingsRow(orgOf(ctx))), sandbox: this.integrations.sandbox }; }

  async saveSettings(ctx: AuthContext, dto: PixSettingsDto, ip: string) {
    const orgId = orgOf(ctx);
    const s = await this.prisma.pixSettings.upsert({ where: { organizationId: orgId }, create: { organizationId: orgId, ...dto }, update: dto });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "pix.settings", entity: "pix_settings", entityId: orgId, text: `${ctx.user.name} atualizou a chave PIX`, ip });
    return { ...this.settingsDto(s), sandbox: this.integrations.sandbox };
  }

  private dto(c: PixCharge) {
    return { id: c.id, txid: c.txid, description: c.description, customer: c.customerName || "Consumidor", amount: num(c.amount), createdAt: c.createdAt.toISOString(), expiresAt: c.expiresAt.toISOString(), status: c.status, payload: c.payload };
  }

  private expireOld(orgId: string) {
    return this.prisma.pixCharge.updateMany({ where: { organizationId: orgId, status: "ativa", expiresAt: { lt: new Date() } }, data: { status: "expirada" } });
  }

  async summary(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    await this.expireOld(orgId);
    const rows = await this.prisma.pixCharge.groupBy({ by: ["status"], where: { organizationId: orgId }, _count: { _all: true }, _sum: { amount: true } });
    const g = (s: string) => rows.find((r) => r.status === s);
    return { received: num(g("paga")?._sum.amount), pending: num(g("ativa")?._sum.amount), paidCount: g("paga")?._count._all ?? 0, activeCount: g("ativa")?._count._all ?? 0 };
  }

  async list(ctx: AuthContext, q: ListQuery) {
    const orgId = orgOf(ctx);
    await this.expireOld(orgId);
    const where: Prisma.PixChargeWhereInput = {
      organizationId: orgId, ...(q.status && ["ativa", "paga", "expirada", "cancelada"].includes(q.status) ? { status: q.status as never } : {}),
      ...(q.search ? { OR: [{ txid: { contains: q.search, mode: "insensitive" } }, { description: { contains: q.search, mode: "insensitive" } }, { customerName: { contains: q.search, mode: "insensitive" } }] } : {}),
    };
    const [rows, total] = await Promise.all([this.prisma.pixCharge.findMany({ where, orderBy: { createdAt: "desc" }, ...skipTake(q) }), this.prisma.pixCharge.count({ where })]);
    return page(rows.map((c) => this.dto(c)), total, q);
  }

  async create(ctx: AuthContext, dto: ChargeDto, ip: string) {
    const orgId = orgOf(ctx);
    const s = await this.settingsRow(orgId);
    if (!s.key) throw new ConflictException("Cadastre a chave PIX da empresa antes de cobrar.");
    const txid = `BRS${Date.now().toString().slice(-8)}${randomInt(100000, 999999)}`;
    const c = await this.prisma.pixCharge.create({
      data: { organizationId: orgId, txid, description: dto.description, customerName: dto.customer ?? "", amount: dto.amount, expiresAt: new Date(Date.now() + dto.expiresInMinutes * 60_000), payload: buildPixPayload({ key: s.key, name: s.merchantName, city: s.city, amount: dto.amount, txid }) },
    });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "pix.create", entity: "pix_charge", entityId: c.id, text: `${ctx.user.name} criou a cobrança PIX ${txid}`, ip });
    return this.dto(c);
  }

  async cancel(ctx: AuthContext, id: string, ip: string) {
    const orgId = orgOf(ctx);
    const r = await this.prisma.pixCharge.updateMany({ where: { id, organizationId: orgId, status: "ativa" }, data: { status: "cancelada" } });
    if (r.count === 0) { if (!(await this.prisma.pixCharge.findFirst({ where: { id, organizationId: orgId }, select: { id: true } }))) throw new NotFoundException(); throw new ConflictException("Só cobranças ativas podem ser canceladas."); }
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "pix.cancel", entity: "pix_charge", entityId: id, text: `${ctx.user.name} cancelou uma cobrança PIX`, ip });
    return this.dto(await this.prisma.pixCharge.findUniqueOrThrow({ where: { id } }));
  }

  async markPaid(orgId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.pixCharge.updateMany({ where: { id, organizationId: orgId, status: "ativa" }, data: { status: "paga", paidAt: new Date() } });
      if (r.count === 0) { if (!(await tx.pixCharge.findFirst({ where: { id, organizationId: orgId }, select: { id: true } }))) throw new NotFoundException(); throw new ConflictException("Só cobranças ativas podem ser pagas."); }
      const c = await tx.pixCharge.findUniqueOrThrow({ where: { id } });
      await this.finance.recordMovement(tx, orgId, { type: "entrada", description: `PIX ${c.txid}${c.customerName ? ` — ${c.customerName}` : ""}`, category: "Vendas", amount: num(c.amount), pixChargeId: c.id });
      return c;
    });
  }

  async simulatePayment(ctx: AuthContext, id: string, ip: string) {
    this.integrations.requireSandbox("O provedor de PIX (PSP)");
    const orgId = orgOf(ctx);
    const c = await this.markPaid(orgId, id);
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "pix.paid", entity: "pix_charge", entityId: id, text: `Pagamento PIX ${c.txid} confirmado (simulado)`, ip });
    await this.notifications.notify(orgId, "Financeiro", "PIX recebido", `${c.description}: R$ ${num(c.amount).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`);
    return this.dto(c);
  }
}

@Controller("pix")
export class PixController {
  constructor(private readonly svc: PixService) {}
  @RequirePermission("finance:view") @Get("settings") settings(@Auth() ctx: AuthContext) { return this.svc.settings(ctx); }
  @RequirePermission("finance:edit") @Put("settings") save(@Auth() ctx: AuthContext, @Body() dto: PixSettingsDto, @ClientIp() ip: string) { return this.svc.saveSettings(ctx, dto, ip); }
  @RequirePermission("finance:view") @Get("summary") summary(@Auth() ctx: AuthContext) { return this.svc.summary(ctx); }
  @RequirePermission("finance:view") @Get("charges") list(@Auth() ctx: AuthContext, @Query() q: ListQuery) { return this.svc.list(ctx, q); }
  @RequirePermission("finance:create") @Post("charges") create(@Auth() ctx: AuthContext, @Body() dto: ChargeDto, @ClientIp() ip: string) { return this.svc.create(ctx, dto, ip); }
  @RequirePermission("finance:edit") @Post("charges/:id/cancel") cancel(@Auth() ctx: AuthContext, @Param("id") id: string, @ClientIp() ip: string) { return this.svc.cancel(ctx, id, ip); }
  @RequirePermission("finance:edit") @Post("charges/:id/simulate-payment") simulate(@Auth() ctx: AuthContext, @Param("id") id: string, @ClientIp() ip: string) { return this.svc.simulatePayment(ctx, id, ip); }
}

@Module({ imports: [FinanceModule], controllers: [PixController], providers: [PixService], exports: [PixService] })
export class PixModule {}
