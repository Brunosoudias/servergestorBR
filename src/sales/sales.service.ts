import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateIf, ValidateNested } from "class-validator";
import { Prisma as PrismaNS, type Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { todayDate } from "../common/dates";
import { cents, fromCents, num } from "../common/money";
import { type ListQuery, page, skipTake } from "../common/pagination";
import { AutomationsService } from "../automations/automations.service";
import { FinanceService } from "../finance/finance.service";
import { FiscalService } from "../fiscal/fiscal.service";
import { InventoryService } from "../inventory/inventory.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { padNumber, SALE_INCLUDE, SALE_LIST_INCLUDE, saleDto } from "./sale.mapper";

const METHODS = ["dinheiro", "pix", "debito", "credito", "boleto", "outros", "credito_cliente", "fiado"];
const MONEY_MAX = 99_999_999.99;
const emptyToUndef = ({ value }: { value: unknown }) => (value === "" || value === null ? undefined : value);

export class SaleItemInput {
  @IsString() @MaxLength(40) productId: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }, { message: "Quantidade inválida." }) @Min(0.001, { message: "Quantidade deve ser maior que zero." }) @Max(100_000) qty: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) price?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) discount?: number;
}

export class CreateSaleDto {
  @IsOptional() @Transform(emptyToUndef) @IsString() @MaxLength(40) customer?: string;

  @ValidateIf((o: CreateSaleDto) => !o.items) @IsString({ message: "Selecione um produto." }) @MaxLength(40) product?: string;
  @ValidateIf((o: CreateSaleDto) => !o.items) @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }, { message: "Quantidade inválida." }) @Min(0.001) @Max(100_000) qty?: number;
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
  payments?: { method: string; amount: number; installments?: number; received?: number; brand?: string; nsu?: string; authorizationCode?: string; acquirer?: string; status?: "pendente" | "confirmado" }[];
  method?: string;
  installments?: number;
  expectedTotal?: number;
  cashSessionId?: string;
  register?: string;
  allowNegativeStock?: boolean;
  requestId?: string;
  approvedById?: string;
  document?: string | null;
  blockBelowCost?: boolean;
}

