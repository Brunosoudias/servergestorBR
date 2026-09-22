import { BadRequestException, Controller, Get, Injectable, Module, Param, Query } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { type AuthContext, orgOf } from "../common/auth-context";
import { lastMonths, parsePeriod, pct, todayDate } from "../common/dates";
import { Auth, RequirePermission } from "../common/decorators";
import { num } from "../common/money";
import { FinanceModule } from "../finance/finance.module";
import { FinanceService } from "../finance/finance.service";
import { PrismaService } from "../prisma/prisma.service";

const r2 = (v: number) => Math.round(v * 100) / 100;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const PAD = (n: number) => String(n).padStart(6, "0");
const first2 = (s: string) => s.split(" ").slice(0, 2).join(" ");
const SALE_OK: Prisma.SaleWhereInput = { status: { not: "cancelada" } };

export type ReportGroup = "financeiro" | "vendas" | "estoque" | "pdv";
export interface ReportData {
  title: string;
  metrics: { label: string; value: number; kind: "money" | "number" }[];
  chart: { label: string; valor: number }[];
  rows: { name: string; a: string | number; b: string | number }[];
  columns: [string, string, string];
}

@Injectable()
export class InsightsService {
  constructor(private readonly prisma: PrismaService, private readonly finance: FinanceService) {}

  private async netFlow(orgId: string, from: Date, to: Date) {
    const rows = await this.prisma.transaction.groupBy({ by: ["type"], where: { organizationId: orgId, status: "confirmada", date: { gte: from, lte: to } }, _sum: { amount: true } });
    return { inn: num(rows.find((r) => r.type === "entrada")?._sum.amount), out: num(rows.find((r) => r.type === "saida")?._sum.amount) };
  }

