import { BadRequestException, ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { Prisma, type CashSession } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { cents, fromCents, num } from "../common/money";
import type { ListQuery } from "../common/pagination";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { SalesService } from "../sales/sales.service";

const METHODS = ["dinheiro", "pix", "debito", "credito", "boleto", "outros"];
const MONEY_MAX = 99_999_999.99;
const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) => (value === "" ? null : value);

export class OpenRegisterDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, { message: "O valor inicial não pode ser negativo." }) @Max(MONEY_MAX) initial: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) register?: string;
}
export class CloseRegisterDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0, { message: "O valor contado não pode ser negativo." }) @Max(MONEY_MAX) counted: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string;
}
export class CashMoveDto {
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01, { message: "Informe um valor maior que zero." }) @Max(MONEY_MAX) amount: number;
  @Transform(trim) @IsString() @MaxLength(120) reason: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) notes?: string;
}
class PosItemDto {
  @IsString() @MaxLength(40) productId: string;
  @Type(() => Number) @IsInt({ message: "Quantidade inválida." }) @Min(1, { message: "Quantidade deve ser no mínimo 1." }) @Max(100_000) qty: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) discount?: number;
}
class PosPaymentDto {
  @IsIn(METHODS, { message: "Forma de pagamento inválida." }) method: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01, { message: "Valor do pagamento inválido." }) @Max(MONEY_MAX) amount: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(24) installments?: number;
}
export class PosSaleDto {
  @IsArray() @ArrayMinSize(1, { message: "Adicione ao menos um produto ao carrinho." }) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => PosItemDto) items: PosItemDto[];
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(40) customerId?: string | null;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) discount: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) total: number;
  @IsArray() @ArrayMinSize(1, { message: "Informe a forma de pagamento." }) @ArrayMaxSize(6, { message: "Use no máximo 6 formas de pagamento." }) @ValidateNested({ each: true }) @Type(() => PosPaymentDto) payments: PosPaymentDto[];
}

export interface RegisterState {
  open: boolean; register: string; operator: string; initial: number; openedAt?: string;
  cash: number; pix: number; card: number; withdrawals: number; deposits: number;
}

@Injectable()
export class PosService {
  constructor(private readonly prisma: PrismaService, private readonly sales: SalesService, private readonly audit: AuditService, private readonly notifications: NotificationsService) {}

  private db(tx?: Prisma.TransactionClient) { return tx ?? this.prisma; }

  private async openSession(ctx: AuthContext, tx?: Prisma.TransactionClient) {
    return this.db(tx).cashSession.findFirst({ where: { organizationId: orgOf(ctx), userId: ctx.user.id, status: "aberto" } });
  }

  private async totals(session: CashSession, tx?: Prisma.TransactionClient) {
    const db = this.db(tx);
    const [pays, moves] = await Promise.all([
      db.salePayment.groupBy({ by: ["method"], where: { sale: { cashSessionId: session.id, status: { not: "cancelada" } } }, _sum: { amount: true } }),
      db.cashMovement.groupBy({ by: ["type"], where: { sessionId: session.id }, _sum: { amount: true } }),
    ]);
    const by = (m: string) => num(pays.find((p) => p.method === m)?._sum.amount);
    const cash = by("dinheiro"), pix = by("pix");
    const card = pays.filter((p) => p.method !== "dinheiro" && p.method !== "pix").reduce((a, p) => a + num(p._sum.amount), 0);
    const mv = (t: string) => num(moves.find((m) => m.type === t)?._sum.amount);
    const withdrawals = mv("sangria"), deposits = mv("suprimento");
    const expected = (cents(num(session.initial)) + cents(cash) + cents(deposits) - cents(withdrawals)) / 100;
    return { cash, pix, card, withdrawals, deposits, expected };
  }

  private async nextRegisterName(orgId: string) {
    const open = new Set((await this.prisma.cashSession.findMany({ where: { organizationId: orgId, status: "aberto" }, select: { register: true } })).map((r) => r.register));
    for (let n = 1; n < 100; n++) { const name = `Caixa #${String(n).padStart(2, "0")}`; if (!open.has(name)) return name; }
    return "Caixa";
  }

  private toState(session: CashSession | null, t: Awaited<ReturnType<PosService["totals"]>> | null, ctx: AuthContext, fallbackName: string): RegisterState {
    const operator = ctx.user.name.split(" ")[0];
    if (!session || !t) return { open: false, register: fallbackName, operator, initial: 0, cash: 0, pix: 0, card: 0, withdrawals: 0, deposits: 0 };
    return { open: session.status === "aberto", register: session.register, operator, initial: num(session.initial), openedAt: session.openedAt.toISOString(), cash: t.cash, pix: t.pix, card: t.card, withdrawals: t.withdrawals, deposits: t.deposits };
  }

