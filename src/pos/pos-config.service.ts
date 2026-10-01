import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from "class-validator";
import { type PaymentMethod, Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { clearFailures, isLocked, passwordMatches, registerFailure } from "../common/login-attempts";
import { num } from "../common/money";
import { permissionsOf, type RoleName } from "../common/permissions";
import { FinanceService, PAYMENT_LABEL } from "../finance/finance.service";
import { PrismaService } from "../prisma/prisma.service";

const MONEY_MAX = 99_999_999.99;
const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const present = (key: string) => (o: Record<string, unknown>) => o[key] !== null && o[key] !== undefined;
export const PAYMENT_METHODS: PaymentMethod[] = ["dinheiro", "pix", "debito", "credito", "boleto", "outros", "credito_cliente", "fiado"];
export const DEFAULT_MOVE_REASONS = ["Depósito no banco", "Pagamento de fornecedor", "Despesa da loja", "Reforço de troco"];
export const DISCOUNT_ROLES: RoleName[] = ["admin", "financeiro", "vendedor", "caixa", "supervisor", "estoque"];

export const AUTH_ACTIONS = ["discount", "cancel", "withdrawal", "close_difference", "return", "price"] as const;
export type AuthAction = (typeof AUTH_ACTIONS)[number];
const ACTION_PERMISSION: Record<AuthAction, string> = { discount: "pos:discount", cancel: "pos:cancel_closed", withdrawal: "pos:manage", close_difference: "pos:manage", return: "pos:return", price: "pos:price" };
const AUTH_TTL_MS = 5 * 60 * 1000;

export class PosSettingsDto {
  @IsOptional() @IsBoolean() requireCustomer?: boolean;
  @IsOptional() @IsBoolean() allowNegativeStock?: boolean;
  @IsOptional() @IsBoolean() autoPrint?: boolean;
  @IsOptional() @IsBoolean() beep?: boolean;
  @IsOptional() @IsBoolean() blindClose?: boolean;
  @IsOptional() @IsBoolean() cancelSameDayOnly?: boolean;
  @IsOptional() @ValidateIf(present("cashLimit")) @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) cashLimit?: number | null;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) maxDifference?: number;
  @IsOptional() @ValidateIf(present("withdrawalApprovalAbove")) @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) withdrawalApprovalAbove?: number | null;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1, { message: "O limite de horas deve ser de 1 a 72." }) @Max(72, { message: "O limite de horas deve ser de 1 a 72." }) maxOpenHours?: number;
  @IsOptional() @IsObject() discountLimits?: Record<string, number>;
  @IsOptional() @ValidateIf(present("requireDocumentAbove")) @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) requireDocumentAbove?: number | null;
  @IsOptional() @IsBoolean() blockBelowCost?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(60, { each: true }) moveReasons?: string[];
}

export class TerminalDto {
  @Transform(trim) @IsString({ message: "Informe o nome do caixa." }) @MinLength(1, { message: "Informe o nome do caixa." }) @MaxLength(40) name: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) defaultFloat?: number;
}
export class UpdateTerminalDto {
  @IsOptional() @Transform(trim) @IsString({ message: "Informe o nome do caixa." }) @MinLength(1, { message: "Informe o nome do caixa." }) @MaxLength(40) name?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) defaultFloat?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class PaymentConfigDto {
  @IsOptional() @ValidateIf(present("accountId")) @IsString() @MaxLength(40) accountId?: string | null;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) feePercent?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) installmentFeePercent?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1000) feeFixed?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(180) settlementDays?: number;
  @IsOptional() @IsBoolean() enabledInPos?: boolean;
}

export class AuthorizeDto {
  @Transform(trim) @IsEmail({}, { message: "Informe o e-mail do supervisor." }) email: string;
  @IsString() @MinLength(1, { message: "Informe a senha do supervisor." }) @MaxLength(200) password: string;
  @IsIn(AUTH_ACTIONS as unknown as string[], { message: "Ação inválida." }) action: AuthAction;
}