export interface CancelOptions {
  reason?: string;
  onCancel?: (tx: Prisma.TransactionClient, sale: Prisma.SaleGetPayload<{ include: typeof SALE_INCLUDE }>) => Promise<void>;
}

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly finance: FinanceService,
    private readonly notifications: NotificationsService, private readonly automations: AutomationsService, private readonly inventory: InventoryService,
    private readonly fiscal: FiscalService,
  ) {}

  private async afterCompleted(orgId: string, s: { number: number; total: number; method: string }, productIds: string[]) {
    const label = `Venda #${padNumber(s.number)} concluída`;
    await this.notifications.notify(orgId, "Venda", label, `R$ ${s.total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })} via ${s.method}.`);
    await this.automations.fire(orgId, "Venda realizada", { title: `${label} — R$ ${s.total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`, amount: s.total });
    if (productIds.length) for (const p of await this.prisma.product.findMany({ where: { id: { in: productIds } }, select: { name: true, stock: true, minStock: true } })) await this.inventory.lowStockAlert(orgId, { name: p.name, stock: num(p.stock), minStock: num(p.minStock) });
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

  async create(ctx: AuthContext, input: CreateSaleDto, ip: string) {
    const lines = input.items?.length ? input.items : [{ productId: input.product!, qty: input.qty!, price: input.price, discount: 0 }];
    if (!ctx.permissions.includes("pos:price")) {
      const ids = [...new Set(lines.filter((l) => l.price !== undefined).map((l) => l.productId))];
      const catalog = new Map((await this.prisma.product.findMany({ where: { id: { in: ids }, organizationId: orgOf(ctx) }, select: { id: true, price: true } })).map((x) => [x.id, cents(num(x.price))]));
      if (lines.some((l) => l.price !== undefined && catalog.has(l.productId) && Math.abs(cents(l.price) - catalog.get(l.productId)!) > 1)) {
        throw new ForbiddenException("Você não tem permissão para alterar o preço do produto. Use o preço do cadastro.");
      }
    }
    return this.place(ctx, { customerId: input.customer, lines, globalDiscount: input.discount, shipping: input.shipping, origin: "manual", status: "pendente", method: input.payment, installments: input.installments }, ip);
  }

  private async byRequestId(orgId: string, requestId?: string) {
    if (!requestId) return null;
    const s = await this.prisma.sale.findUnique({ where: { organizationId_requestId: { organizationId: orgId, requestId } }, include: SALE_INCLUDE });
    return s ? saleDto(s) : null;
  }

  async place(ctx: AuthContext, p: PlaceSale, ip: string) {
    const orgId = orgOf(ctx);
    const repeated = await this.byRequestId(orgId, p.requestId);
    if (repeated) return repeated;
    const customer = p.customerId
      ? await this.prisma.customer.findFirst({ where: { id: p.customerId, organizationId: orgId, deletedAt: null }, select: { id: true, document: true, creditLimit: true } })
      : null;
    if (p.customerId && !customer) throw new BadRequestException("Cliente não encontrado.");
    const ids = [...new Set(p.lines.map((l) => l.productId))];
    const products = await this.prisma.product.findMany({ where: { id: { in: ids }, organizationId: orgId, deletedAt: null, status: "ativo" } });
    if (products.length !== ids.length) throw new BadRequestException("Produto não encontrado ou inativo.");
    const byId = new Map(products.map((x) => [x.id, x]));

    const priced = p.lines.map((l) => {
      const prod = byId.get(l.productId)!;
      const qty = Math.round(l.qty * 1000) / 1000;
      if (qty <= 0) throw new BadRequestException(`Quantidade inválida para ${prod.name}.`);
      if (!prod.fractional && Math.abs(qty - Math.round(qty)) > 0.0005) throw new BadRequestException(`${prod.name} não é vendido por fração. Informe uma quantidade inteira.`);
      const unit = cents(l.price ?? num(prod.price));
      const disc = cents(l.discount ?? 0);
      const gross = Math.round(unit * qty);
      if (disc > gross) throw new BadRequestException(`Desconto maior que o valor do item ${prod.name}.`);
      if (p.blockBelowCost && gross - disc < Math.round(cents(num(prod.cost)) * qty)) throw new BadRequestException(`${prod.name} ficaria abaixo do custo.`);
      return { p: prod, qty, unit, disc, gross, total: gross - disc };
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
    const payments = p.payments?.length
      ? p.payments.map((x) => ({ method: x.method, amount: cents(x.amount), installments: x.installments ?? 1, received: x.method === "dinheiro" && x.received !== undefined ? cents(x.received) : undefined, brand: x.brand, nsu: x.nsu, authorizationCode: x.authorizationCode, acquirer: x.acquirer, status: x.status }))
      : [{ method: p.method ?? "outros", amount: total, installments: p.installments ?? 1, received: undefined as number | undefined, brand: undefined as string | undefined, nsu: undefined as string | undefined, authorizationCode: undefined as string | undefined, acquirer: undefined as string | undefined, status: undefined as "pendente" | "confirmado" | undefined }];
    if (Math.abs(payments.reduce((a, x) => a + x.amount, 0) - total) > 1) throw new BadRequestException("O total dos pagamentos não confere com o valor da venda.");
    if (payments.some((x) => x.received !== undefined && x.received < x.amount)) throw new BadRequestException("Valor recebido em dinheiro menor que o valor a pagar.");
    const storeCredit = payments.filter((x) => x.method === "credito_cliente").reduce((a, x) => a + x.amount, 0);
    if (storeCredit > 0 && !p.customerId) throw new BadRequestException("Selecione o cliente para usar o crédito dele.");
    const onCredit = payments.filter((x) => x.method === "fiado").reduce((a, x) => a + x.amount, 0);
    if (onCredit > 0 && !p.customerId) throw new BadRequestException("Selecione o cliente para vender na carteira.");
    const document = (p.document ?? customer?.document ?? "").replace(/\D/g, "");

    const run = () => this.prisma.$transaction(async (tx) => {
      for (const l of priced) {
        const r = await tx.product.updateMany({ where: { id: l.p.id, organizationId: orgId, ...(p.allowNegativeStock ? {} : { stock: { gte: l.qty } }) }, data: { stock: { decrement: l.qty } } });
        if (r.count === 0) throw new ConflictException(`Estoque insuficiente para ${l.p.name}.`);
      }
      if (storeCredit > 0) {
        const r = await tx.customer.updateMany({ where: { id: p.customerId!, organizationId: orgId, creditBalance: { gte: fromCents(storeCredit) } }, data: { creditBalance: { decrement: fromCents(storeCredit) } } });
        if (r.count === 0) throw new ConflictException("O cliente não tem crédito suficiente.");
      }
      if (onCredit > 0) {
        await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${p.customerId!} FOR UPDATE`;
        const overdue = await tx.financeEntry.findFirst({ where: { organizationId: orgId, kind: "receber", status: "pendente", method: "fiado", dueDate: { lt: todayDate() }, sale: { customerId: p.customerId! } }, select: { id: true } });
        if (overdue) throw new ConflictException("Este cliente tem carteira em atraso. Regularize antes de uma nova venda a prazo.");
        const open = await tx.financeEntry.aggregate({ where: { organizationId: orgId, kind: "receber", status: "pendente", method: "fiado", sale: { customerId: p.customerId! } }, _sum: { amount: true } });
        const notCompleted = await tx.salePayment.aggregate({ where: { method: "fiado", sale: { organizationId: orgId, customerId: p.customerId!, status: "pendente" } }, _sum: { amount: true } });
        const limit = cents(num(customer!.creditLimit));
        const available = Math.max(0, limit - cents(num(open._sum.amount)) - cents(num(notCompleted._sum.amount)));
        if (limit <= 0) throw new BadRequestException("Este cliente não tem limite de carteira cadastrado.");
        if (onCredit > available) throw new ConflictException(`Disponível na carteira: R$ ${fromCents(available).toFixed(2).replace(".", ",")}. Esta venda passa desse valor.`);
      }
      const counter = await tx.counter.upsert({ where: { organizationId_key: { organizationId: orgId, key: "sale" } }, create: { organizationId: orgId, key: "sale", value: 1 }, update: { value: { increment: 1 } } });
      const created = await tx.sale.create({
        data: {
          organizationId: orgId, number: counter.value, customerId: p.customerId ?? null, userId: ctx.user.id, origin: p.origin, status: p.status,
          payment: (payments.length > 1 ? "outros" : payments[0].method) as never, installments: payments.find((x) => x.method === "credito")?.installments ?? 1,
          subtotal: fromCents(subtotal), discount: fromCents(discount), shipping: fromCents(shipping), total: fromCents(total),
          register: p.register ?? null, cashSessionId: p.cashSessionId ?? null, requestId: p.requestId ?? null, approvedById: p.approvedById ?? null, document,
          items: { create: priced.map((l) => ({ productId: l.p.id, name: l.p.name, qty: l.qty, unitPrice: fromCents(l.unit), discount: fromCents(l.disc), total: fromCents(l.total) })) },
          payments: {
            create: payments.map((x) => ({
              method: x.method as never, amount: fromCents(x.amount), installments: x.installments, status: x.status ?? "confirmado",
              brand: x.brand, nsu: x.nsu, authorizationCode: x.authorizationCode, acquirer: x.acquirer,
              ...(x.received !== undefined ? { received: fromCents(x.received), change: fromCents(x.received - x.amount) } : {}),
            })),
          },
        },
        include: SALE_INCLUDE,
      });
      await tx.stockMovement.createMany({ data: priced.map((l) => ({ organizationId: orgId, productId: l.p.id, userId: ctx.user.id, type: "saida" as const, quantity: l.qty, reason: `Venda #${padNumber(created.number)}` })) });
      if (storeCredit > 0) await tx.customerCreditMovement.create({ data: { organizationId: orgId, customerId: p.customerId!, type: "saida", amount: fromCents(storeCredit), description: `Usado na venda #${padNumber(created.number)}`, saleId: created.id, userId: ctx.user.id } });
      if (p.status === "concluida") await this.finance.recordSale(tx, orgId, { id: created.id, number: created.number, payments: payments.map((x) => ({ method: x.method, amount: fromCents(x.amount), installments: x.installments })) });
      return created;
    });
    let sale: Awaited<ReturnType<typeof run>>;
    try {
      sale = await run();
    } catch (e) {
      if (p.requestId && e instanceof PrismaNS.PrismaClientKnownRequestError && e.code === "P2002") {
        const again = await this.byRequestId(orgId, p.requestId);
        if (again) return again;
      }
      throw e;
    }
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: p.origin === "pdv" ? "sale.pdv" : "sale.create", entity: "sale", entityId: sale.id, text: `${ctx.user.name} registrou a venda #${padNumber(sale.number)}${p.origin === "pdv" ? " no PDV" : ""}`, ip });
    if (p.status === "concluida") {
      await this.afterCompleted(orgId, { number: sale.number, total: num(sale.total), method: payments.length > 1 ? "mais de uma forma de pagamento" : payments[0].method }, priced.map((l) => l.p.id));
      if (p.origin === "pdv" && process.env.FISCAL_AUTO_EMIT === "1") await this.fiscal.emitForSale(orgId, sale.id).catch(() => undefined);
    }
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
      await this.finance.recordSale(tx, orgId, { id, number: done.number, payments: done.payments.map((x) => ({ method: x.method, amount: num(x.amount), installments: x.installments })) });
      return done;
    });
    await this.afterCompleted(orgId, { number: s.number, total: num(s.total), method: s.payment }, []);
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "sale.complete", entity: "sale", entityId: id, text: `${ctx.user.name} concluiu a venda #${padNumber(s.number)}`, ip });
    return saleDto(s);
  }

  async cancel(ctx: AuthContext, id: string, ip: string, opts: CancelOptions = {}) {
    const orgId = orgOf(ctx);
    const existing = await this.prisma.sale.findFirst({ where: { id, organizationId: orgId }, select: { origin: true, _count: { select: { returns: true } } } });
    if (!existing) throw new NotFoundException();
    if (existing.origin === "pdv" && !opts.onCancel) throw new ConflictException("Vendas do PDV são canceladas pelo Histórico do PDV, para registrar a devolução no caixa.");
    if (existing._count.returns > 0) throw new ConflictException("Esta venda já tem devolução registrada. Use a devolução para os itens restantes.");
    const sale = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Sale" WHERE id = ${id} FOR UPDATE`;
      if (await tx.saleReturn.count({ where: { saleId: id } })) throw new ConflictException("Esta venda já tem devolução registrada. Use a devolução para os itens restantes.");
      const r = await tx.sale.updateMany({ where: { id, organizationId: orgId, status: { not: "cancelada" } }, data: { status: "cancelada", cancelledAt: new Date(), cancelReason: opts.reason ?? null, cancelledById: ctx.user.id } });
      if (r.count === 0) throw new ConflictException("Esta venda já foi cancelada.");
      const s = await tx.sale.findUniqueOrThrow({ where: { id }, include: SALE_INCLUDE });
      for (const i of s.items) await tx.product.update({ where: { id: i.productId }, data: { stock: { increment: i.qty } } });
      await this.finance.reverseSale(tx, orgId, id, s.number);
      await tx.stockMovement.createMany({ data: s.items.map((i) => ({ organizationId: orgId, productId: i.productId, userId: ctx.user.id, type: "entrada" as const, quantity: i.qty, reason: `Cancelamento da venda #${padNumber(s.number)}` })) });
      const credit = s.payments.filter((x) => x.method === "credito_cliente").reduce((a, x) => a + cents(num(x.amount)), 0);
      if (credit > 0 && s.customerId) {
        await tx.customer.update({ where: { id: s.customerId }, data: { creditBalance: { increment: fromCents(credit) } } });
        await tx.customerCreditMovement.create({ data: { organizationId: orgId, customerId: s.customerId, type: "entrada", amount: fromCents(credit), description: `Estorno do cancelamento da venda #${padNumber(s.number)}`, saleId: s.id, userId: ctx.user.id } });
      }
      if (opts.onCancel) await opts.onCancel(tx, s);
      return s;
    });
    await this.fiscal.cancelForSale(orgId, id, opts.reason ?? "Cancelamento da venda").catch(() => undefined);
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "sale.cancel", entity: "sale", entityId: id, text: `${ctx.user.name} cancelou a venda #${padNumber(sale.number)}${opts.reason ? `: ${opts.reason}` : ""}`, ip });
    await this.automations.fire(orgId, "Venda cancelada", { title: `Venda #${padNumber(sale.number)} cancelada`, amount: num(sale.total) });
    return saleDto(sale);
  }
}