  async state(ctx: AuthContext): Promise<RegisterState> {
    const session = await this.openSession(ctx);
    if (!session) return this.toState(null, null, ctx, await this.nextRegisterName(orgOf(ctx)));
    return this.toState(session, await this.totals(session), ctx, session.register);
  }

  async open(ctx: AuthContext, dto: OpenRegisterDto, ip: string): Promise<RegisterState> {
    const orgId = orgOf(ctx);
    if (await this.openSession(ctx)) throw new ConflictException("Você já tem um caixa aberto.");
    const register = dto.register || (await this.nextRegisterName(orgId));
    try {
      const session = await this.prisma.cashSession.create({ data: { organizationId: orgId, userId: ctx.user.id, register, initial: dto.initial } });
      await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "pos.open", entity: "cash_session", entityId: session.id, text: `${ctx.user.name} abriu o ${register} com ${fromCents(cents(dto.initial)).toFixed(2).replace(".", ",")}`, ip });
      await this.notifications.notify(orgId, "PDV", `${register} aberto`, `Operador ${ctx.user.name.split(" ")[0]} abriu o caixa.`);
      return this.toState(session, await this.totals(session), ctx, register);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        if (await this.openSession(ctx)) throw new ConflictException("Você já tem um caixa aberto.");
        throw new ConflictException(`O ${register} já está aberto por outro operador.`);
      }
      throw e;
    }
  }

  async close(ctx: AuthContext, dto: CloseRegisterDto, ip: string) {
    const orgId = orgOf(ctx);
    const session = await this.openSession(ctx);
    if (!session) throw new ConflictException("Não há caixa aberto para fechar.");
    const t = await this.totals(session);
    const counted = fromCents(cents(dto.counted));
    const r = await this.prisma.cashSession.updateMany({ where: { id: session.id, status: "aberto" }, data: { status: "fechado", closedAt: new Date(), expected: t.expected, counted, notes: dto.notes ?? "" } });
    if (r.count === 0) throw new ConflictException("Este caixa já foi fechado.");
    const difference = (cents(counted) - cents(t.expected)) / 100;
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "pos.close", entity: "cash_session", entityId: session.id, text: `${ctx.user.name} fechou o ${session.register} (esperado ${t.expected.toFixed(2).replace(".", ",")}, contado ${counted.toFixed(2).replace(".", ",")}, diferença ${difference.toFixed(2).replace(".", ",")})`, ip });
    return { ...this.toState({ ...session, status: "fechado" }, t, ctx, session.register), open: false, expected: t.expected, counted, difference };
  }

  async move(ctx: AuthContext, type: "sangria" | "suprimento", dto: CashMoveDto, ip: string): Promise<RegisterState> {
    const orgId = orgOf(ctx);
    const state = await this.prisma.$transaction(async (tx) => {
      const found = await this.openSession(ctx, tx);
      if (!found) throw new ConflictException("Abra o caixa antes de registrar sangria ou suprimento.");
      await tx.$queryRaw`SELECT id FROM "CashSession" WHERE id = ${found.id} FOR UPDATE`;
      const t = await this.totals(found, tx);
      if (type === "sangria" && cents(dto.amount) > cents(t.expected)) {
        throw new BadRequestException(`A sangria é maior que o dinheiro disponível no caixa (${t.expected.toFixed(2).replace(".", ",")}).`);
      }
      await tx.cashMovement.create({ data: { organizationId: orgId, sessionId: found.id, userId: ctx.user.id, type, amount: dto.amount, reason: dto.reason, notes: dto.notes ?? "" } });
      return this.toState(found, await this.totals(found, tx), ctx, found.register);
    });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: `pos.${type}`, entity: "cash_session", text: `${ctx.user.name} registrou ${type === "sangria" ? "sangria" : "suprimento"} de ${dto.amount.toFixed(2).replace(".", ",")} (${dto.reason})`, ip });
    return state;
  }

  async sell(ctx: AuthContext, dto: PosSaleDto, ip: string) {
    const session = await this.openSession(ctx);
    if (!session) throw new ConflictException("Abra o caixa antes de vender.");
    const hasDiscount = dto.discount > 0 || dto.items.some((i) => (i.discount ?? 0) > 0);
    if (hasDiscount && !ctx.permissions.includes("pos:discount")) throw new ForbiddenException("Você não tem permissão para dar desconto no PDV.");
    return this.sales.place(ctx, {
      customerId: dto.customerId ?? null,
      lines: dto.items.map((i) => ({ productId: i.productId, qty: i.qty, discount: i.discount })),
      totalDiscount: dto.discount, expectedTotal: dto.total, payments: dto.payments,
      origin: "pdv", status: "concluida", cashSessionId: session.id, register: session.register,
    }, ip);
  }

  history(ctx: AuthContext, q: ListQuery) { return this.sales.list(ctx, q, "pdv"); }
}