export interface PosSettingsView {
  requireCustomer: boolean; allowNegativeStock: boolean; autoPrint: boolean; beep: boolean; blindClose: boolean; cancelSameDayOnly: boolean;
  cashLimit: number | null; maxDifference: number; withdrawalApprovalAbove: number | null; maxOpenHours: number;
  requireDocumentAbove: number | null; blockBelowCost: boolean;
  discountLimits: Record<string, number>; moveReasons: string[];
}

type Db = Prisma.TransactionClient | PrismaService;

@Injectable()
export class PosConfigService {
  constructor(private readonly prisma: PrismaService, private readonly finance: FinanceService, private readonly audit: AuditService) {}

  async settings(orgId: string, db: Db = this.prisma): Promise<PosSettingsView> {
    const s = await db.posSettings.findUnique({ where: { organizationId: orgId } });
    return {
      requireCustomer: s?.requireCustomer ?? false, allowNegativeStock: s?.allowNegativeStock ?? false, autoPrint: s?.autoPrint ?? false, beep: s?.beep ?? true,
      blindClose: s?.blindClose ?? false, cancelSameDayOnly: s?.cancelSameDayOnly ?? false,
      cashLimit: s?.cashLimit != null ? num(s.cashLimit) : null, maxDifference: num(s?.maxDifference), withdrawalApprovalAbove: s?.withdrawalApprovalAbove != null ? num(s.withdrawalApprovalAbove) : null,
      maxOpenHours: s?.maxOpenHours ?? 14, requireDocumentAbove: s?.requireDocumentAbove != null ? num(s.requireDocumentAbove) : null, blockBelowCost: s?.blockBelowCost ?? false,
      discountLimits: (s?.discountLimits as Record<string, number> | undefined) ?? {}, moveReasons: s?.moveReasons ?? DEFAULT_MOVE_REASONS,
    };
  }

  async publicSettings(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    const [s, methods, accounts] = await Promise.all([
      this.settings(orgId), this.paymentMethods(ctx),
      this.prisma.account.findMany({ where: { organizationId: orgId, active: true }, select: { id: true, name: true, type: true }, orderBy: { createdAt: "asc" } }),
    ]);
    return {
      ...s, enabledMethods: methods.filter((m) => m.enabledInPos).map((m) => m.method),
      installmentFeePercent: methods.find((m) => m.method === "credito")?.installmentFeePercent ?? 0,
      discountLimit: this.discountLimit(s, ctx.role, ctx.permissions), accounts,
    };
  }

