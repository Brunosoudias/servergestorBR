import { Body, ConflictException, Controller, Get, Injectable, Module, NotFoundException, Param, Patch, Post, Query } from "@nestjs/common";
import { IsBoolean, IsIn, IsOptional } from "class-validator";
import { Prisma, type Marketplace } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { Auth, ClientIp, RequirePermission } from "../common/decorators";
import { cents, fromCents, num } from "../common/money";
import { ListQuery, page, skipTake } from "../common/pagination";
import { FinanceModule } from "../finance/finance.module";
import { FinanceService } from "../finance/finance.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { PrismaService } from "../prisma/prisma.service";
import { padNumber } from "../sales/sale.mapper";

const IDS = ["mercadolivre", "shopee", "amazon", "magalu"] as const;
const NAMES: Record<Marketplace, string> = { mercadolivre: "Mercado Livre", shopee: "Shopee", amazon: "Amazon", magalu: "Magalu Marketplace" };

export class PrefsDto {
  @IsOptional() @IsBoolean() autoStock?: boolean;
  @IsOptional() @IsBoolean() autoOrders?: boolean;
}
export class ToggleListingDto { @IsIn(IDS as unknown as string[], { message: "Marketplace inválido." }) marketplace: Marketplace; }

@Injectable()
export class MarketplacesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly finance: FinanceService, private readonly integrations: IntegrationsService) {}

  private async ensure(orgId: string) {
    if ((await this.prisma.marketplaceConnection.count({ where: { organizationId: orgId } })) < IDS.length) await this.prisma.marketplaceConnection.createMany({ data: IDS.map((marketplace) => ({ organizationId: orgId, marketplace })), skipDuplicates: true });
  }

  private async connDto(orgId: string, m: Marketplace) {
    const [c, listings] = await Promise.all([
      this.prisma.marketplaceConnection.findUniqueOrThrow({ where: { organizationId_marketplace: { organizationId: orgId, marketplace: m } } }),
      this.prisma.productListing.count({ where: { organizationId: orgId, marketplace: m, published: true } }),
    ]);
    return { id: c.marketplace, name: NAMES[c.marketplace], connected: c.connected, account: c.account ?? undefined, lastSync: c.lastSyncAt?.toISOString(), autoStock: c.autoStock, autoOrders: c.autoOrders, listings };
  }

  async connections(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    await this.ensure(orgId);
    return Promise.all(IDS.map((m) => this.connDto(orgId, m)));
  }

  private valid(id: string): Marketplace { if (!(IDS as readonly string[]).includes(id)) throw new NotFoundException(); return id as Marketplace; }

  async connect(ctx: AuthContext, id: string, ip: string) {
    this.integrations.requireSandbox(`A conexão com ${NAMES[this.valid(id)]} (OAuth)`);
    const orgId = orgOf(ctx); const m = this.valid(id);
    await this.ensure(orgId);
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true } });
    await this.prisma.marketplaceConnection.update({ where: { organizationId_marketplace: { organizationId: orgId, marketplace: m } }, data: { connected: true, account: org.name.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 20) || "CONTA", lastSyncAt: new Date(), autoStock: true, autoOrders: true } });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "marketplace.connect", entity: "marketplace", entityId: m, text: `${ctx.user.name} conectou ${NAMES[m]}`, ip });
    return this.connDto(orgId, m);
  }

  async disconnect(ctx: AuthContext, id: string, ip: string) {
    const orgId = orgOf(ctx); const m = this.valid(id);
    await this.ensure(orgId);
    await this.prisma.$transaction([
      this.prisma.marketplaceConnection.update({ where: { organizationId_marketplace: { organizationId: orgId, marketplace: m } }, data: { connected: false, account: null, lastSyncAt: null, autoStock: false, autoOrders: false } }),
      this.prisma.productListing.updateMany({ where: { organizationId: orgId, marketplace: m }, data: { published: false } }),
    ]);
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "marketplace.disconnect", entity: "marketplace", entityId: m, text: `${ctx.user.name} desconectou ${NAMES[m]}`, ip });
    return this.connDto(orgId, m);
  }

  async update(ctx: AuthContext, id: string, dto: PrefsDto, ip: string) {
    const orgId = orgOf(ctx); const m = this.valid(id);
    await this.ensure(orgId);
    const cur = await this.prisma.marketplaceConnection.findUniqueOrThrow({ where: { organizationId_marketplace: { organizationId: orgId, marketplace: m } } });
    if (!cur.connected) throw new ConflictException(`Conecte ${NAMES[m]} antes de alterar as preferências.`);
    await this.prisma.marketplaceConnection.update({ where: { organizationId_marketplace: { organizationId: orgId, marketplace: m } }, data: { autoStock: dto.autoStock, autoOrders: dto.autoOrders } });
    return this.connDto(orgId, m);
  }

  async sync(ctx: AuthContext, id: string, ip: string) {
    this.integrations.requireSandbox(`A sincronização com ${NAMES[this.valid(id)]}`);
    const orgId = orgOf(ctx); const m = this.valid(id);
    await this.ensure(orgId);
    const cur = await this.prisma.marketplaceConnection.findUniqueOrThrow({ where: { organizationId_marketplace: { organizationId: orgId, marketplace: m } } });
    if (!cur.connected) throw new ConflictException(`Conecte ${NAMES[m]} antes de sincronizar.`);
    await this.prisma.marketplaceConnection.update({ where: { organizationId_marketplace: { organizationId: orgId, marketplace: m } }, data: { lastSyncAt: new Date() } });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "marketplace.sync", entity: "marketplace", entityId: m, text: `${ctx.user.name} sincronizou ${NAMES[m]}`, ip });
    return this.connDto(orgId, m);
  }

  private orderDto(o: { id: string; marketplace: Marketplace; number: string; customerName: string; orderedAt: Date; total: Prisma.Decimal; status: string; invoiced: boolean }) {
    return { id: o.id, marketplace: o.marketplace, number: o.number, customer: o.customerName || "Consumidor", date: o.orderedAt.toISOString(), total: num(o.total), status: o.status, invoiced: o.invoiced };
  }

  async orders(ctx: AuthContext, q: ListQuery) {
    const orgId = orgOf(ctx);
    const where: Prisma.MarketplaceOrderWhereInput = {
      organizationId: orgId, ...(q.status && ["novo", "faturado", "enviado", "entregue", "cancelado"].includes(q.status) ? { status: q.status as never } : {}),
      ...(q.search ? { OR: [{ number: { contains: q.search, mode: "insensitive" } }, { customerName: { contains: q.search, mode: "insensitive" } }] } : {}),
    };
    const [rows, total] = await Promise.all([this.prisma.marketplaceOrder.findMany({ where, orderBy: { orderedAt: "desc" }, ...skipTake(q) }), this.prisma.marketplaceOrder.count({ where })]);
    return page(rows.map((o) => this.orderDto(o)), total, q);
  }

  async summary(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    await this.ensure(orgId);
    const [novos, toInvoice, revenue, connected] = await Promise.all([
      this.prisma.marketplaceOrder.count({ where: { organizationId: orgId, status: "novo" } }),
      this.prisma.marketplaceOrder.count({ where: { organizationId: orgId, invoiced: false, status: { not: "cancelado" } } }),
      this.prisma.marketplaceOrder.aggregate({ where: { organizationId: orgId, status: { not: "cancelado" } }, _sum: { total: true } }),
      this.prisma.marketplaceConnection.count({ where: { organizationId: orgId, connected: true } }),
    ]);
    return { newOrders: novos, toInvoice, revenue: num(revenue._sum.total), connected };
  }

  async invoice(ctx: AuthContext, id: string, ip: string) {
    const orgId = orgOf(ctx);
    const order = await this.prisma.$transaction(async (tx) => {
      const r = await tx.marketplaceOrder.updateMany({ where: { id, organizationId: orgId, invoiced: false, status: { not: "cancelado" } }, data: { invoiced: true } });
      if (r.count === 0) {
        const ex = await tx.marketplaceOrder.findFirst({ where: { id, organizationId: orgId } });
        if (!ex) throw new NotFoundException();
        throw new ConflictException(ex.status === "cancelado" ? "Pedido cancelado não pode ser importado." : "Este pedido já foi importado como venda.");
      }
      const o = await tx.marketplaceOrder.findUniqueOrThrow({ where: { id } });
      const counter = await tx.counter.upsert({ where: { organizationId_key: { organizationId: orgId, key: "sale" } }, create: { organizationId: orgId, key: "sale", value: 1 }, update: { value: { increment: 1 } } });
      const total = fromCents(cents(num(o.total)));
      const sale = await tx.sale.create({ data: { organizationId: orgId, number: counter.value, userId: ctx.user.id, origin: "manual", status: "concluida", payment: "outros", subtotal: total, total, register: `${NAMES[o.marketplace]} ${o.number}` } });
      await this.finance.recordSale(tx, orgId, { id: sale.id, number: sale.number, total, methods: ["outros"] });
      return tx.marketplaceOrder.update({ where: { id }, data: { saleId: sale.id, ...(o.status === "novo" ? { status: "faturado" } : {}) } });
    });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "marketplace.invoice", entity: "marketplace_order", entityId: id, text: `${ctx.user.name} importou o pedido ${order.number} como venda`, ip });
    return this.orderDto(order);
  }

  private async listingFor(orgId: string, productId: string) {
    const p = await this.prisma.product.findFirst({ where: { id: productId, organizationId: orgId, deletedAt: null }, include: { listings: true } });
    if (!p) throw new NotFoundException("Produto não encontrado.");
    const published = Object.fromEntries(IDS.map((m) => [m, p.listings.some((l) => l.marketplace === m && l.published)])) as Record<Marketplace, boolean>;
    return { id: p.id, name: p.name, sku: p.sku, price: num(p.price), stock: p.stock, published };
  }

  async listings(ctx: AuthContext, q: ListQuery) {
    const orgId = orgOf(ctx);
    const where: Prisma.ProductWhereInput = { organizationId: orgId, deletedAt: null, ...(q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { sku: { contains: q.search, mode: "insensitive" } }] } : {}) };
    const [rows, total] = await Promise.all([this.prisma.product.findMany({ where, include: { listings: true }, orderBy: { name: "asc" }, ...skipTake(q) }), this.prisma.product.count({ where })]);
    return page(rows.map((p) => ({ id: p.id, name: p.name, sku: p.sku, price: num(p.price), stock: p.stock, published: Object.fromEntries(IDS.map((m) => [m, p.listings.some((l) => l.marketplace === m && l.published)])) })), total, q);
  }

  async togglePublish(ctx: AuthContext, productId: string, marketplace: Marketplace, ip: string) {
    const orgId = orgOf(ctx);
    await this.ensure(orgId);
    const conn = await this.prisma.marketplaceConnection.findUniqueOrThrow({ where: { organizationId_marketplace: { organizationId: orgId, marketplace } } });
    if (!conn.connected) throw new ConflictException(`Conecte ${NAMES[marketplace]} antes de publicar anúncios.`);
    await this.listingFor(orgId, productId);
    const cur = await this.prisma.productListing.findUnique({ where: { productId_marketplace: { productId, marketplace } } });
    await this.prisma.productListing.upsert({ where: { productId_marketplace: { productId, marketplace } }, create: { organizationId: orgId, productId, marketplace, published: true }, update: { published: !cur?.published } });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "marketplace.listing", entity: "product", entityId: productId, text: `${ctx.user.name} ${cur?.published ? "despublicou" : "publicou"} um anúncio em ${NAMES[marketplace]}`, ip });
    return this.listingFor(orgId, productId);
  }
}