  async dashboard(ctx: AuthContext, range = "30d") {
    const orgId = orgOf(ctx);
    await this.finance.ensureDefaults(orgId);
    const p = parsePeriod(range);
    const dateWhere = (from: Date, to: Date) => ({ gte: new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())), lte: new Date(Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())) });
    const [cur, prev, overview, pending, dueCur, duePrev] = await Promise.all([
      this.netFlow(orgId, dateWhere(p.from, p.to).gte, dateWhere(p.from, p.to).lte),
      this.netFlow(orgId, dateWhere(p.prevFrom, p.prevTo).gte, dateWhere(p.prevFrom, p.prevTo).lte),
      this.finance.overview(ctx), this.finance.pendingTotals(orgId),
      this.prisma.financeEntry.groupBy({ by: ["kind"], where: { organizationId: orgId, status: { not: "cancelado" }, dueDate: dateWhere(p.from, p.to) }, _sum: { amount: true } }),
      this.prisma.financeEntry.groupBy({ by: ["kind"], where: { organizationId: orgId, status: { not: "cancelado" }, dueDate: dateWhere(p.prevFrom, p.prevTo) }, _sum: { amount: true } }),
    ]);
    const sum = (rows: typeof dueCur, kind: "pagar" | "receber") => num(rows.find((r) => r.kind === kind)?._sum.amount);
    const saldoAntes = overview.balance - (cur.inn - cur.out);

    const months = lastMonths(6);
    const [salesRows, moves, expenses, sales, paid, newCustomers, newProducts, lowStock, pendingSales, org] = await Promise.all([
      this.prisma.sale.findMany({ where: { organizationId: orgId, ...SALE_OK, createdAt: { gte: months[0].from, lte: months[5].to } }, select: { createdAt: true } }),
      this.prisma.stockMovement.groupBy({ by: ["productId"], where: { organizationId: orgId, createdAt: { gte: p.from, lte: p.to } }, _count: { _all: true }, orderBy: { _count: { productId: "desc" } }, take: 6 }),
      this.prisma.transaction.groupBy({ by: ["category"], where: { organizationId: orgId, type: "saida", status: "confirmada", date: dateWhere(p.from, p.to) }, _sum: { amount: true } }),
      this.prisma.sale.findMany({ where: { organizationId: orgId, ...SALE_OK }, include: { customer: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 4 }),
      this.prisma.financeEntry.findMany({ where: { organizationId: orgId, status: "liquidado" }, orderBy: { settledAt: "desc" }, take: 4 }),
      this.prisma.customer.findMany({ where: { organizationId: orgId, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 4 }),
      this.prisma.product.findMany({ where: { organizationId: orgId, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 4 }),
      this.prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT COUNT(*) AS n FROM "Product" WHERE "organizationId" = ${orgId} AND "deletedAt" IS NULL AND "stock" < "minStock"`),
      this.prisma.sale.count({ where: { organizationId: orgId, status: "pendente" } }),
      this.prisma.organization.findUnique({ where: { id: orgId }, select: { renewsAt: true, subscriptionStatus: true } }),
    ]);
    const names = new Map((await this.prisma.product.findMany({ where: { id: { in: moves.map((m) => m.productId) } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));

    const top = [...expenses].sort((a, b) => num(b._sum.amount) - num(a._sum.amount));
    const exp = top.slice(0, 4).map((e) => ({ name: e.category || "Sem categoria", value: r2(num(e._sum.amount)) }));
    const others = top.slice(4).reduce((a, e) => a + num(e._sum.amount), 0);
    if (others > 0) exp.push({ name: "Outros", value: r2(others) });

    const activity = [
      ...sales.map((s) => ({ id: `s${s.id}`, title: "Venda realizada", subtitle: `${s.customer?.name ?? "Consumidor"} · R$ ${num(s.total).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`, kind: "sale" as const, date: s.createdAt })),
      ...paid.map((e) => ({ id: `e${e.id}`, title: e.kind === "pagar" ? "Conta paga" : "Conta recebida", subtitle: `${e.party} · R$ ${num(e.amount).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`, kind: "payment" as const, date: e.settledAt ?? e.createdAt })),
      ...newCustomers.map((c) => ({ id: `c${c.id}`, title: "Novo cliente", subtitle: c.name, kind: "customer" as const, date: c.createdAt })),
      ...newProducts.map((x) => ({ id: `p${x.id}`, title: "Produto adicionado", subtitle: x.name, kind: "product" as const, date: x.createdAt })),
    ].sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, 4).map((a) => ({ ...a, date: a.date.toISOString() }));

    const due = await this.finance.dueSoon(orgId);
    const lowN = Number(lowStock[0]?.n ?? 0);
    const soon = org?.renewsAt && org.subscriptionStatus !== "cancelled" && org.renewsAt.getTime() - Date.now() < 7 * 86_400_000;
    const alerts = [
      due.dueToday > 0 && { id: "w1", text: `${due.dueToday} conta(s) vencendo hoje`, href: "/finance/payables", tone: "warning" as const },
      lowN > 0 && { id: "w2", text: `${lowN} produto(s) com estoque baixo`, href: "/inventory", tone: "warning" as const },
      due.overdue > 0 && { id: "w3", text: `${due.overdue} conta(s) atrasada(s)`, href: due.overduePayable >= due.overdueReceivable ? "/finance/payables" : "/finance/receivables", tone: "danger" as const },
      pendingSales > 0 && { id: "w4", text: `${pendingSales} venda(s) pendente(s)`, href: "/sales", tone: "info" as const },
      soon && { id: "w5", text: "Assinatura próxima da renovação", href: "/settings/billing", tone: "info" as const },
    ].filter((a): a is NonNullable<typeof a> => !!a);

    return {
      kpis: [
        { key: "receita", label: "Receita", value: r2(cur.inn), delta: pct(cur.inn, prev.inn) },
        { key: "despesa", label: "Despesa", value: r2(cur.out), delta: pct(cur.out, prev.out), invert: true },
        { key: "lucro", label: "Lucro", value: r2(cur.inn - cur.out), delta: pct(cur.inn - cur.out, prev.inn - prev.out) },
        { key: "saldo", label: "Saldo", value: overview.balance, delta: pct(overview.balance, saldoAntes) },
        { key: "receber", label: "A receber", value: pending.receivable, delta: pct(sum(dueCur, "receber"), sum(duePrev, "receber")) },
        { key: "pagar", label: "A pagar", value: pending.payable, delta: pct(sum(dueCur, "pagar"), sum(duePrev, "pagar")), invert: true },
      ],
      cashflow: overview.cashflow.map((c) => ({ label: c.label, receita: c.entradas, despesa: c.saidas, lucro: c.saldo })),
      sales: months.map((m) => ({ label: m.label, vendas: salesRows.filter((s) => s.createdAt >= m.from && s.createdAt <= m.to).length })),
      expenses: exp,
      stock: moves.map((m) => ({ name: first2(names.get(m.productId) ?? "—"), mov: m._count._all })),
      activity, alerts,
    };
  }

  async checklist(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    const [org, customers, products, sales, registers, movements] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { onboarded: true } }),
      this.prisma.customer.count({ where: { organizationId: orgId, deletedAt: null } }),
      this.prisma.product.count({ where: { organizationId: orgId, deletedAt: null } }),
      this.prisma.sale.count({ where: { organizationId: orgId } }),
      this.prisma.cashSession.count({ where: { organizationId: orgId } }),
      this.prisma.stockMovement.count({ where: { organizationId: orgId, reason: { not: "Estoque inicial" } } }),
    ]);
    return [
      { key: "company", label: "Empresa configurada", done: org.onboarded },
      { key: "customer", label: "Primeiro cliente", done: customers > 0, href: "/customers/new" },
      { key: "product", label: "Primeiro produto", done: products > 0, href: "/products/new" },
      { key: "sale", label: "Primeira venda", done: sales > 0, href: "/sales/new" },
      { key: "register", label: "Primeiro caixa", done: registers > 0, href: "/pos/cash-register" },
      { key: "movement", label: "Primeira movimentação", done: movements > 0, href: "/inventory/movements" },
    ];
  }

  async report(ctx: AuthContext, group: string, range = "30d"): Promise<ReportData> {
    const orgId = orgOf(ctx);
    const p = parsePeriod(range);
    const months = lastMonths(6);
    const d = (from: Date, to: Date) => ({ gte: new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())), lte: new Date(Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())) });
    switch (group as ReportGroup) {
      case "financeiro": {
        const [flow, byCat, months6] = await Promise.all([
          this.netFlow(orgId, d(p.from, p.to).gte, d(p.from, p.to).lte),
          this.prisma.transaction.groupBy({ by: ["category", "type"], where: { organizationId: orgId, status: "confirmada", date: d(p.from, p.to) }, _sum: { amount: true } }),
          this.finance.monthlyFlow(orgId),
        ]);
        return { title: "Financeiro", columns: ["Categoria", "Tipo", "Total"],
          metrics: [{ label: "Receitas", value: r2(flow.inn), kind: "money" }, { label: "Despesas", value: r2(flow.out), kind: "money" }, { label: "Lucro", value: r2(flow.inn - flow.out), kind: "money" }],
          chart: months6.map((m) => ({ label: m.label, valor: m.saldo })),
          rows: byCat.map((c) => ({ name: c.category || "Sem categoria", a: c.type === "entrada" ? "Receita" : "Despesa", b: r2(num(c._sum.amount)) })).sort((x, y) => Number(y.b) - Number(x.b)).slice(0, 12) };
      }
      case "vendas": {
        const where: Prisma.SaleWhereInput = { organizationId: orgId, ...SALE_OK, createdAt: { gte: p.from, lte: p.to } };
        const [agg, items, series] = await Promise.all([
          this.prisma.sale.aggregate({ where, _sum: { total: true }, _count: { _all: true } }),
          this.prisma.saleItem.groupBy({ by: ["name"], where: { sale: where }, _sum: { qty: true, total: true }, orderBy: { _sum: { total: "desc" } }, take: 6 }),
          this.prisma.sale.findMany({ where: { organizationId: orgId, ...SALE_OK, createdAt: { gte: months[0].from, lte: months[5].to } }, select: { createdAt: true, total: true } }),
        ]);
        const total = num(agg._sum.total), n = agg._count._all;
        return { title: "Vendas", columns: ["Produto", "Unidades", "Receita"],
          metrics: [{ label: "Total vendido", value: r2(total), kind: "money" }, { label: "Pedidos", value: n, kind: "number" }, { label: "Ticket médio", value: n ? r2(total / n) : 0, kind: "money" }],
          chart: months.map((m) => ({ label: m.label, valor: r2(series.filter((s) => s.createdAt >= m.from && s.createdAt <= m.to).reduce((a, s) => a + num(s.total), 0)) })),
          rows: items.map((i) => ({ name: i.name, a: i._sum.qty ?? 0, b: r2(num(i._sum.total)) })) };
      }
      case "estoque": {
        const [stockSum, outAgg, moved, prods, series] = await Promise.all([
          this.prisma.product.aggregate({ where: { organizationId: orgId, deletedAt: null }, _sum: { stock: true }, _count: { _all: true } }),
          this.prisma.stockMovement.aggregate({ where: { organizationId: orgId, type: "saida", createdAt: { gte: p.from, lte: p.to } }, _sum: { quantity: true } }),
          this.prisma.stockMovement.findMany({ where: { organizationId: orgId, type: "saida", createdAt: { gte: p.from, lte: p.to } }, distinct: ["productId"], select: { productId: true } }),
          this.prisma.product.findMany({ where: { organizationId: orgId, deletedAt: null }, orderBy: { stock: "asc" }, take: 7, select: { name: true, stock: true, minStock: true } }),
          this.prisma.stockMovement.findMany({ where: { organizationId: orgId, type: "saida", createdAt: { gte: months[0].from, lte: months[5].to } }, select: { createdAt: true, quantity: true } }),
        ]);
        const [low] = await this.prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT COUNT(*) AS n FROM "Product" WHERE "organizationId" = ${orgId} AND "deletedAt" IS NULL AND "stock" < "minStock"`);
        const units = stockSum._sum.stock ?? 0;
        return { title: "Estoque", columns: ["Produto", "Estoque", "Mínimo"],
          metrics: [{ label: "Giro médio", value: units ? Math.round(((outAgg._sum.quantity ?? 0) / units) * 10) / 10 : 0, kind: "number" }, { label: "Produtos parados", value: Math.max(0, stockSum._count._all - moved.length), kind: "number" }, { label: "Estoque baixo", value: Number(low.n), kind: "number" }],
          chart: months.map((m) => ({ label: m.label, valor: series.filter((s) => s.createdAt >= m.from && s.createdAt <= m.to).reduce((a, s) => a + s.quantity, 0) })),
          rows: prods.map((x) => ({ name: x.name, a: x.stock, b: x.minStock })) };
      }
      case "pdv": {
        const where: Prisma.SaleWhereInput = { organizationId: orgId, origin: "pdv", createdAt: { gte: p.from, lte: p.to } };
        const [ok, byOp, cancelled, discounted, series] = await Promise.all([
          this.prisma.sale.aggregate({ where: { ...where, ...SALE_OK }, _sum: { total: true }, _count: { _all: true } }),
          this.prisma.sale.groupBy({ by: ["userId", "register"], where: { ...where, ...SALE_OK }, _sum: { total: true }, _count: { _all: true }, orderBy: { _sum: { total: "desc" } }, take: 6 }),
          this.prisma.sale.aggregate({ where: { ...where, status: "cancelada" }, _sum: { total: true }, _count: { _all: true } }),
          this.prisma.sale.aggregate({ where: { ...where, ...SALE_OK, discount: { gt: 0 } }, _sum: { discount: true }, _count: { _all: true } }),
          this.prisma.sale.findMany({ where: { organizationId: orgId, origin: "pdv", ...SALE_OK, createdAt: { gte: months[0].from, lte: months[5].to } }, select: { createdAt: true, total: true } }),
        ]);
        const users = new Map((await this.prisma.user.findMany({ where: { id: { in: byOp.map((o) => o.userId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name.split(" ")[0]]));
        const total = num(ok._sum.total), n = ok._count._all;
        return { title: "PDV", columns: ["Operador / Caixa", "Vendas", "Total"],
          metrics: [{ label: "Total vendido", value: r2(total), kind: "money" }, { label: "Vendas", value: n, kind: "number" }, { label: "Ticket médio", value: n ? r2(total / n) : 0, kind: "money" }],
          chart: months.map((m) => ({ label: m.label, valor: r2(series.filter((s) => s.createdAt >= m.from && s.createdAt <= m.to).reduce((a, s) => a + num(s.total), 0)) })),
          rows: [
            ...byOp.map((o) => ({ name: `${o.userId ? users.get(o.userId) ?? "—" : "—"} · ${o.register ?? "Sem caixa"}`, a: o._count._all, b: r2(num(o._sum.total)) })),
            { name: "Cancelamentos", a: cancelled._count._all, b: r2(num(cancelled._sum.total)) },
            { name: "Descontos", a: discounted._count._all, b: r2(num(discounted._sum.discount)) },
          ] };
      }
      default: throw new BadRequestException("Relatório desconhecido.");
    }
  }

  async search(ctx: AuthContext, q: string) {
    const orgId = orgOf(ctx);
    const s = q.trim().slice(0, 100);
    if (s.length < 2) return [];
    const can = (m: string) => ctx.permissions.includes(`${m}:view`);
    const asNumber = Number(s.replace(/^#/, "")); const numberMatch = Number.isInteger(asNumber) && asNumber > 0 ? asNumber : undefined;
    const ci = { contains: s, mode: "insensitive" as const };
    const [customers, products, sales, entries] = await Promise.all([
      can("customers") ? this.prisma.customer.findMany({ where: { organizationId: orgId, deletedAt: null, OR: [{ name: ci }, { document: { contains: s } }, { email: ci }] }, take: 4 }) : [],
      can("products") ? this.prisma.product.findMany({ where: { organizationId: orgId, deletedAt: null, OR: [{ name: ci }, { sku: ci }, { barcode: { contains: s } }] }, take: 4 }) : [],
      can("sales") ? this.prisma.sale.findMany({ where: { organizationId: orgId, OR: [...(numberMatch ? [{ number: numberMatch }] : []), { customer: { name: ci } }] }, include: { customer: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 4 }) : [],
      can("finance") ? this.prisma.financeEntry.findMany({ where: { organizationId: orgId, OR: [{ party: ci }, { description: ci }] }, orderBy: { dueDate: "desc" }, take: 4 }) : [],
    ]);
    return [
      { title: "Clientes", items: customers.map((c) => ({ id: c.id, label: c.name, sub: c.document, href: `/customers/${c.id}` })) },
      { title: "Produtos", items: products.map((x) => ({ id: x.id, label: x.name, sub: x.sku, href: `/products/${x.id}` })) },
      { title: "Vendas", items: sales.map((v) => ({ id: v.id, label: `Venda #${PAD(v.number)}`, sub: v.customer?.name ?? "Consumidor", href: `/sales/${v.id}` })) },
      { title: "Financeiro", items: entries.map((e) => ({ id: e.id, label: e.description, sub: e.party, href: e.kind === "pagar" ? "/finance/payables" : "/finance/receivables" })) },
    ].filter((g) => g.items.length);
  }
}

@Controller()
export class InsightsController {
  constructor(private readonly svc: InsightsService) {}
  @RequirePermission("dashboard:view") @Get("dashboard/checklist") checklist(@Auth() ctx: AuthContext) { return this.svc.checklist(ctx); }
  @RequirePermission("dashboard:view") @Get("dashboard") dashboard(@Auth() ctx: AuthContext, @Query("range") range?: string) { return this.svc.dashboard(ctx, range); }
  @RequirePermission("reports:view") @Get("reports/:group") report(@Auth() ctx: AuthContext, @Param("group") group: string, @Query("range") range?: string) { return this.svc.report(ctx, group, range); }
  @RequirePermission("dashboard:view") @Get("search") search(@Auth() ctx: AuthContext, @Query("q") q = "") { return this.svc.search(ctx, q); }
}

@Module({ imports: [FinanceModule], controllers: [InsightsController], providers: [InsightsService] })
export class InsightsModule {}
