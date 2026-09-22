import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Transform, Type } from "class-transformer";
import { IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from "class-validator";
import { type AccountType, type EntryKind, Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { lastMonths, todayDate } from "../common/dates";
import { num } from "../common/money";
import { type ListQuery, page, skipTake } from "../common/pagination";
import { AutomationsService } from "../automations/automations.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const MONEY_MAX = 99_999_999.99;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export class EntryDto {
  @Transform(trim) @IsString() @MinLength(2, { message: "Informe o nome." }) @MaxLength(120) party: string;
  @Transform(trim) @IsString() @MinLength(2, { message: "Informe a descrição." }) @MaxLength(200) description: string;
  @Transform(trim) @IsString() @MinLength(1, { message: "Selecione a categoria." }) @MaxLength(80) category: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01, { message: "Informe o valor." }) @Max(MONEY_MAX) amount: number;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "Informe o vencimento." }) dueDate: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) method?: string;
}

const STATUS_LABEL = { pagar: "pago", receber: "recebido" } as const;
export function entryStatus(kind: EntryKind, status: string, dueDate: Date, today = todayDate()) {
  if (status === "liquidado") return STATUS_LABEL[kind];
  if (status === "cancelado") return "cancelado";
  return dueDate < today ? "vencido" : "pendente";
}

const DEFAULT_CATEGORIES: [string, "receita" | "despesa"][] = [
  ["Vendas", "receita"], ["Serviços", "receita"], ["Fornecedores", "despesa"], ["Utilidades", "despesa"], ["Aluguel", "despesa"], ["Marketing", "despesa"],
];
const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = { banco: "Conta bancária", caixa: "Caixa", carteira: "Carteira digital", investimento: "Investimento" };

type Db = Prisma.TransactionClient | PrismaService;

