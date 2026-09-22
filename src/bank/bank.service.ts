import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, Module, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { Transform } from "class-transformer";
import { IsString, MaxLength, MinLength } from "class-validator";
import { createHash } from "crypto";
import { Prisma, type BankLine } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { Auth, ClientIp, RequirePermission } from "../common/decorators";
import { num } from "../common/money";
import { ListQuery, page, skipTake } from "../common/pagination";
import { FinanceModule } from "../finance/finance.module";
import { FinanceService } from "../finance/finance.service";
import { IntegrationsService } from "../integrations/integrations.service";
import { PrismaService } from "../prisma/prisma.service";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const CATALOG = ["Itaú", "Nubank PJ", "Bradesco", "Banco do Brasil"];
export const MAX_IMPORT_CHARS = 2_000_000;
export const MAX_IMPORT_LINES = 5000;

export class ImportDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) fileName: string;
  @IsString({ message: "O arquivo está vazio." }) @MinLength(10, { message: "O arquivo está vazio." }) @MaxLength(MAX_IMPORT_CHARS, { message: "O arquivo é grande demais (máximo de 2 MB)." }) content: string;
}
export class CreateEntryDto { @Transform(trim) @IsString() @MinLength(1, { message: "Selecione a categoria." }) @MaxLength(80) category: string; }

export interface ParsedLine { date: Date; description: string; amount: number; externalId: string; }

