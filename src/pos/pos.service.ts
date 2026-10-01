import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import { type PaymentMethod, Prisma, type CashSession } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { startOfDay } from "../common/dates";
import { scheduleJob } from "../common/jobs";
import { cents, fromCents, num } from "../common/money";
import { ListQuery, page, skipTake } from "../common/pagination";
import { FinanceService, PAYMENT_LABEL } from "../finance/finance.service";
import { MailService } from "../mail/mail.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { padNumber } from "../sales/sale.mapper";
import { SalesService } from "../sales/sales.service";
import { PAYMENT_METHODS, PosConfigService } from "./pos-config.service";

const MONEY_MAX = 99_999_999.99;
const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) => (value === "" ? null : value);
const brl = (v: number) => v.toFixed(2).replace(".", ",");

export class OpenRegisterDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, { message: "O valor inicial não pode ser negativo." }) @Max(MONEY_MAX) initial: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) register?: string;
  @IsOptional() @IsString() @MaxLength(40) terminalId?: string;
}
class CountDto {
  @IsIn(PAYMENT_METHODS, { message: "Forma de pagamento inválida." }) method: PaymentMethod;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, { message: "O valor contado não pode ser negativo." }) @Max(MONEY_MAX) counted: number;
}
export class CloseRegisterDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, { message: "O valor contado não pode ser negativo." }) @Max(MONEY_MAX) counted: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(8) @ValidateNested({ each: true }) @Type(() => CountDto) counts?: CountDto[];
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, { message: "O fundo de troco não pode ser negativo." }) @Max(MONEY_MAX) float?: number;
  @IsOptional() @IsString() @MaxLength(40) destinationAccountId?: string;
  @IsOptional() @IsString() @MaxLength(40) authorizationId?: string;
}
export class ForceCloseDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, { message: "O valor contado não pode ser negativo." }) @Max(MONEY_MAX) counted: number;
  @Transform(trim) @IsString({ message: "Informe o motivo do fechamento administrativo." }) @MinLength(3, { message: "Informe o motivo do fechamento administrativo." }) @MaxLength(500) notes: string;
  @IsOptional() @IsArray() @ArrayMaxSize(8) @ValidateNested({ each: true }) @Type(() => CountDto) counts?: CountDto[];
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, { message: "O fundo de troco não pode ser negativo." }) @Max(MONEY_MAX) float?: number;
  @IsOptional() @IsString() @MaxLength(40) destinationAccountId?: string;
}
export class CashMoveDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01, { message: "Informe um valor maior que zero." }) @Max(MONEY_MAX) amount: number;
  @Transform(trim) @IsString({ message: "Informe o motivo." }) @MinLength(1, { message: "Informe o motivo." }) @MaxLength(120) reason: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string;
  @IsOptional() @IsString() @MaxLength(40) accountId?: string;
  @IsOptional() @IsString() @MaxLength(40) authorizationId?: string;
}
class PosItemDto {
  @IsString() @MaxLength(40) productId: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }, { message: "Quantidade inválida." }) @Min(0.001, { message: "Quantidade deve ser maior que zero." }) @Max(100_000) qty: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) discount?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) price?: number;
}
class PosPaymentDto {
  @IsIn(PAYMENT_METHODS, { message: "Forma de pagamento inválida." }) method: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01, { message: "Valor do pagamento inválido." }) @Max(MONEY_MAX) amount: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(24) installments?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) received?: number;
}
export class PosSaleDto {
  @IsArray() @ArrayMinSize(1, { message: "Adicione ao menos um produto ao carrinho." }) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => PosItemDto) items: PosItemDto[];
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(40) customerId?: string | null;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) discount: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) total: number;
  @IsArray() @ArrayMinSize(1, { message: "Informe a forma de pagamento." }) @ArrayMaxSize(6, { message: "Use no máximo 6 formas de pagamento." }) @ValidateNested({ each: true }) @Type(() => PosPaymentDto) payments: PosPaymentDto[];
  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9_-]{8,64}$/, { message: "Identificador da venda inválido." }) requestId?: string;
  @IsOptional() @IsString() @MaxLength(40) authorizationId?: string;
  @IsOptional() @IsString() @MaxLength(40) priceAuthorizationId?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(20) document?: string;
}
export class CancelPosSaleDto {
  @Transform(trim) @IsString({ message: "Informe o motivo do cancelamento." }) @MinLength(3, { message: "Informe o motivo do cancelamento." }) @MaxLength(200) reason: string;
  @IsOptional() @IsString() @MaxLength(40) authorizationId?: string;
}
export class ReceiptEmailDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(160) email?: string;
}
export class PosEventDto {
  @IsIn(["item_removed", "cart_cleared"], { message: "Evento inválido." }) type: "item_removed" | "cart_cleared";
  @Transform(trim) @IsString() @MaxLength(200) description: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) amount: number;
}
export class SessionsQuery extends ListQuery {
  @IsOptional() @IsString() @MaxLength(40) userId?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}