@Controller("marketplaces")
export class MarketplacesController {
  constructor(private readonly svc: MarketplacesService) {}
  @RequirePermission("marketplaces:view") @Get() connections(@Auth() ctx: AuthContext) { return this.svc.connections(ctx); }
  @RequirePermission("marketplaces:view") @Get("summary") summary(@Auth() ctx: AuthContext) { return this.svc.summary(ctx); }
  @RequirePermission("marketplaces:view") @Get("orders") orders(@Auth() ctx: AuthContext, @Query() q: ListQuery) { return this.svc.orders(ctx, q); }
  @RequirePermission("marketplaces:view") @Get("listings") listings(@Auth() ctx: AuthContext, @Query() q: ListQuery) { return this.svc.listings(ctx, q); }
  @RequirePermission("marketplaces:edit") @Post("orders/:id/invoice") invoice(@Auth() ctx: AuthContext, @Param("id") id: string, @ClientIp() ip: string) { return this.svc.invoice(ctx, id, ip); }
  @RequirePermission("marketplaces:edit") @Post("listings/:productId/toggle") toggle(@Auth() ctx: AuthContext, @Param("productId") productId: string, @Body() dto: ToggleListingDto, @ClientIp() ip: string) { return this.svc.togglePublish(ctx, productId, dto.marketplace, ip); }
  @RequirePermission("marketplaces:edit") @Post(":id/connect") connect(@Auth() ctx: AuthContext, @Param("id") id: string, @ClientIp() ip: string) { return this.svc.connect(ctx, id, ip); }
  @RequirePermission("marketplaces:edit") @Post(":id/disconnect") disconnect(@Auth() ctx: AuthContext, @Param("id") id: string, @ClientIp() ip: string) { return this.svc.disconnect(ctx, id, ip); }
  @RequirePermission("marketplaces:edit") @Post(":id/sync") sync(@Auth() ctx: AuthContext, @Param("id") id: string, @ClientIp() ip: string) { return this.svc.sync(ctx, id, ip); }
  @RequirePermission("marketplaces:edit") @Patch(":id") update(@Auth() ctx: AuthContext, @Param("id") id: string, @Body() dto: PrefsDto, @ClientIp() ip: string) { return this.svc.update(ctx, id, dto, ip); }
}

@Module({ imports: [FinanceModule], controllers: [MarketplacesController], providers: [MarketplacesService] })
export class MarketplacesModule {}