const dateOnly = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
function parseDate(s: string): Date | null {
  s = s.trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  if (m) return dateOnly(+m[1], +m[2], +m[3]);
  m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  return m ? dateOnly(+m[3], +m[2], +m[1]) : null;
}
function parseAmount(s: string): number | null {
  let t = s.trim().replace(/[R$\s]/g, "");
  if (!t) return null;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", "."); 
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
const fingerprint = (d: Date, desc: string, amt: number, n: number) => createHash("sha1").update(`${d.toISOString().slice(0, 10)}|${desc}|${amt}|${n}`).digest("hex").slice(0, 24);

export function parseStatement(content: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  if (/<STMTTRN>/i.test(content)) {
    for (const block of content.split(/<STMTTRN>/i).slice(1)) {
      const tag = (n: string) => new RegExp(`<${n}>([^<\\r\\n]*)`, "i").exec(block)?.[1]?.trim() ?? "";
      const date = parseDate(tag("DTPOSTED")), amount = parseAmount(tag("TRNAMT"));
      const description = (tag("MEMO") || tag("NAME")).slice(0, 200);
      if (date && amount !== null && amount !== 0 && description) out.push({ date, description, amount, externalId: tag("FITID") ? `ofx-${tag("FITID")}` : fingerprint(date, description, amount, out.length) });
    }
    return out;
  }
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const delim = (lines[0].match(/;/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const split = (l: string) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, ""));
  const head = split(lines[0]).map((h) => h.toLowerCase());
  const has = head.some((h) => /data|date|valor|amount|descri|hist/.test(h));
  const col = (re: RegExp, fb: number) => { const i = head.findIndex((h) => re.test(h)); return has && i >= 0 ? i : fb; };
  const [iD, iT, iV] = [col(/data|date/, 0), col(/descri|hist|memo/, 1), col(/valor|amount/, 2)];
  for (const l of lines.slice(has ? 1 : 0)) {
    const c = split(l);
    const date = parseDate(c[iD] ?? ""), amount = parseAmount(c[iV] ?? ""), description = (c[iT] ?? "").slice(0, 200);
    if (date && amount !== null && amount !== 0 && description) out.push({ date, description, amount, externalId: fingerprint(date, description, amount, out.length) });
  }
  return out;
}

@Injectable()
export class BankService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly finance: FinanceService, private readonly integrations: IntegrationsService) {}

  private async ensureBanks(orgId: string) {
    if ((await this.prisma.bankConnection.count({ where: { organizationId: orgId } })) === 0) await this.prisma.bankConnection.createMany({ data: CATALOG.slice(0, 2).map((bank) => ({ organizationId: orgId, bank })), skipDuplicates: true });
  }

  async connections(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    await this.ensureBanks(orgId);
    return (await this.prisma.bankConnection.findMany({ where: { organizationId: orgId }, orderBy: { bank: "asc" } })).map((b) => ({ id: b.id, bank: b.bank, account: b.account, connected: b.connected, lastSync: b.lastSyncAt?.toISOString() }));
  }

  async toggle(ctx: AuthContext, id: string, ip: string) {
    this.integrations.requireSandbox("A conexão bancária (Open Finance)");
    const orgId = orgOf(ctx);
    const cur = await this.prisma.bankConnection.findFirst({ where: { id, organizationId: orgId } });
    if (!cur) throw new NotFoundException();
    const b = await this.prisma.bankConnection.update({ where: { id }, data: cur.connected ? { connected: false, lastSyncAt: null } : { connected: true, lastSyncAt: new Date(), account: cur.account || "Conta corrente (sandbox)" } });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "bank.toggle", entity: "bank_connection", entityId: id, text: `${ctx.user.name} ${b.connected ? "conectou" : "desconectou"} ${b.bank}`, ip });
    return { id: b.id, bank: b.bank, account: b.account, connected: b.connected, lastSync: b.lastSyncAt?.toISOString() };
  }

  private async suggest(orgId: string, line: BankLine) {
    const amt = num(line.amount);
    const near = 7 * 86_400_000;
    const cands = await this.prisma.transaction.findMany({
      where: { organizationId: orgId, status: "confirmada", bankLine: null, type: amt >= 0 ? "entrada" : "saida", amount: Math.abs(amt), date: { gte: new Date(line.date.getTime() - near), lte: new Date(line.date.getTime() + near) } },
      orderBy: { date: "desc" }, take: 20,
    });
    const best = cands.map((t) => ({ t, days: Math.abs(t.date.getTime() - line.date.getTime()) / 86_400_000 })).sort((a, b) => a.days - b.days)[0];
    return best ? { id: best.t.id, score: Math.max(60, Math.round(100 - best.days * 4)) } : null;
  }

  private async refreshSuggestions(orgId: string) {
    const lines = await this.prisma.bankLine.findMany({ where: { organizationId: orgId, status: "pendente", suggestedTransactionId: null }, take: 200 });
    for (const l of lines) {
      const s = await this.suggest(orgId, l);
      if (s) await this.prisma.bankLine.update({ where: { id: l.id }, data: { suggestedTransactionId: s.id, suggestionScore: s.score } });
    }
  }

  private async lineDto(l: BankLine & { connection: { bank: string } | null }) {
    const sug = l.status === "pendente" && l.suggestedTransactionId ? await this.prisma.transaction.findFirst({ where: { id: l.suggestedTransactionId, bankLine: null } }) : null;
    return {
      id: l.id, date: l.date.toISOString(), description: l.description, amount: num(l.amount), bank: l.connection?.bank ?? "Extrato importado", status: l.status,
      match: l.matchText ?? undefined, suggestion: sug ? { id: sug.id, description: sug.description, amount: num(sug.amount) * (sug.type === "saida" ? -1 : 1), score: l.suggestionScore ?? 80 } : undefined,
    };
  }

  async summary(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    await this.refreshSuggestions(orgId);
    const [rows, suggested] = await Promise.all([
      this.prisma.bankLine.groupBy({ by: ["status"], where: { organizationId: orgId }, _count: { _all: true }, _sum: { amount: true } }),
      this.prisma.bankLine.count({ where: { organizationId: orgId, status: "pendente", suggestedTransactionId: { not: null } } }),
    ]);
    const g = (s: string) => rows.find((r) => r.status === s);
    const total = rows.reduce((a, r) => a + r._count._all, 0);
    return { pending: g("pendente")?._count._all ?? 0, pendingAmount: num(g("pendente")?._sum.amount), reconciledPct: total ? Math.round(((g("conciliado")?._count._all ?? 0) / total) * 100) : 0, suggested };
  }

  async lines(ctx: AuthContext, q: ListQuery) {
    const orgId = orgOf(ctx);
    await this.refreshSuggestions(orgId);
    const where: Prisma.BankLineWhereInput = {
      organizationId: orgId, ...(q.status && ["pendente", "conciliado", "ignorado"].includes(q.status) ? { status: q.status as never } : {}),
      ...(q.search ? { OR: [{ description: { contains: q.search, mode: "insensitive" } }, { connection: { bank: { contains: q.search, mode: "insensitive" } } }] } : {}),
    };
    const [rows, total] = await Promise.all([this.prisma.bankLine.findMany({ where, include: { connection: { select: { bank: true } } }, orderBy: [{ date: "desc" }, { createdAt: "desc" }], ...skipTake(q) }), this.prisma.bankLine.count({ where })]);
    return page(await Promise.all(rows.map((l) => this.lineDto(l))), total, q);
  }

  private async one(orgId: string, id: string) {
    const l = await this.prisma.bankLine.findFirst({ where: { id, organizationId: orgId }, include: { connection: { select: { bank: true } } } });
    if (!l) throw new NotFoundException();
    return l;
  }

  async reconcile(ctx: AuthContext, id: string, ip: string) {
    const orgId = orgOf(ctx);
    const l = await this.one(orgId, id);
    if (l.status !== "pendente") throw new ConflictException("Esta linha já foi tratada.");
    const tx = l.suggestedTransactionId ? await this.prisma.transaction.findFirst({ where: { id: l.suggestedTransactionId, organizationId: orgId, bankLine: null } }) : null;
    if (!tx) throw new ConflictException("Não há lançamento sugerido para esta linha. Crie um lançamento ou ignore.");
    await this.prisma.bankLine.update({ where: { id }, data: { status: "conciliado", transactionId: tx.id, matchText: tx.description, suggestedTransactionId: null, suggestionScore: null } });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "bank.reconcile", entity: "bank_line", entityId: id, text: `${ctx.user.name} conciliou "${l.description}" com "${tx.description}"`, ip });
    return this.lineDto(await this.one(orgId, id));
  }

  async createEntry(ctx: AuthContext, id: string, category: string, ip: string) {
    const orgId = orgOf(ctx);
    const l = await this.one(orgId, id);
    if (l.status !== "pendente") throw new ConflictException("Esta linha já foi tratada.");
    const amt = num(l.amount);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.finance.recordMovement(tx, orgId, { type: amt >= 0 ? "entrada" : "saida", description: l.description, category, amount: Math.abs(amt), date: l.date });
      await tx.bankLine.update({ where: { id }, data: { status: "conciliado", transactionId: t.id, matchText: `Lançamento criado (${category})`, suggestedTransactionId: null, suggestionScore: null } });
    });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "bank.create_entry", entity: "bank_line", entityId: id, text: `${ctx.user.name} criou um lançamento a partir de "${l.description}"`, ip });
    return this.lineDto(await this.one(orgId, id));
  }

  async ignore(ctx: AuthContext, id: string, ip: string) {
    const orgId = orgOf(ctx);
    const r = await this.prisma.bankLine.updateMany({ where: { id, organizationId: orgId, status: "pendente" }, data: { status: "ignorado", suggestedTransactionId: null, suggestionScore: null } });
    if (r.count === 0) { await this.one(orgId, id); throw new ConflictException("Esta linha já foi tratada."); }
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "bank.ignore", entity: "bank_line", entityId: id, text: `${ctx.user.name} ignorou uma linha do extrato`, ip });
    return this.lineDto(await this.one(orgId, id));
  }

  async import(ctx: AuthContext, dto: ImportDto, ip: string) {
    const orgId = orgOf(ctx);
    const parsed = parseStatement(dto.content).slice(0, MAX_IMPORT_LINES);
    if (parsed.length === 0) throw new BadRequestException("Não encontramos lançamentos neste arquivo. Envie um extrato OFX ou um CSV com data, descrição e valor.");
    const conn = await this.prisma.bankConnection.findFirst({ where: { organizationId: orgId, connected: true }, orderBy: { lastSyncAt: "desc" } });
    const r = await this.prisma.bankLine.createMany({ data: parsed.map((p) => ({ organizationId: orgId, connectionId: conn?.id ?? null, date: p.date, description: p.description, amount: p.amount, externalId: p.externalId })), skipDuplicates: true });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "bank.import", entity: "bank_line", text: `${ctx.user.name} importou o extrato ${dto.fileName} (${r.count} lançamentos)`, ip });
    await this.refreshSuggestions(orgId);
    return { imported: r.count };
  }
}