interface MethodTotals { sales: number; refunds: number }
export interface SessionTotals {
  byMethod: Record<string, MethodTotals>;
  cash: number; pix: number; card: number; other: number; withdrawals: number; deposits: number; refunds: number; expected: number;
}

export interface RegisterState {
  open: boolean; sessionId?: string; register: string; terminalId?: string | null; operator: string; initial: number; openedAt?: string;
  cash: number; pix: number; card: number; other: number; withdrawals: number; deposits: number; refunds: number; expected: number;
  blind: boolean; cashLimit: number | null; overCashLimit: boolean; byMethod: Record<string, number>;
  terminals?: { id: string; name: string; defaultFloat: number; lastFloat: number | null; busy: boolean }[];
  lastFloat?: number | null;
}

const STALE_CHECK_MS = 15 * 60 * 1000;

@Injectable()
export class PosService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("PDV");
  private stop?: () => void;

  constructor(
    private readonly prisma: PrismaService, private readonly sales: SalesService, private readonly audit: AuditService,
    private readonly notifications: NotificationsService, private readonly finance: FinanceService, private readonly config: PosConfigService,
    private readonly mail: MailService,
  ) {}

  onModuleInit() { this.stop = scheduleJob(this.prisma, this.log, "pos.check-stale", STALE_CHECK_MS, () => this.checkStale()); }
  onModuleDestroy() { this.stop?.(); }

  private db(tx?: Prisma.TransactionClient) { return tx ?? this.prisma; }
  private manage(ctx: AuthContext) { return ctx.permissions.includes("pos:manage"); }

  private async openSession(ctx: AuthContext, tx?: Prisma.TransactionClient) {
    return this.db(tx).cashSession.findFirst({ where: { organizationId: orgOf(ctx), userId: ctx.user.id, status: "aberto" } });
  }

  private async lock(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM "CashSession" WHERE id = ${id} FOR UPDATE`;
    const s = await tx.cashSession.findUniqueOrThrow({ where: { id } });
    if (s.status !== "aberto") throw new ConflictException("Este caixa já foi fechado.");
    return s;
  }

  async totals(session: CashSession, tx?: Prisma.TransactionClient): Promise<SessionTotals> {
    const db = this.db(tx);
    const [pays, moves] = await Promise.all([
      db.salePayment.groupBy({
        by: ["method"], _sum: { amount: true },
        where: { sale: { cashSessionId: session.id, OR: [{ status: { not: "cancelada" } }, { cashMovements: { some: { type: "estorno" } } }] } },
      }),
      db.cashMovement.groupBy({ by: ["type", "method"], where: { sessionId: session.id }, _sum: { amount: true } }),
    ]);
    const byMethod: Record<string, MethodTotals> = {};
    const slot = (m: string) => (byMethod[m] ??= { sales: 0, refunds: 0 });
    for (const p of pays) slot(p.method).sales += cents(num(p._sum.amount));
    for (const m of moves) if (m.type === "estorno") slot(m.method).refunds += cents(num(m._sum.amount));
    const net = (...ms: string[]) => ms.reduce((a, m) => a + (byMethod[m] ? byMethod[m].sales - byMethod[m].refunds : 0), 0);
    const mv = (t: string) => moves.filter((m) => m.type === t).reduce((a, m) => a + cents(num(m._sum.amount)), 0);
    const withdrawals = mv("sangria"), deposits = mv("suprimento");
    const cashSales = byMethod.dinheiro?.sales ?? 0, cashRefunds = byMethod.dinheiro?.refunds ?? 0;
    const expected = cents(num(session.initial)) + cashSales - cashRefunds + deposits - withdrawals;
    const out: Record<string, MethodTotals> = {};
    for (const [k, v] of Object.entries(byMethod)) out[k] = { sales: fromCents(v.sales), refunds: fromCents(v.refunds) };
    return {
      byMethod: out, cash: fromCents(cashSales), pix: fromCents(net("pix")), card: fromCents(net("debito", "credito")), other: fromCents(net("boleto", "outros", "credito_cliente")),
      withdrawals: fromCents(withdrawals), deposits: fromCents(deposits), refunds: fromCents(cashRefunds), expected: fromCents(expected),
    };
  }

  private async nextRegisterName(orgId: string) {
    const open = new Set((await this.prisma.cashSession.findMany({ where: { organizationId: orgId, status: "aberto" }, select: { register: true } })).map((r) => r.register));
    for (let n = 1; n < 100; n++) { const name = `Caixa #${String(n).padStart(2, "0")}`; if (!open.has(name)) return name; }
    return "Caixa";
  }

  private async lastFloat(orgId: string, where: { terminalId?: string; register?: string }) {
    const last = await this.prisma.cashSession.findFirst({ where: { organizationId: orgId, status: "fechado", ...where }, orderBy: { closedAt: "desc" }, select: { float: true } });
    return last?.float != null ? num(last.float) : null;
  }

  private async terminalsForOpen(orgId: string) {
    const rows = await this.prisma.posTerminal.findMany({ where: { organizationId: orgId, active: true }, orderBy: { name: "asc" }, include: { sessions: { where: { status: "aberto" }, select: { id: true } } } });
    return Promise.all(rows.map(async (t) => ({ id: t.id, name: t.name, defaultFloat: num(t.defaultFloat), lastFloat: await this.lastFloat(orgId, { terminalId: t.id }), busy: t.sessions.length > 0 })));
  }

  private async toState(ctx: AuthContext, session: CashSession | null): Promise<RegisterState> {
    const orgId = orgOf(ctx);
    const settings = await this.config.settings(orgId);
    const operator = ctx.user.name.split(" ")[0];
    const base = { operator, blind: false, cashLimit: settings.cashLimit, overCashLimit: false, byMethod: {} as Record<string, number> };
    if (!session || session.status !== "aberto") {
      const terminals = await this.terminalsForOpen(orgId);
      const register = session?.register ?? (terminals.find((t) => !t.busy)?.name ?? (await this.nextRegisterName(orgId)));
      return {
        ...base, open: false, register, initial: 0, cash: 0, pix: 0, card: 0, other: 0, withdrawals: 0, deposits: 0, refunds: 0, expected: 0,
        terminals, lastFloat: terminals.length ? null : await this.lastFloat(orgId, { register }),
      };
    }
    const t = await this.totals(session);
    const blind = settings.blindClose && !this.manage(ctx);
    const hide = (v: number) => (blind ? 0 : v);
    return {
      ...base, open: true, sessionId: session.id, register: session.register, terminalId: session.terminalId, initial: num(session.initial), openedAt: session.openedAt.toISOString(),
      cash: hide(t.cash), pix: hide(t.pix), card: hide(t.card), other: hide(t.other), refunds: hide(t.refunds), expected: hide(t.expected),
      withdrawals: t.withdrawals, deposits: t.deposits, blind,
      overCashLimit: settings.cashLimit != null && t.expected > settings.cashLimit,
      byMethod: blind ? {} : Object.fromEntries(Object.entries(t.byMethod).map(([m, v]) => [m, fromCents(cents(v.sales) - cents(v.refunds))])),
    };
  }

  async state(ctx: AuthContext): Promise<RegisterState> {
    return this.toState(ctx, await this.openSession(ctx));
  }

  async open(ctx: AuthContext, dto: OpenRegisterDto, ip: string): Promise<RegisterState> {
    const orgId = orgOf(ctx);
    if (await this.openSession(ctx)) throw new ConflictException("Você já tem um caixa aberto.");
    const terminals = await this.prisma.posTerminal.findMany({ where: { organizationId: orgId, active: true } });
    let register: string; let terminalId: string | null = null;
    if (terminals.length) {
      const t = dto.terminalId ? terminals.find((x) => x.id === dto.terminalId) : dto.register ? terminals.find((x) => x.name === dto.register) : undefined;
      if (!t) throw new BadRequestException("Selecione o caixa (terminal) que será aberto.");
      register = t.name; terminalId = t.id;
    } else {
      register = dto.register || (await this.nextRegisterName(orgId));
    }
    const lastFloat = await this.lastFloat(orgId, terminalId ? { terminalId } : { register });
    try {
      const session = await this.prisma.cashSession.create({ data: { organizationId: orgId, userId: ctx.user.id, register, terminalId, initial: dto.initial } });
      const divergence = lastFloat != null && cents(lastFloat) !== cents(dto.initial) ? ` (o último fechamento deixou ${brl(lastFloat)})` : "";
      await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "pos.open", entity: "cash_session", entityId: session.id, text: `${ctx.user.name} abriu o ${register} com ${brl(dto.initial)}${divergence}`, ip });
      await this.notifications.notify(orgId, "PDV", `${register} aberto`, `Operador ${ctx.user.name.split(" ")[0]} abriu o caixa.${divergence ? ` Atenção: fundo de troco diferente do último fechamento${divergence}.` : ""}`);
      return this.toState(ctx, session);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        if (await this.openSession(ctx)) throw new ConflictException("Você já tem um caixa aberto.");
        throw new ConflictException(`O ${register} já está aberto por outro operador.`);
      }
      throw e;
    }
  }

  private async closeSession(ctx: AuthContext, sessionId: string, dto: CloseRegisterDto | ForceCloseDto, ip: string, forced: boolean) {
    const orgId = orgOf(ctx);
    const settings = await this.config.settings(orgId);
    const manage = this.manage(ctx);
    const result = await this.prisma.$transaction(async (tx) => {
      const session = await this.lock(tx, sessionId);
      const t = await this.totals(session, tx);
      const counted = cents(dto.counted), expected = cents(t.expected), diff = counted - expected;
      if (diff !== 0 && Math.abs(diff) > cents(settings.maxDifference)) {
        if (!dto.notes?.trim()) throw new BadRequestException("Há diferença entre o dinheiro contado e o esperado: informe uma observação explicando o motivo.");
        if (settings.maxDifference > 0 && !manage && !forced) await this.config.consume(tx, ctx, "authorizationId" in dto ? dto.authorizationId : undefined, "close_difference", `Diferença de caixa acima de R$ ${brl(settings.maxDifference)}: peça a autorização do supervisor.`);
      }
      const float = dto.float !== undefined ? cents(dto.float) : counted;
      if (float > counted) throw new BadRequestException("O fundo de troco que fica no caixa não pode ser maior que o dinheiro contado.");
      const collected = counted - float;
      await tx.cashSession.update({
        where: { id: session.id },
        data: { status: "fechado", closedAt: new Date(), expected: t.expected, counted: fromCents(counted), float: fromCents(float), collected: fromCents(collected), notes: dto.notes ?? "", closedById: ctx.user.id, forced },
      });
      const counts = new Map<PaymentMethod, number>([["dinheiro", counted]]);
      for (const c of dto.counts ?? []) if (c.method !== "dinheiro") counts.set(c.method, cents(c.counted));
      for (const [method, c] of counts) {
        const exp = method === "dinheiro" ? expected : cents((t.byMethod[method]?.sales ?? 0) - (t.byMethod[method]?.refunds ?? 0));
        await tx.cashSessionCount.create({ data: { sessionId: session.id, method, expected: fromCents(exp), counted: fromCents(c) } });
      }
      const cashAcc = await this.finance.cashAccount(tx, orgId);
      if (diff !== 0) {
        await this.finance.transfer(tx, orgId, { fromAccountId: diff < 0 ? cashAcc.id : null, toAccountId: diff > 0 ? cashAcc.id : null, amount: fromCents(Math.abs(diff)), description: `${diff < 0 ? "Quebra" : "Sobra"} de caixa — ${session.register}`, category: "Quebra de caixa" });
      }
      if (collected > 0 && dto.destinationAccountId && dto.destinationAccountId !== cashAcc.id) {
        await this.finance.transfer(tx, orgId, { fromAccountId: cashAcc.id, toAccountId: dto.destinationAccountId, amount: fromCents(collected), description: `Recolhimento do ${session.register}`, category: "Transferência" });
      }
      return { session, t, counted, expected, diff, float, collected };
    });
    const { session, t, counted, diff, float, collected } = result;
    const who = forced ? `${ctx.user.name} fez o fechamento administrativo do ${session.register}` : `${ctx.user.name} fechou o ${session.register}`;
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: forced ? "pos.force_close" : "pos.close", entity: "cash_session", entityId: session.id, text: `${who} (esperado ${brl(t.expected)}, contado ${brl(fromCents(counted))}, diferença ${brl(fromCents(diff))})${dto.notes ? `: ${dto.notes}` : ""}`, ip });
    if (diff !== 0) await this.notifications.notify(orgId, "PDV", `${diff < 0 ? "Quebra" : "Sobra"} de caixa no ${session.register}`, `Diferença de R$ ${brl(fromCents(diff))} no fechamento.`);
    const blind = settings.blindClose && !manage;
    return {
      open: false, sessionId: session.id, register: session.register, counted: fromCents(counted), float: fromCents(float), collected: fromCents(collected),
      expected: blind ? null : t.expected, difference: blind ? null : fromCents(diff), blind,
    };
  }

  async close(ctx: AuthContext, dto: CloseRegisterDto, ip: string) {
    const session = await this.openSession(ctx);
    if (!session) throw new ConflictException("Não há caixa aberto para fechar.");
    return this.closeSession(ctx, session.id, dto, ip, false);
  }

  async forceClose(ctx: AuthContext, id: string, dto: ForceCloseDto, ip: string) {
    const orgId = orgOf(ctx);
    const session = await this.prisma.cashSession.findFirst({ where: { id, organizationId: orgId } });
    if (!session) throw new NotFoundException();
    if (session.status !== "aberto") throw new ConflictException("Este caixa já foi fechado.");
    const r = await this.closeSession(ctx, id, dto, ip, session.userId !== ctx.user.id);
    if (session.userId !== ctx.user.id) await this.notifications.notify(orgId, "PDV", `${session.register} fechado pelo gerente`, `${ctx.user.name.split(" ")[0]} fez o fechamento administrativo: ${dto.notes}`);
    return r;
  }

  async move(ctx: AuthContext, type: "sangria" | "suprimento", dto: CashMoveDto, ip: string): Promise<RegisterState> {
    const orgId = orgOf(ctx);
    const settings = await this.config.settings(orgId);
    const found = await this.prisma.$transaction(async (tx) => {
      const open = await this.openSession(ctx, tx);
      if (!open) throw new ConflictException("Abra o caixa antes de registrar sangria ou suprimento.");
      const session = await this.lock(tx, open.id);
      const t = await this.totals(session, tx);
      if (type === "sangria" && cents(dto.amount) > cents(t.expected)) {
        throw new BadRequestException(`A sangria é maior que o dinheiro disponível no caixa (${brl(t.expected)}).`);
      }
      let approvedById: string | undefined;
      if (type === "sangria" && settings.withdrawalApprovalAbove != null && dto.amount > settings.withdrawalApprovalAbove && !this.manage(ctx)) {
        approvedById = (await this.config.consume(tx, ctx, dto.authorizationId, "withdrawal", `Sangria acima de R$ ${brl(settings.withdrawalApprovalAbove)} precisa da autorização do supervisor.`)).supervisorId;
      }
      await tx.cashMovement.create({ data: { organizationId: orgId, sessionId: session.id, userId: ctx.user.id, type, amount: dto.amount, reason: dto.reason, notes: dto.notes ?? "", approvedById } });
      const cashAcc = await this.finance.cashAccount(tx, orgId);
      const other = dto.accountId && dto.accountId !== cashAcc.id ? dto.accountId : null;
      const label = `${type === "sangria" ? "Sangria" : "Suprimento"} ${session.register} — ${dto.reason}`;
      if (type === "sangria") await this.finance.transfer(tx, orgId, { fromAccountId: cashAcc.id, toAccountId: other, amount: dto.amount, description: label, category: other ? "Transferência" : "Sangria de caixa" });
      else await this.finance.transfer(tx, orgId, { fromAccountId: other, toAccountId: cashAcc.id, amount: dto.amount, description: label, category: other ? "Transferência" : "Suprimento de caixa" });
      return session;
    });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: `pos.${type}`, entity: "cash_session", entityId: found.id, text: `${ctx.user.name} registrou ${type} de ${brl(dto.amount)} (${dto.reason})`, ip });
    return this.toState(ctx, found);
  }

  async sell(ctx: AuthContext, dto: PosSaleDto, ip: string) {
    const orgId = orgOf(ctx);
    const session = await this.openSession(ctx);
    if (!session) throw new ConflictException("Abra o caixa antes de vender.");
    const settings = await this.config.settings(orgId);
    for (const m of new Set(dto.payments.map((p) => p.method))) {
      if (!(await this.finance.paymentConfig(this.prisma, orgId, m as PaymentMethod)).enabledInPos) throw new BadRequestException(`A forma de pagamento ${PAYMENT_LABEL[m as PaymentMethod]} não está habilitada no PDV.`);
    }
    if (settings.requireCustomer && !dto.customerId) throw new BadRequestException("Selecione o cliente para finalizar a venda.");
    const customerDoc = dto.customerId
      ? (await this.prisma.customer.findFirst({ where: { id: dto.customerId, organizationId: orgId }, select: { document: true } }))?.document
      : "";
    const noteDoc = (dto.document || customerDoc || "").replace(/\D/g, "");
    if (settings.requireDocumentAbove != null && dto.total >= settings.requireDocumentAbove && noteDoc.length < 11) {
      throw new BadRequestException(`Informe o CPF/CNPJ do cliente para vendas a partir de R$ ${brl(settings.requireDocumentAbove)}.`);
    }

    let approvedById: string | undefined;
    const ids = [...new Set(dto.items.map((i) => i.productId))];
    const prices = new Map((await this.prisma.product.findMany({ where: { id: { in: ids }, organizationId: orgId }, select: { id: true, price: true } })).map((p) => [p.id, cents(num(p.price))]));
    const priceChanged = dto.items.some((i) => i.price !== undefined && Math.abs(cents(i.price) - (prices.get(i.productId) ?? 0)) > 1);
    let priceApproved = ctx.permissions.includes("pos:price");
    if (priceChanged && !priceApproved) {
      const a = await this.config.consume(this.prisma, ctx, dto.priceAuthorizationId, "price", "O preço informado é diferente do cadastro. Peça a validação do supervisor.");
      if (!a.permissions.includes("pos:price")) throw new ForbiddenException("O supervisor não pode validar alteração de preço.");
      approvedById = a.supervisorId;
      priceApproved = true;
    }
    const lineDiscount = dto.items.reduce((a, i) => a + cents(i.discount ?? 0), 0);
    const totalDiscount = Math.max(cents(dto.discount), lineDiscount);
    if (totalDiscount > 0) {
      const gross = dto.items.reduce((a, i) => a + (prices.get(i.productId) ?? 0) * i.qty, 0);
      const pct = gross > 0 ? Math.round((totalDiscount / gross) * 10000) / 100 : 0;
      const limit = this.config.discountLimit(settings, ctx.role, ctx.permissions);
      if (pct > limit) {
        const msg = limit === 0 ? "Você não tem permissão para dar desconto no PDV." : `Desconto de ${brl(pct)}% acima do seu limite de ${brl(limit)}%. Peça a autorização do supervisor.`;
        const a = await this.config.consume(this.prisma, ctx, dto.authorizationId, "discount", msg);
        if (pct > this.config.discountLimit(settings, a.role, a.permissions)) throw new ForbiddenException("O desconto também passa do limite do supervisor.");
        approvedById = a.supervisorId;
        if (a.permissions.includes("pos:price")) priceApproved = true;
      }
    }

    return this.sales.place(ctx, {
      customerId: dto.customerId ?? null,
      lines: dto.items.map((i) => ({ productId: i.productId, qty: i.qty, discount: i.discount, price: i.price })),
      totalDiscount: dto.discount, expectedTotal: dto.total, payments: dto.payments,
      origin: "pdv", status: "concluida", cashSessionId: session.id, register: session.register,
      allowNegativeStock: settings.allowNegativeStock, requestId: dto.requestId, approvedById,
      document: dto.document, blockBelowCost: settings.blockBelowCost && !priceApproved,
    }, ip);
  }

  async cancelSale(ctx: AuthContext, id: string, dto: CancelPosSaleDto, ip: string) {
    const orgId = orgOf(ctx);
    const sale = await this.prisma.sale.findFirst({ where: { id, organizationId: orgId }, include: { payments: true, cashSession: true } });
    if (!sale) throw new NotFoundException();
    if (sale.origin !== "pdv") throw new ConflictException("Só vendas do PDV são canceladas por aqui.");
    if (sale.status === "cancelada") throw new ConflictException("Esta venda já foi cancelada.");
    const settings = await this.config.settings(orgId);
    const otherSession = !sale.cashSession || sale.cashSession.status === "fechado" || sale.cashSession.userId !== ctx.user.id;
    const notToday = settings.cancelSameDayOnly && startOfDay(sale.createdAt) < startOfDay(new Date());
    let approvedById: string | undefined;
    if ((otherSession && !ctx.permissions.includes("pos:cancel_closed")) || (notToday && !this.manage(ctx))) {
      const msg = otherSession
        ? "Esta venda é de um caixa já fechado ou de outro operador: o cancelamento precisa da autorização do supervisor."
        : "Só é possível cancelar sem autorização do supervisor as vendas feitas hoje.";
      approvedById = (await this.config.consume(this.prisma, ctx, dto.authorizationId, "cancel", msg)).supervisorId;
    }
    const byMethod = new Map<PaymentMethod, number>();
    for (const p of sale.payments) if (p.method !== "credito_cliente") byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + cents(num(p.amount)));
    const session = await this.openSession(ctx);
    if ((byMethod.get("dinheiro") ?? 0) > 0 && !session) throw new ConflictException("Abra o caixa para devolver o dinheiro desta venda.");

    return this.sales.cancel(ctx, id, ip, {
      reason: dto.reason,
      onCancel: async (tx, s) => {
        if (!session) return;
        const locked = await this.lock(tx, session.id);
        for (const [method, amount] of byMethod) {
          await tx.cashMovement.create({ data: { organizationId: orgId, sessionId: locked.id, userId: ctx.user.id, type: "estorno", method, amount: fromCents(amount), reason: `Cancelamento da venda #${padNumber(s.number)}`, notes: dto.reason, saleId: s.id, approvedById } });
        }
        const t = await this.totals(locked, tx);
        if (t.expected < 0) throw new ConflictException(`Não há dinheiro suficiente no caixa para devolver R$ ${brl(fromCents(byMethod.get("dinheiro") ?? 0))}. Faça um suprimento antes.`);
      },
    });
  }

  history(ctx: AuthContext, q: ListQuery) { return this.sales.list(ctx, q, "pdv"); }

  async sendReceipt(ctx: AuthContext, id: string, dto: ReceiptEmailDto) {
    const sale = await this.prisma.sale.findFirst({ where: { id, organizationId: orgOf(ctx) }, include: { customer: { select: { email: true, name: true } }, items: true, payments: true } });
    if (!sale) throw new NotFoundException();
    const to = (dto.email || sale.customer?.email || "").trim();
    if (!to) throw new BadRequestException("Informe o e-mail para enviar o comprovante.");
    await this.mail.saleReceipt(to, sale.customer?.name ?? "Cliente", {
      number: padNumber(sale.number), date: sale.createdAt, total: num(sale.total),
      items: sale.items.map((i) => `${num(i.qty)} × ${i.name}`),
    });
    return { ok: true, email: to };
  }

  async sessions(ctx: AuthContext, q: SessionsQuery) {
    const orgId = orgOf(ctx);
    const where: Prisma.CashSessionWhereInput = {
      organizationId: orgId,
      ...(this.manage(ctx) ? (q.userId ? { userId: q.userId } : {}) : { userId: ctx.user.id }),
      ...(q.status === "aberto" || q.status === "fechado" ? { status: q.status } : {}),
      ...(q.from || q.to ? { openedAt: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00`) } : {}), ...(q.to ? { lte: new Date(`${q.to}T23:59:59.999`) } : {}) } } : {}),
      ...(q.search ? { OR: [{ register: { contains: q.search, mode: "insensitive" } }, { user: { name: { contains: q.search, mode: "insensitive" } } }] } : {}),
    };
    const [rows, total, settings] = await Promise.all([
      this.prisma.cashSession.findMany({ where, include: { user: { select: { name: true } }, _count: { select: { sales: { where: { status: { not: "cancelada" } } } } } }, orderBy: { openedAt: "desc" }, ...skipTake(q) }),
      this.prisma.cashSession.count({ where }),
      this.config.settings(orgId),
    ]);
    const blind = settings.blindClose && !this.manage(ctx);
    const now = Date.now();
    const data = await Promise.all(rows.map(async (s) => {
      const open = s.status === "aberto";
      const t = open ? await this.totals(s) : null;
      const [agg, lastSale] = await Promise.all([
        this.prisma.sale.aggregate({ where: { cashSessionId: s.id, status: { not: "cancelada" } }, _sum: { total: true } }),
        open ? this.prisma.sale.findFirst({ where: { cashSessionId: s.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }) : null,
      ]);
      const expected = open ? t!.expected : num(s.expected);
      const hoursOpen = (((open ? now : s.closedAt?.getTime() ?? now) - s.openedAt.getTime()) / 3_600_000);
      return {
        id: s.id, register: s.register, operator: s.user.name.split(" ")[0], userId: s.userId, status: s.status, forced: s.forced,
        openedAt: s.openedAt.toISOString(), closedAt: s.closedAt?.toISOString() ?? null, initial: num(s.initial),
        expected: blind ? null : expected, counted: s.counted != null ? num(s.counted) : null,
        difference: blind || s.counted == null ? null : fromCents(cents(num(s.counted)) - cents(num(s.expected))),
        salesCount: s._count.sales, salesTotal: blind ? null : num(agg._sum.total), lastSaleAt: lastSale?.createdAt.toISOString() ?? null,
        hoursOpen: Math.round(hoursOpen * 10) / 10, stale: open && hoursOpen > settings.maxOpenHours,
        overCashLimit: open && settings.cashLimit != null && expected > settings.cashLimit,
      };
    }));
    return page(data, total, q);
  }

  async report(ctx: AuthContext, id: string) {
    const orgId = orgOf(ctx);
    const s = await this.prisma.cashSession.findFirst({
      where: { id, organizationId: orgId },
      include: { user: { select: { name: true } }, counts: true, movements: { include: { user: { select: { name: true } } }, orderBy: { createdAt: "asc" } } },
    });
    if (!s) throw new NotFoundException();
    if (!this.manage(ctx) && s.userId !== ctx.user.id) throw new ForbiddenException("Você só pode ver os seus próprios caixas.");
    const settings = await this.config.settings(orgId);
    const blind = settings.blindClose && !this.manage(ctx);
    const t = await this.totals(s);
    const [done, cancelled, closedBy] = await Promise.all([
      this.prisma.sale.aggregate({ where: { cashSessionId: s.id, status: { not: "cancelada" } }, _sum: { total: true, discount: true }, _count: true }),
      this.prisma.sale.aggregate({ where: { cashSessionId: s.id, status: "cancelada" }, _sum: { total: true }, _count: true }),
      s.closedById ? this.prisma.user.findUnique({ where: { id: s.closedById }, select: { name: true } }) : null,
    ]);
    const lineDiscounts = await this.prisma.saleItem.aggregate({ where: { sale: { cashSessionId: s.id, status: { not: "cancelada" } } }, _sum: { discount: true } });
    const expected = s.status === "aberto" ? t.expected : num(s.expected);
    const methods = new Set<string>([...Object.keys(t.byMethod), ...s.counts.map((c) => c.method)]);
    const byMethod = [...methods].sort((a, b) => PAYMENT_METHODS.indexOf(a as PaymentMethod) - PAYMENT_METHODS.indexOf(b as PaymentMethod)).map((m) => {
      const v = t.byMethod[m] ?? { sales: 0, refunds: 0 };
      const count = s.counts.find((c) => c.method === m);
      const net = fromCents(cents(v.sales) - cents(v.refunds));
      const exp = count ? num(count.expected) : m === "dinheiro" ? expected : net;
      return {
        method: m, label: PAYMENT_LABEL[m as PaymentMethod] ?? m, sales: blind ? null : v.sales, refunds: blind ? null : v.refunds, net: blind ? null : net,
        expected: blind ? null : exp, counted: count ? num(count.counted) : null, difference: blind || !count ? null : fromCents(cents(num(count.counted)) - cents(exp)),
      };
    });
    const salesTotal = num(done._sum.total);
    return {
      id: s.id, register: s.register, operator: s.user.name, status: s.status, forced: s.forced, closedBy: closedBy?.name ?? null,
      openedAt: s.openedAt.toISOString(), closedAt: s.closedAt?.toISOString() ?? null, notes: s.notes, blind,
      initial: num(s.initial), deposits: t.deposits, withdrawals: t.withdrawals, refunds: blind ? null : t.refunds,
      expected: blind ? null : expected, counted: s.counted != null ? num(s.counted) : null,
      difference: blind || s.counted == null ? null : fromCents(cents(num(s.counted)) - cents(num(s.expected))),
      float: s.float != null ? num(s.float) : null, collected: s.collected != null ? num(s.collected) : null,
      byMethod,
      sales: blind ? null : {
        count: done._count, total: salesTotal, average: done._count ? Math.round((salesTotal / done._count) * 100) / 100 : 0,
        discounts: fromCents(cents(num(done._sum.discount)) + cents(num(lineDiscounts._sum.discount))),
        cancelled: cancelled._count, cancelledTotal: num(cancelled._sum.total),
      },
      movements: s.movements.map((m) => ({ id: m.id, type: m.type, method: m.method, amount: num(m.amount), reason: m.reason, notes: m.notes, user: m.user.name.split(" ")[0], createdAt: m.createdAt.toISOString() })),
    };
  }

  async checkStale(now = new Date()) {
    const open = await this.prisma.cashSession.findMany({ where: { status: "aberto", staleNotifiedAt: null }, include: { user: { select: { name: true } } } });
    const hoursByOrg = new Map<string, number>();
    let notified = 0;
    for (const s of open) {
      if (!hoursByOrg.has(s.organizationId)) hoursByOrg.set(s.organizationId, (await this.config.settings(s.organizationId)).maxOpenHours);
      const limit = hoursByOrg.get(s.organizationId)!;
      if (now.getTime() - s.openedAt.getTime() < limit * 3_600_000) continue;
      const r = await this.prisma.cashSession.updateMany({ where: { id: s.id, staleNotifiedAt: null }, data: { staleNotifiedAt: now } });
      if (r.count === 0) continue;
      await this.notifications.notify(s.organizationId, "PDV", `${s.register} aberto há mais de ${limit} h`, `Operador ${s.user.name.split(" ")[0]}. Feche o caixa ou faça o fechamento administrativo em PDV › Caixas.`);
      notified++;
    }
    return notified;
  }

  async period(ctx: AuthContext, q: SessionsQuery) {
    const orgId = orgOf(ctx);
    if (!this.manage(ctx) && !ctx.permissions.includes("pos:history")) throw new ForbiddenException();
    const from = q.from ? new Date(`${q.from}T00:00:00`) : new Date(Date.now() - 30 * 86_400_000);
    const to = q.to ? new Date(`${q.to}T23:59:59.999`) : new Date();
    const sessions = await this.prisma.cashSession.findMany({
      where: { organizationId: orgId, openedAt: { gte: from, lte: to }, ...(this.manage(ctx) ? {} : { userId: ctx.user.id }) },
      include: { user: { select: { name: true } } },
    });
    const sales = await this.prisma.sale.findMany({
      where: { organizationId: orgId, origin: "pdv", createdAt: { gte: from, lte: to }, status: { not: "cancelada" } },
      select: { total: true, createdAt: true, user: { select: { name: true } } },
    });
    const byOp = new Map<string, { operator: string; sessions: number; differences: number; sales: number; volume: number }>();
    for (const s of sessions) {
      const key = s.userId;
      const cur = byOp.get(key) ?? { operator: s.user.name.split(" ")[0], sessions: 0, differences: 0, sales: 0, volume: 0 };
      cur.sessions++;
      if (s.counted != null && s.expected != null) cur.differences += cents(num(s.counted)) - cents(num(s.expected));
      byOp.set(key, cur);
    }
    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, total: 0 }));
    for (const s of sales) {
      const h = s.createdAt.getHours();
      hours[h].count++; hours[h].total += cents(num(s.total));
      const name = s.user?.name.split(" ")[0] ?? "—";
      const hit = [...byOp.values()].find((o) => o.operator === name);
      if (hit) { hit.sales++; hit.volume += cents(num(s.total)); }
    }
    const volume = sales.reduce((a, s) => a + cents(num(s.total)), 0);
    return {
      from: from.toISOString(), to: to.toISOString(),
      salesCount: sales.length, salesTotal: fromCents(volume), average: sales.length ? fromCents(Math.round(volume / sales.length)) : 0,
      operators: [...byOp.values()].map((o) => ({ ...o, differences: fromCents(o.differences), volume: fromCents(o.volume) })).sort((a, b) => b.volume - a.volume),
      byHour: hours.filter((h) => h.count).map((h) => ({ hour: h.hour, count: h.count, total: fromCents(h.total) })),
    };
  }

  async event(ctx: AuthContext, dto: PosEventDto, ip: string) {
    const orgId = orgOf(ctx);
    const session = await this.openSession(ctx);
    const what = dto.type === "item_removed" ? "removeu do carrinho" : "cancelou o carrinho com";
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: `pos.${dto.type}`, entity: "cash_session", entityId: session?.id ?? "", text: `${ctx.user.name} ${what} ${dto.description} (R$ ${brl(dto.amount)})`, ip });
    return { ok: true };
  }
}
