import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateIf, ValidateNested } from "class-validator";
import type { Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { cents, fromCents, num } from "../common/money";
import { type ListQuery, page, skipTake } from "../common/pagination";
import { AutomationsService } from "../automations/automations.service";
import { FinanceService } from "../finance/finance.service";
import { InventoryService } from "../inventory/inventory.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { padNumber, SALE_INCLUDE, SALE_LIST_INCLUDE, saleDto } from "./sale.mapper";

const METHODS = ["dinheiro", "pix", "debito", "credito", "boleto", "outros"];
const MONEY_MAX = 99_999_999.99;
const emptyToUndef = ({ value }: { value: unknown }) => (value === "" || value === null ? undefined : value);

export class SaleItemInput {
  @IsString() @MaxLength(40) productId: string;
  @Type(() => Number) @IsInt({ message: "Quantidade inválida." }) @Min(1, { message: "Quantidade deve ser no mínimo 1." }) @Max(100_000) qty: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) price?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) discount?: number;
}

export class CreateSaleDto {
  @IsOptional() @Transform(emptyToUndef) @IsString() @MaxLength(40) customer?: string;

  @ValidateIf((o: CreateSaleDto) => !o.items) @IsString({ message: "Selecione um produto." }) @MaxLength(40) product?: string;
  @ValidateIf((o: CreateSaleDto) => !o.items) @Type(() => Number) @IsInt({ message: "Quantidade inválida." }) @Min(1) @Max(100_000) qty?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) price?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => SaleItemInput) items?: SaleItemInput[];

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) discount?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) shipping?: number;
  @IsIn(METHODS, { message: "Forma de pagamento inválida." }) payment: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(24) installments?: number;
}