@Controller("bank")
export class BankController {
  constructor(private readonly svc: BankService) {}
  @RequirePermission("finance:view") @Get("connections") connections(@Auth() ctx: AuthContext) { return this.svc.connections(ctx); }
  @RequirePermission("finance:edit") @Post("connections/:id/toggle") toggle(@Auth() ctx: AuthContext, @Param("id") id: string, @ClientIp() ip: string) { return this.svc.toggle(ctx, id, ip); }
  @RequirePermission("finance:view") @Get("summary") summary(@Auth() ctx: AuthContext) { return this.svc.summary(ctx); }
  @RequirePermission("finance:view") @Get("lines") lines(@Auth() ctx: AuthContext, @Query() q: ListQuery) { return this.svc.lines(ctx, q); }
  @RequirePermission("finance:edit") @Post("lines/:id/reconcile") reconcile(@Auth() ctx: AuthContext, @Param("id") id: string, @ClientIp() ip: string) { return this.svc.reconcile(ctx, id, ip); }
  @RequirePermission("finance:edit") @Post("lines/:id/create-entry") createEntry(@Auth() ctx: AuthContext, @Param("id") id: string, @Body() dto: CreateEntryDto, @ClientIp() ip: string) { return this.svc.createEntry(ctx, id, dto.category, ip); }
  @RequirePermission("finance:edit") @Post("lines/:id/ignore") ignore(@Auth() ctx: AuthContext, @Param("id") id: string, @ClientIp() ip: string) { return this.svc.ignore(ctx, id, ip); }
  @RequirePermission("finance:edit") @Post("import") import(@Auth() ctx: AuthContext, @Body() dto: ImportDto, @ClientIp() ip: string) { return this.svc.import(ctx, dto, ip); }
}

@Module({ imports: [FinanceModule], controllers: [BankController], providers: [BankService] })
export class BankModule {}