  async updateSettings(ctx: AuthContext, dto: PosSettingsDto, ip: string) {
    const orgId = orgOf(ctx);
    let limits: Record<string, number> | undefined;
    if (dto.discountLimits) {
      limits = {};
      for (const [role, v] of Object.entries(dto.discountLimits)) {
        if (!DISCOUNT_ROLES.includes(role as RoleName)) throw new BadRequestException(`Função inválida no limite de desconto: ${role}.`);
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) throw new BadRequestException("O limite de desconto deve ser de 0 a 100%.");
        limits[role] = Math.round(v * 100) / 100;
      }
    }
    const reasons = dto.moveReasons?.map((r) => r.trim()).filter(Boolean);
    const data = {
      requireCustomer: dto.requireCustomer, allowNegativeStock: dto.allowNegativeStock, autoPrint: dto.autoPrint, beep: dto.beep, blindClose: dto.blindClose,
      cancelSameDayOnly: dto.cancelSameDayOnly, cashLimit: dto.cashLimit, maxDifference: dto.maxDifference, withdrawalApprovalAbove: dto.withdrawalApprovalAbove,
      maxOpenHours: dto.maxOpenHours, requireDocumentAbove: dto.requireDocumentAbove, blockBelowCost: dto.blockBelowCost, discountLimits: limits, moveReasons: reasons ? [...new Set(reasons)] : undefined,
    };
    await this.prisma.posSettings.upsert({ where: { organizationId: orgId }, create: { organizationId: orgId, ...data, moveReasons: data.moveReasons ?? DEFAULT_MOVE_REASONS }, update: data });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "pos.settings", entity: "pos_settings", text: `${ctx.user.name} alterou as configurações do PDV`, ip });
    return this.settings(orgId);
  }

  discountLimit(s: PosSettingsView, role: string | null, permissions: string[]) {
    if (role && typeof s.discountLimits[role] === "number") return s.discountLimits[role];
    return permissions.includes("pos:discount") ? 100 : 0;
  }

  async terminals(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    const rows = await this.prisma.posTerminal.findMany({ where: { organizationId: orgId }, orderBy: { name: "asc" }, include: { sessions: { where: { status: "aberto" }, select: { user: { select: { name: true } } } } } });
    return rows.map((t) => ({ id: t.id, name: t.name, defaultFloat: num(t.defaultFloat), active: t.active, openBy: t.sessions[0]?.user.name.split(" ")[0] ?? null }));
  }

  async createTerminal(ctx: AuthContext, dto: TerminalDto, ip: string) {
    const orgId = orgOf(ctx);
    try {
      const t = await this.prisma.posTerminal.create({ data: { organizationId: orgId, name: dto.name, defaultFloat: dto.defaultFloat ?? 0 } });
      await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "pos.terminal.create", entity: "pos_terminal", entityId: t.id, text: `${ctx.user.name} cadastrou o ${t.name}`, ip });
      return { id: t.id, name: t.name, defaultFloat: num(t.defaultFloat), active: t.active, openBy: null };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new ConflictException("Já existe um caixa com esse nome.");
      throw e;
    }
  }

  async updateTerminal(ctx: AuthContext, id: string, dto: UpdateTerminalDto, ip: string) {
    const orgId = orgOf(ctx);
    const t = await this.prisma.posTerminal.findFirst({ where: { id, organizationId: orgId } });
    if (!t) throw new NotFoundException();
    const open = await this.prisma.cashSession.findFirst({ where: { terminalId: id, status: "aberto" }, select: { id: true } });
    if (open && (dto.active === false || (dto.name && dto.name !== t.name))) throw new ConflictException("Feche o caixa antes de renomear ou desativar este terminal.");
    try {
      const u = await this.prisma.posTerminal.update({ where: { id }, data: { name: dto.name, defaultFloat: dto.defaultFloat, active: dto.active } });
      await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "pos.terminal.update", entity: "pos_terminal", entityId: id, text: `${ctx.user.name} alterou o ${u.name}`, ip });
      return { id: u.id, name: u.name, defaultFloat: num(u.defaultFloat), active: u.active, openBy: null };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new ConflictException("Já existe um caixa com esse nome.");
      throw e;
    }
  }

  async paymentMethods(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    const accounts = await this.prisma.account.findMany({ where: { organizationId: orgId }, select: { id: true, name: true } });
    const out = [];
    for (const method of PAYMENT_METHODS) {
      const c = await this.finance.paymentConfig(this.prisma, orgId, method);
      out.push({ ...c, label: PAYMENT_LABEL[method], accountName: accounts.find((a) => a.id === c.accountId)?.name ?? null });
    }
    return out;
  }

  async updatePaymentMethod(ctx: AuthContext, method: string, dto: PaymentConfigDto, ip: string) {
    const orgId = orgOf(ctx);
    if (!PAYMENT_METHODS.includes(method as PaymentMethod)) throw new NotFoundException();
    const m = method as PaymentMethod;
    if (dto.accountId && !(await this.prisma.account.findFirst({ where: { id: dto.accountId, organizationId: orgId }, select: { id: true } }))) throw new BadRequestException("Conta financeira não encontrada.");
    if (m === "dinheiro" && (dto.settlementDays ?? 0) > 0) throw new BadRequestException("Dinheiro entra na gaveta na hora; o prazo de repasse deve ser zero.");
    if (m === "dinheiro" && dto.enabledInPos === false) throw new BadRequestException("O dinheiro não pode ser desativado no PDV.");
    const cur = await this.finance.paymentConfig(this.prisma, orgId, m);
    const data = {
      accountId: dto.accountId === undefined ? cur.accountId : dto.accountId, feePercent: dto.feePercent ?? cur.feePercent, installmentFeePercent: dto.installmentFeePercent ?? cur.installmentFeePercent,
      feeFixed: dto.feeFixed ?? cur.feeFixed, settlementDays: dto.settlementDays ?? cur.settlementDays, enabledInPos: dto.enabledInPos ?? cur.enabledInPos,
    };
    await this.prisma.paymentMethodConfig.upsert({ where: { organizationId_method: { organizationId: orgId, method: m } }, create: { organizationId: orgId, method: m, ...data }, update: data });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "pos.payment_method", entity: "payment_method", entityId: m, text: `${ctx.user.name} alterou a forma de pagamento ${PAYMENT_LABEL[m]}`, ip });
    return (await this.paymentMethods(ctx)).find((x) => x.method === m);
  }

  async authorize(ctx: AuthContext, dto: AuthorizeDto, ip: string) {
    const orgId = orgOf(ctx);
    const denied = () => new ForbiddenException("E-mail ou senha do supervisor inválidos, ou ele não tem permissão para autorizar esta ação.");
    const m = await this.prisma.membership.findFirst({ where: { organizationId: orgId, status: "ativo", user: { email: dto.email.toLowerCase() } }, include: { user: true } });
    const user = m?.user;
    if (isLocked(user)) throw new HttpException("Muitas tentativas incorretas para este supervisor. Tente novamente em alguns minutos.", HttpStatus.TOO_MANY_REQUESTS);
    if (!(await passwordMatches(user, dto.password)) || !m || !user) {
      if (user) {
        const failed = await registerFailure(this.prisma, user);
        await this.audit.log({ organizationId: orgId, userId: user.id, action: "pos.authorize_failed", entity: "pos_authorization", text: `Senha de supervisor incorreta informada por ${ctx.user.name} (${failed})`, ip });
      }
      throw denied();
    }
    await clearFailures(this.prisma, user);
    if (user.id === ctx.user.id) throw new ForbiddenException("A autorização precisa ser de outro usuário (supervisor).");
    if (!permissionsOf(m.role, m.extraPermissions).includes(ACTION_PERMISSION[dto.action])) throw denied();
    const a = await this.prisma.posAuthorization.create({ data: { organizationId: orgId, supervisorId: user.id, requestedById: ctx.user.id, action: dto.action, expiresAt: new Date(Date.now() + AUTH_TTL_MS) } });
    await this.audit.log({ organizationId: orgId, userId: user.id, action: "pos.authorize", entity: "pos_authorization", entityId: a.id, text: `${user.name} autorizou "${dto.action}" para ${ctx.user.name}`, ip });
    return { authorizationId: a.id, supervisor: user.name.split(" ")[0], expiresAt: a.expiresAt.toISOString() };
  }

  async consume(db: Db, ctx: AuthContext, id: string | undefined, action: AuthAction, message: string) {
    if (!id) throw new ForbiddenException({ message, code: "supervisor_required" });
    const orgId = orgOf(ctx);
    const r = await db.posAuthorization.updateMany({ where: { id, organizationId: orgId, action, requestedById: ctx.user.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (r.count === 0) throw new ForbiddenException({ message: "Autorização do supervisor inválida ou expirada. Peça novamente.", code: "supervisor_required" });
    const a = await db.posAuthorization.findUniqueOrThrow({ where: { id } });
    const m = await db.membership.findFirst({ where: { userId: a.supervisorId, organizationId: orgId }, select: { role: true, extraPermissions: true } });
    return { supervisorId: a.supervisorId, role: m?.role ?? null, permissions: m ? permissionsOf(m.role, m.extraPermissions) : [] };
  }
}