export interface PlaceSale {
  customerId?: string | null;
  lines: { productId: string; qty: number; price?: number; discount?: number }[];
  globalDiscount?: number;
  totalDiscount?: number;
  shipping?: number;
  origin: "pdv" | "manual";
  status: "pendente" | "concluida";
  payments?: { method: string; amount: number; installments?: number }[];
  method?: string;
  installments?: number;
  expectedTotal?: number;
  cashSessionId?: string;
  register?: string;
}

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly finance: FinanceService,
    private readonly notifications: NotificationsService, private readonly automations: AutomationsService, private readonly inventory: InventoryService,
  ) {}

  private async afterCompleted(orgId: string, s: { number: number; total: number; method: string }, productIds: string[]) {
    const label = `Venda #${padNumber(s.number)} concluída`;
    await this.notifications.notify(orgId, "Venda", label, `R$ ${s.total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} via ${s.method}.`);
    await this.automations.fire(orgId, "Venda realizada", { title: `${label} — R$ ${s.total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`, amount: s.total });
    if (productIds.length) for (const p of await this.prisma.product.findMany({ where: { id: { in: productIds } }, select: { name: true, stock: true, minStock: true } })) await this.inventory.lowStockAlert(orgId, p);
  }

  async list(ctx: AuthContext, q: ListQuery, origin?: "pdv" | "manual") {
    const n = q.search && /^\d{1,9}$/.test(q.search) ? Number(q.search) : null;
    const where: Prisma.SaleWhereInput = {
      organizationId: orgOf(ctx),
      ...(origin ? { origin } : {}),
      ...(q.status && q.status !== "all" ? { status: q.status as never } : {}),
      ...(q.search ? { OR: [...(n !== null ? [{ number: n }] : []), { customer: { name: { contains: q.search, mode: "insensitive" as const } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.sale.findMany({ where, include: SALE_LIST_INCLUDE, orderBy: { createdAt: "desc" }, ...skipTake(q) }),
      this.prisma.sale.count({ where }),
    ]);
    return page(rows.map(saleDto), total, q);
  }

  async summary(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    const [done, orders] = await Promise.all([
      this.prisma.sale.aggregate({ where: { organizationId: orgId, status: "concluida" }, _sum: { total: true }, _count: true }),
      this.prisma.sale.count({ where: { organizationId: orgId } }),
    ]);
    const total = num(done._sum.total);
    return { total, orders, average: done._count ? total / done._count : 0 };
  }

  async get(ctx: AuthContext, id: string) {
    const s = await this.prisma.sale.findFirst({ where: { id, organizationId: orgOf(ctx) }, include: SALE_INCLUDE });
    if (!s) throw new NotFoundException();
    return saleDto(s);
  }

  create(ctx: AuthContext, input: CreateSaleDto, ip: string) {
    const lines = input.items?.length ? input.items : [{ productId: input.product!, qty: input.qty!, price: input.price, discount: 0 }];
    return this.place(ctx, { customerId: input.customer, lines, globalDiscount: input.discount, shipping: input.shipping, origin: "manual", status: "pendente", method: input.payment, installments: input.installments }, ip);
  }

  async place(ctx: AuthContext, p: PlaceSale, ip: string) {
    const orgId = orgOf(ctx);
    if (p.customerId && !(await this.prisma.customer.findFirst({ where: { id: p.customerId, organizationId: orgId, deletedAt: null }, select: { id: true } }))) {
      throw new BadRequestException("Cliente não encontrado.");
    }
    const ids = [...new Set(p.lines.map((l) => l.productId))];
    const products = await this.prisma.product.findMany({ where: { id: { in: ids }, organizationId: orgId, deletedAt: null, status: "ativo" } });
    if (products.length !== ids.length) throw new BadRequestException("Produto não encontrado ou inativo.");
    const byId = new Map(products.map((x) => [x.id, x]));

    const priced = p.lines.map((l) => {
      const prod = byId.get(l.productId)!;
      const unit = cents(l.price ?? num(prod.price));
      const disc = cents(l.discount ?? 0);
      const gross = unit * l.qty;
      if (disc > gross) throw new BadRequestException(`Desconto maior que o valor do item ${prod.name}.`);
      return { p: prod, qty: l.qty, unit, disc, gross, total: gross - disc };
    });
    const gross = priced.reduce((a, l) => a + l.gross, 0);
    const lineDisc = priced.reduce((a, l) => a + l.disc, 0);
    const subtotal = gross - lineDisc;
    const discount = p.totalDiscount !== undefined ? Math.max(0, Math.min(gross, cents(p.totalDiscount)) - lineDisc) : cents(p.globalDiscount ?? 0);
    const shipping = cents(p.shipping ?? 0);
    if (discount > subtotal) throw new BadRequestException("O desconto não pode ser maior que o subtotal.");
    const total = subtotal - discount + shipping;

    if (p.expectedTotal !== undefined && Math.abs(cents(p.expectedTotal) - total) > 1) {
      throw new ConflictException("Os valores da venda mudaram (preço ou desconto). Revise o carrinho e tente novamente.");
    }
    const payments = p.payments?.length ? p.payments.map((x) => ({ method: x.method, amount: cents(x.amount), installments: x.installments ?? 1 })) : [{ method: p.method ?? "outros", amount: total, installments: p.installments ?? 1 }];
    if (Math.abs(payments.reduce((a, x) => a + x.amount, 0) - total) > 1) throw new BadRequestException("O total dos pagamentos não confere com o valor da venda.");

    const sale = await this.prisma.$transaction(async (tx) => {
      for (const l of priced) {
        const r = await tx.product.updateMany({ where: { id: l.p.id, organizationId: orgId, stock: { gte: l.qty } }, data: { stock: { decrement: l.qty } } });
        if (r.count === 0) throw new ConflictException(`Estoque insuficiente para ${l.p.name}.`);
      }
      const counter = await tx.counter.upsert({ where: { organizationId_key: { organizationId: orgId, key: "sale" } }, create: { organizationId: orgId, key: "sale", value: 1 }, update: { value: { increment: 1 } } });
      const created = await tx.sale.create({
        data: {
          organizationId: orgId, number: counter.value, customerId: p.customerId ?? null, userId: ctx.user.id, origin: p.origin, status: p.status,
          payment: (payments.length > 1 ? "outros" : payments[0].method) as never, installments: payments.find((x) => x.method === "credito")?.installments ?? 1,
          subtotal: fromCents(subtotal), discount: fromCents(discount), shipping: fromCents(shipping), total: fromCents(total),
          register: p.register ?? null, cashSessionId: p.cashSessionId ?? null,
          items: { create: priced.map((l) => ({ productId: l.p.id, name: l.p.name, qty: l.qty, unitPrice: fromCents(l.unit), discount: fromCents(l.disc), total: fromCents(l.total) })) },
          payments: { create: payments.map((x) => ({ method: x.method as never, amount: fromCents(x.amount), installments: x.installments })) },
        },
        include: SALE_INCLUDE,
      });
      await tx.stockMovement.createMany({ data: priced.map((l) => ({ organizationId: orgId, productId: l.p.id, userId: ctx.user.id, type: "saida" as const, quantity: l.qty, reason: `Venda #${padNumber(created.number)}` })) });
      if (p.status === "concluida") await this.finance.recordSale(tx, orgId, { id: created.id, number: created.number, total: fromCents(total), methods: payments.map((x) => x.method) });
      return created;
    });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: p.origin === "pdv" ? "sale.pdv" : "sale.create", entity: "sale", entityId: sale.id, text: `${ctx.user.name} registrou a venda #${padNumber(sale.number)}${p.origin === "pdv" ? " no PDV" : ""}`, ip });
    if (p.status === "concluida") await this.afterCompleted(orgId, { number: sale.number, total: num(sale.total), method: payments.length > 1 ? "mais de uma forma de pagamento" : payments[0].method }, priced.map((l) => l.p.id));
    return saleDto(sale);
  }

  async complete(ctx: AuthContext, id: string, ip: string) {
    const orgId = orgOf(ctx);
    const s = await this.prisma.$transaction(async (tx) => {
      const r = await tx.sale.updateMany({ where: { id, organizationId: orgId, status: "pendente" }, data: { status: "concluida" } });
      if (r.count === 0) {
        const exists = await tx.sale.findFirst({ where: { id, organizationId: orgId }, select: { status: true } });
        if (!exists) throw new NotFoundException();
        throw new ConflictException("Apenas vendas pendentes podem ser concluídas.");
      }
      const done = await tx.sale.findUniqueOrThrow({ where: { id }, include: SALE_INCLUDE });
      await this.finance.recordSale(tx, orgId, { id, number: done.number, total: num(done.total), methods: done.payments.map((x) => x.method) });
      return done;
    });
    await this.afterCompleted(orgId, { number: s.number, total: num(s.total), method: s.payment }, []);
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "sale.complete", entity: "sale", entityId: id, text: `${ctx.user.name} concluiu a venda #${padNumber(s.number)}`, ip });
    return saleDto(s);
  }

  async cancel(ctx: AuthContext, id: string, ip: string) {
    const orgId = orgOf(ctx);
    const sale = await this.prisma.$transaction(async (tx) => {
      const r = await tx.sale.updateMany({ where: { id, organizationId: orgId, status: { not: "cancelada" } }, data: { status: "cancelada", cancelledAt: new Date() } });
      if (r.count === 0) {
        const exists = await tx.sale.findFirst({ where: { id, organizationId: orgId }, select: { id: true } });
        if (!exists) throw new NotFoundException();
        throw new ConflictException("Esta venda já foi cancelada.");
      }
      const s = await tx.sale.findUniqueOrThrow({ where: { id }, include: SALE_INCLUDE });
      for (const i of s.items) await tx.product.update({ where: { id: i.productId }, data: { stock: { increment: i.qty } } });
      await this.finance.reverseSale(tx, orgId, id, s.number);
      await tx.stockMovement.createMany({ data: s.items.map((i) => ({ organizationId: orgId, productId: i.productId, userId: ctx.user.id, type: "entrada" as const, quantity: i.qty, reason: `Cancelamento da venda #${padNumber(s.number)}` })) });
      return s;
    });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "sale.cancel", entity: "sale", entityId: id, text: `${ctx.user.name} cancelou a venda #${padNumber(sale.number)}`, ip });
    await this.automations.fire(orgId, "Venda cancelada", { title: `Venda #${padNumber(sale.number)} cancelada`, amount: num(sale.total) });
    return saleDto(sale);
  }
}