@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService,
    private readonly notifications: NotificationsService, private readonly automations: AutomationsService,
  ) {}

  async ensureDefaults(orgId: string, db: Db = this.prisma) {
    if ((await db.account.count({ where: { organizationId: orgId } })) === 0) {
      await db.account.createMany({ data: [{ organizationId: orgId, name: "Caixa da Loja", type: "caixa" }], skipDuplicates: true });
    }
    if ((await db.financeCategory.count({ where: { organizationId: orgId } })) === 0) {
      await db.financeCategory.createMany({ data: DEFAULT_CATEGORIES.map(([name, type]) => ({ organizationId: orgId, name, type })), skipDuplicates: true });
    }
  }

  private async accountFor(db: Db, orgId: string, cashOnly: boolean) {
    const accs = await db.account.findMany({ where: { organizationId: orgId, active: true }, orderBy: { createdAt: "asc" } });
    const cash = accs.find((a) => a.type === "caixa");
    const bank = accs.find((a) => a.type === "banco" || a.type === "carteira");
    const chosen = cashOnly ? cash ?? bank : bank ?? cash;
    if (!chosen) throw new ConflictException("Nenhuma conta financeira ativa. Cadastre uma conta para registrar recebimentos.");
    return chosen;
  }

  async recordSale(db: Db, orgId: string, s: { id: string; number: number; total: number; methods: string[] }) {
    await this.ensureDefaults(orgId, db);
    const acc = await this.accountFor(db, orgId, s.methods.length > 0 && s.methods.every((m) => m === "dinheiro"));
    await db.transaction.create({ data: { organizationId: orgId, accountId: acc.id, date: todayDate(), type: "entrada", description: `Venda #${String(s.number).padStart(6, "0")}`, category: "Vendas", amount: s.total, saleId: s.id } });
  }

  async recordMovement(db: Db, orgId: string, m: { type: "entrada" | "saida"; description: string; category: string; amount: number; date?: Date; pixChargeId?: string }) {
    await this.ensureDefaults(orgId, db);
    const acc = await this.accountFor(db, orgId, false);
    return db.transaction.create({ data: { organizationId: orgId, accountId: acc.id, date: m.date ?? todayDate(), type: m.type, description: m.description, category: m.category, amount: m.amount, pixChargeId: m.pixChargeId } });
  }

  async reverseSale(db: Db, orgId: string, saleId: string, number: number) {
    const original = await db.transaction.findFirst({ where: { organizationId: orgId, saleId, type: "entrada" }, orderBy: { createdAt: "asc" } });
    if (!original) return;
    await db.transaction.create({ data: { organizationId: orgId, accountId: original.accountId, date: todayDate(), type: "saida", description: `Estorno da venda #${String(number).padStart(6, "0")}`, category: "Vendas", amount: original.amount, saleId } });
  }

  private async balances(orgId: string) {
    const [accs, sums] = await Promise.all([
      this.prisma.account.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "asc" } }),
      this.prisma.transaction.groupBy({ by: ["accountId", "type"], where: { organizationId: orgId, status: "confirmada" }, _sum: { amount: true }, _max: { date: true } }),
    ]);
    return accs.map((a) => {
      const rows = sums.filter((x) => x.accountId === a.id);
      const inn = num(rows.find((x) => x.type === "entrada")?._sum.amount);
      const out = num(rows.find((x) => x.type === "saida")?._sum.amount);
      const last = rows.map((x) => x._max.date).filter((d): d is Date => !!d).sort((x, y) => y.getTime() - x.getTime())[0];
      return { a, balance: Math.round((num(a.openingBalance) + inn - out) * 100) / 100, last };
    });
  }

  async accounts(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    await this.ensureDefaults(orgId);
    return (await this.balances(orgId)).map(({ a, balance, last }) => ({ id: a.id, name: a.name, type: ACCOUNT_TYPE_LABEL[a.type], balance, status: a.active ? "ativa" : "inativa", lastMovement: iso(last ?? a.createdAt) }));
  }

  async categories(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    await this.ensureDefaults(orgId);
    const rows = await this.prisma.financeCategory.findMany({ where: { organizationId: orgId }, orderBy: [{ type: "asc" }, { name: "asc" }] });
    return rows.map((c) => ({ id: c.id, name: c.name, type: c.type === "receita" ? "Receita" : "Despesa" }));
  }

  private entryDto(e: { id: string; kind: EntryKind; party: string; description: string; category: string; amount: Prisma.Decimal; dueDate: Date; method: string; status: string }) {
    return { id: e.id, party: e.party, description: e.description, category: e.category, amount: num(e.amount), dueDate: iso(e.dueDate), method: e.method, status: entryStatus(e.kind, e.status, e.dueDate) };
  }

  private statusWhere(kind: EntryKind, status?: string): Prisma.FinanceEntryWhereInput {
    const today = todayDate();
    switch (status) {
      case "pendente": return { status: "pendente", dueDate: { gte: today } };
      case "vencido": return { status: "pendente", dueDate: { lt: today } };
      case "pago": case "recebido": return { status: "liquidado" };
      case "cancelado": return { status: "cancelado" };
      default: return {};
    }
  }

  async listEntries(ctx: AuthContext, kind: EntryKind, q: ListQuery) {
    const orgId = orgOf(ctx);
    const where: Prisma.FinanceEntryWhereInput = {
      organizationId: orgId, kind, ...this.statusWhere(kind, q.status),
      ...(q.search ? { OR: [{ party: { contains: q.search, mode: "insensitive" } }, { description: { contains: q.search, mode: "insensitive" } }, { category: { contains: q.search, mode: "insensitive" } }] } : {}),
    };
    const [rows, total] = await Promise.all([this.prisma.financeEntry.findMany({ where, orderBy: [{ dueDate: "desc" }, { createdAt: "desc" }], ...skipTake(q) }), this.prisma.financeEntry.count({ where })]);
    return page(rows.map((e) => this.entryDto(e)), total, q);
  }

  async createEntry(ctx: AuthContext, kind: EntryKind, dto: EntryDto, ip: string) {
    const orgId = orgOf(ctx);
    await this.ensureDefaults(orgId);
    const e = await this.prisma.financeEntry.create({ data: { organizationId: orgId, kind, party: dto.party, description: dto.description, category: dto.category, amount: dto.amount, dueDate: new Date(`${dto.dueDate}T00:00:00.000Z`), method: dto.method ?? "" } });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: kind === "pagar" ? "payable.create" : "receivable.create", entity: "finance_entry", entityId: e.id, text: `${ctx.user.name} criou ${kind === "pagar" ? "a despesa" : "a receita"} "${e.description}"`, ip });
    return this.entryDto(e);
  }

  async settle(ctx: AuthContext, kind: EntryKind, id: string, ip: string) {
    const orgId = orgOf(ctx);
    const e = await this.prisma.$transaction(async (tx) => {
      const r = await tx.financeEntry.updateMany({ where: { id, organizationId: orgId, kind, status: "pendente" }, data: { status: "liquidado", settledAt: new Date() } });
      if (r.count === 0) {
        const exists = await tx.financeEntry.findFirst({ where: { id, organizationId: orgId, kind }, select: { id: true } });
        if (!exists) throw new NotFoundException();
        throw new ConflictException("Este lançamento não está pendente.");
      }
      const entry = await tx.financeEntry.findUniqueOrThrow({ where: { id } });
      await this.ensureDefaults(orgId, tx);
      const acc = await this.accountFor(tx, orgId, false);
      await tx.transaction.create({ data: { organizationId: orgId, accountId: acc.id, date: todayDate(), type: kind === "pagar" ? "saida" : "entrada", description: entry.description, category: entry.category, amount: entry.amount, entryId: entry.id } });
      return entry;
    });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: kind === "pagar" ? "payable.settle" : "receivable.settle", entity: "finance_entry", entityId: id, text: `${ctx.user.name} marcou "${e.description}" como ${kind === "pagar" ? "paga" : "recebida"}`, ip });
    if (kind === "receber") await this.automations.fire(orgId, "Conta recebida", { title: `${e.description} — ${e.party}`, amount: num(e.amount) });
    return this.entryDto(e);
  }

  async transactions(ctx: AuthContext, q: ListQuery) {
    const orgId = orgOf(ctx);
    const where: Prisma.TransactionWhereInput = {
      organizationId: orgId, ...(q.status === "entrada" || q.status === "saida" ? { type: q.status } : {}),
      ...(q.search ? { OR: [{ description: { contains: q.search, mode: "insensitive" } }, { category: { contains: q.search, mode: "insensitive" } }, { account: { name: { contains: q.search, mode: "insensitive" } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.transaction.findMany({ where, include: { account: true }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], ...skipTake(q) }),
      this.prisma.transaction.count({ where }),
    ]);
    return page(rows.map((t) => ({ id: t.id, date: iso(t.date), description: t.description, category: t.category, account: t.account.name, type: t.type, amount: num(t.amount), status: t.status })), total, q);
  }

  async pendingTotals(orgId: string) {
    const rows = await this.prisma.financeEntry.groupBy({ by: ["kind"], where: { organizationId: orgId, status: "pendente" }, _sum: { amount: true } });
    return { payable: num(rows.find((r) => r.kind === "pagar")?._sum.amount), receivable: num(rows.find((r) => r.kind === "receber")?._sum.amount) };
  }

  async monthlyFlow(orgId: string, months = 6) {
    const span = lastMonths(months);
    const rows = await this.prisma.transaction.findMany({ where: { organizationId: orgId, status: "confirmada", date: { gte: span[0].from, lte: span[span.length - 1].to } }, select: { date: true, type: true, amount: true } });
    return span.map((m) => {
      const inRange = rows.filter((r) => r.date >= m.from && r.date <= m.to);
      const entradas = inRange.filter((r) => r.type === "entrada").reduce((a, r) => a + num(r.amount), 0);
      const saidas = inRange.filter((r) => r.type === "saida").reduce((a, r) => a + num(r.amount), 0);
      return { label: m.label, entradas: Math.round(entradas * 100) / 100, saidas: Math.round(saidas * 100) / 100, saldo: Math.round((entradas - saidas) * 100) / 100 };
    });
  }

  async overview(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    await this.ensureDefaults(orgId);
    const [bal, pending, cashflow] = await Promise.all([this.balances(orgId), this.pendingTotals(orgId), this.monthlyFlow(orgId)]);
    return { balance: Math.round(bal.filter((b) => b.a.active).reduce((a, b) => a + b.balance, 0) * 100) / 100, payable: pending.payable, receivable: pending.receivable, cashflow };
  }

  async walletSummary(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    await this.ensureDefaults(orgId);
    const [bal, pending, sums] = await Promise.all([
      this.balances(orgId), this.pendingTotals(orgId),
      this.prisma.transaction.groupBy({ by: ["type"], where: { organizationId: orgId, status: "confirmada" }, _sum: { amount: true } }),
    ]);
    const available = Math.round(bal.filter((b) => b.a.active).reduce((a, b) => a + b.balance, 0) * 100) / 100;
    return {
      available, pending: pending.receivable,
      received: num(sums.find((s) => s.type === "entrada")?._sum.amount), spent: num(sums.find((s) => s.type === "saida")?._sum.amount),
      projected: Math.round((available + pending.receivable - pending.payable) * 100) / 100,
    };
  }

  async walletStatement(ctx: AuthContext, q: ListQuery) {
    const orgId = orgOf(ctx);
    await this.ensureDefaults(orgId);
    const opening = num((await this.prisma.account.aggregate({ where: { organizationId: orgId }, _sum: { openingBalance: true } }))._sum.openingBalance);
    const like = q.search ? `%${q.search.replace(/[%_\\]/g, "\\$&")}%` : null;
    const rows = await this.prisma.$queryRaw<{ id: string; date: Date; description: string; inn: Prisma.Decimal; out: Prisma.Decimal; balance: Prisma.Decimal }[]>(Prisma.sql`
      SELECT * FROM (
        SELECT t."id", t."date", t."description",
               CASE WHEN t."type" = 'entrada' THEN t."amount" ELSE 0 END AS inn,
               CASE WHEN t."type" = 'saida' THEN t."amount" ELSE 0 END AS out,
               ${opening}::numeric + SUM(CASE WHEN t."type" = 'entrada' THEN t."amount" ELSE -t."amount" END)
                 OVER (ORDER BY t."date", t."createdAt", t."id") AS balance,
               t."createdAt"
        FROM "Transaction" t WHERE t."organizationId" = ${orgId} AND t."status" = 'confirmada'
      ) x WHERE ${like}::text IS NULL OR x."description" ILIKE ${like}
      ORDER BY x."date" DESC, x."createdAt" DESC, x."id" DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`);
    const total = await this.prisma.transaction.count({ where: { organizationId: orgId, status: "confirmada", ...(q.search ? { description: { contains: q.search, mode: "insensitive" } } : {}) } });
    return page(rows.map((r) => ({ id: r.id, date: iso(r.date), description: r.description, in: num(r.inn), out: num(r.out), balance: Math.round(num(r.balance) * 100) / 100 })), total, q);
  }

  async dueSoon(orgId: string) {
    const today = todayDate();
    const [dueToday, overduePay, overdueRec] = await Promise.all([
      this.prisma.financeEntry.count({ where: { organizationId: orgId, kind: "pagar", status: "pendente", dueDate: today } }),
      this.prisma.financeEntry.count({ where: { organizationId: orgId, kind: "pagar", status: "pendente", dueDate: { lt: today } } }),
      this.prisma.financeEntry.count({ where: { organizationId: orgId, kind: "receber", status: "pendente", dueDate: { lt: today } } }),
    ]);
    return { dueToday, overdue: overduePay + overdueRec, overduePayable: overduePay, overdueReceivable: overdueRec };
  }
}
