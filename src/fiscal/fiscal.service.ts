import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Injectable, Logger, Module, NotFoundException, type OnModuleDestroy, type OnModuleInit, Param, Post, Put, Query } from "@nestjs/common";
import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { Prisma, type FiscalNote, type FiscalSettings as FiscalSettingsRow } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { Auth, ClientIp, RequirePermission } from "../common/decorators";
import { buildAccessKey } from "../common/fiscal-key";
import { num } from "../common/money";
import { ListQuery, page, skipTake } from "../common/pagination";
import { scheduleJob } from "../common/jobs";
import { decryptSecret, encryptSecret } from "../common/secret";
import { ENV, type Env } from "../config/env";
import { IntegrationsService } from "../integrations/integrations.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { padNumber, SALE_LIST_INCLUDE, saleDto } from "../sales/sale.mapper";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const TYPE_LABEL = { nfe: "NF-e", nfce: "NFC-e" } as const;
const TYPE_KEY = { "NF-e": "nfe", "NFC-e": "nfce" } as const;
const MASK = "••••••••";
const AUTHORIZE_POLL_MS = 5_000;

export class EmitDto {
  @Transform(trim) @IsString({ message: "Selecione a venda." }) @MinLength(1, { message: "Selecione a venda." }) @MaxLength(20) saleNumber: string;
  @IsIn(["NF-e", "NFC-e"], { message: "Tipo de documento inválido." }) type: "NF-e" | "NFC-e";
}
export class CancelNoteDto { @Transform(trim) @IsString() @MinLength(5, { message: "Informe o motivo do cancelamento (mínimo de 5 caracteres)." }) @MaxLength(255) reason: string; }
class CertDto {
  @Transform(trim) @IsString() @MaxLength(120) name: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "Validade do certificado inválida." }) expiresAt: string;
}
export class FiscalSettingsDto {
  @IsOptional() @IsIn(["homologacao", "producao"]) environment?: "homologacao" | "producao";
  @IsOptional() @IsIn(["simples", "presumido", "real"]) regime?: "simples" | "presumido" | "real";
  @IsOptional() @Transform(trim) @IsString() @MaxLength(3) nfeSeries?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(3) nfceSeries?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(10) cscId?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) cscToken?: string;
  @IsOptional() @ValidateNested() @Type(() => CertDto) certificate?: CertDto | null;
}

@Injectable()
export class FiscalService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Fiscal");
  private stop?: () => void;
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly integrations: IntegrationsService, private readonly notifications: NotificationsService, @Inject(ENV) private readonly env: Env) {}

  /** As notas pendentes ficam no banco: qualquer instância as autoriza, inclusive depois de um restart. */
  onModuleInit() { this.stop = scheduleJob(this.prisma, this.log, "fiscal.authorize-pending", AUTHORIZE_POLL_MS, () => this.authorizePending()); }
  onModuleDestroy() { this.stop?.(); }

  private get authorizeDelayMs() { return Number(process.env.FISCAL_SANDBOX_DELAY_MS ?? 4000); }

  async authorizePending() {
    const due = await this.prisma.fiscalNote.findMany({ where: { status: "pendente", issuedAt: { lte: new Date(Date.now() - this.authorizeDelayMs) } }, select: { id: true }, orderBy: { issuedAt: "asc" }, take: 100 });
    for (const n of due) await this.authorize(n.id).catch((e) => this.log.error(`Falha ao autorizar ${n.id}: ${(e as Error).message}`));
  }

  private dto(n: FiscalNote & { sale: { number: number } }) {
    return {
      id: n.id, type: TYPE_LABEL[n.type], number: String(n.number), series: n.series, saleNumber: padNumber(n.sale.number), customer: n.customerName || "Consumidor",
      date: n.issuedAt.toISOString(), total: num(n.total), status: n.status, key: n.key, protocol: n.protocol ?? undefined, rejectReason: n.rejectReason ?? undefined,
    };
  }

  async list(ctx: AuthContext, q: ListQuery) {
    const orgId = orgOf(ctx);
    const digits = q.search?.replace(/\D/g, "");
    const where: Prisma.FiscalNoteWhereInput = {
      organizationId: orgId, ...(q.status && ["autorizada", "pendente", "rejeitada", "cancelada"].includes(q.status) ? { status: q.status as never } : {}),
      ...(q.search ? { OR: [{ customerName: { contains: q.search, mode: "insensitive" } }, { key: { contains: q.search } }, ...(digits ? [{ number: Number(digits) || -1 }, { sale: { number: Number(digits) || -1 } }] : [])] } : {}),
    };
    const [rows, total] = await Promise.all([this.prisma.fiscalNote.findMany({ where, include: { sale: { select: { number: true } } }, orderBy: [{ issuedAt: "desc" }, { number: "desc" }], ...skipTake(q) }), this.prisma.fiscalNote.count({ where })]);
    return page(rows.map((n) => this.dto(n)), total, q);
  }

  async summary(ctx: AuthContext) {
    const rows = await this.prisma.fiscalNote.groupBy({ by: ["status"], where: { organizationId: orgOf(ctx) }, _count: { _all: true }, _sum: { total: true } });
    const get = (s: string) => rows.find((r) => r.status === s);
    return { authorized: get("autorizada")?._count._all ?? 0, pending: get("pendente")?._count._all ?? 0, rejected: get("rejeitada")?._count._all ?? 0, issued: num(get("autorizada")?._sum.total) };
  }

  async pendingSales(ctx: AuthContext) {
    const rows = await this.prisma.sale.findMany({
      where: { organizationId: orgOf(ctx), status: "concluida", fiscalNotes: { none: { status: { in: ["autorizada", "pendente"] } } } },
      include: SALE_LIST_INCLUDE, orderBy: { createdAt: "desc" }, take: 30,
    });
    return rows.map(saleDto);
  }

  private async nextNumber(orgId: string, type: "nfe" | "nfce") {
    const c = await this.prisma.counter.upsert({ where: { organizationId_key: { organizationId: orgId, key: `fiscal-${type}` } }, create: { organizationId: orgId, key: `fiscal-${type}`, value: 1 }, update: { value: { increment: 1 } } });
    return c.value;
  }

  async emitForSale(orgId: string, saleId: string, type: "nfe" | "nfce" = "nfce") {
    const sale = await this.prisma.sale.findFirst({ where: { id: saleId, organizationId: orgId }, include: { customer: { select: { name: true } } } });
    if (!sale || sale.status !== "concluida") return null;
    if (await this.prisma.fiscalNote.findFirst({ where: { saleId: sale.id, status: { in: ["autorizada", "pendente"] } } })) return null;
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    const settings = await this.settingsRow(orgId);
    const series = type === "nfe" ? settings.nfeSeries : settings.nfceSeries;
    const number = await this.nextNumber(orgId, type);
    const note = await this.prisma.fiscalNote.create({
      data: { organizationId: orgId, saleId: sale.id, type, number, series, total: sale.total, customerName: sale.customer?.name ?? "", key: buildAccessKey({ cnpj: org.cnpj ?? "", model: type === "nfe" ? 55 : 65, series, number, date: new Date(), code: Math.floor(Math.random() * 1e8) }) },
      include: { sale: { select: { number: true } } },
    });
    await this.scheduleAuthorization(note.id);
    return this.dto(note);
  }

  async cancelForSale(orgId: string, saleId: string, reason: string) {
    const notes = await this.prisma.fiscalNote.findMany({ where: { organizationId: orgId, saleId, status: { in: ["autorizada", "pendente"] } } });
    for (const n of notes) {
      await this.prisma.fiscalNote.update({ where: { id: n.id }, data: { status: "cancelada", rejectReason: reason } });
    }
    return notes.length;
  }

  async emit(ctx: AuthContext, dto: EmitDto, ip: string) {
    this.integrations.requireSandbox("O emissor de notas fiscais");
    const orgId = orgOf(ctx);
    const num6 = Number(dto.saleNumber.replace(/\D/g, ""));
    const sale = await this.prisma.sale.findFirst({ where: { organizationId: orgId, number: Number.isInteger(num6) ? num6 : -1 }, include: { customer: { select: { name: true } } } });
    if (!sale) throw new NotFoundException("Venda não encontrada.");
    const note = await this.emitForSale(orgId, sale.id, TYPE_KEY[dto.type]);
    if (!note) {
      if (sale.status !== "concluida") throw new ConflictException("Só é possível emitir nota de vendas concluídas.");
      throw new ConflictException("Esta venda já possui uma nota fiscal.");
    }
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "fiscal.emit", entity: "fiscal_note", entityId: note.id, text: `${ctx.user.name} emitiu ${dto.type} ${note.number} da venda #${padNumber(sale.number)}`, ip });
    return note;
  }

  private async scheduleAuthorization(id: string) {
    if (this.authorizeDelayMs <= 0) await this.authorize(id).catch((e) => this.log.error(`Falha ao autorizar ${id}: ${(e as Error).message}`));
  }

  async authorize(id: string) {
    const protocol = `135${Date.now().toString().slice(-12)}`;
    const r = await this.prisma.fiscalNote.updateMany({ where: { id, status: { in: ["pendente", "rejeitada"] } }, data: { status: "autorizada", protocol, rejectReason: null } });
    if (r.count) { const n = await this.prisma.fiscalNote.findUnique({ where: { id } }); if (n) await this.notifications.notify(n.organizationId, "Financeiro", `${TYPE_LABEL[n.type]} ${n.number} autorizada`, `Protocolo ${protocol}.`); }
  }

  async retry(ctx: AuthContext, id: string, ip: string) {
    this.integrations.requireSandbox("O emissor de notas fiscais");
    const orgId = orgOf(ctx);
    const n = await this.prisma.fiscalNote.findFirst({ where: { id, organizationId: orgId }, include: { sale: { select: { number: true } } } });
    if (!n) throw new NotFoundException();
    if (n.status !== "rejeitada") throw new ConflictException("Só notas rejeitadas podem ser reenviadas.");
    await this.authorize(id);
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "fiscal.retry", entity: "fiscal_note", entityId: id, text: `${ctx.user.name} reenviou a nota ${n.number}`, ip });
    return this.dto((await this.prisma.fiscalNote.findUniqueOrThrow({ where: { id }, include: { sale: { select: { number: true } } } })));
  }

  async cancel(ctx: AuthContext, id: string, reason: string, ip: string) {
    this.integrations.requireSandbox("O emissor de notas fiscais");
    const orgId = orgOf(ctx);
    const r = await this.prisma.fiscalNote.updateMany({ where: { id, organizationId: orgId, status: "autorizada" }, data: { status: "cancelada", rejectReason: null } });
    if (r.count === 0) {
      if (!(await this.prisma.fiscalNote.findFirst({ where: { id, organizationId: orgId }, select: { id: true } }))) throw new NotFoundException();
      throw new ConflictException("Só notas autorizadas podem ser canceladas.");
    }
    const n = await this.prisma.fiscalNote.findUniqueOrThrow({ where: { id }, include: { sale: { select: { number: true } } } });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "fiscal.cancel", entity: "fiscal_note", entityId: id, text: `${ctx.user.name} cancelou a nota ${n.number}: ${reason}`, ip });
    return this.dto(n);
  }

  private async settingsRow(orgId: string): Promise<FiscalSettingsRow> {
    return this.prisma.fiscalSettings.upsert({ where: { organizationId: orgId }, create: { organizationId: orgId }, update: {} });
  }

  private settingsDto(s: FiscalSettingsRow) {
    return {
      environment: s.environment, regime: s.regime, nfeSeries: s.nfeSeries, nfceSeries: s.nfceSeries, cscId: s.cscId, cscToken: s.cscTokenEnc ? MASK : "",
      certificate: s.certName && s.certExpiresAt ? { name: s.certName, expiresAt: s.certExpiresAt.toISOString().slice(0, 10) } : null,
    };
  }

  async settings(ctx: AuthContext) { return this.settingsDto(await this.settingsRow(orgOf(ctx))); }

  async saveSettings(ctx: AuthContext, dto: FiscalSettingsDto, ip: string) {
    const orgId = orgOf(ctx);
    await this.settingsRow(orgId);
    const token = dto.cscToken !== undefined && dto.cscToken !== MASK ? encryptSecret(dto.cscToken, this.env.secretsKey) : undefined;
    const s = await this.prisma.fiscalSettings.update({
      where: { organizationId: orgId },
      data: {
        environment: dto.environment, regime: dto.regime, nfeSeries: dto.nfeSeries || undefined, nfceSeries: dto.nfceSeries || undefined, cscId: dto.cscId, cscTokenEnc: token,
        ...(dto.certificate === null ? { certName: null, certExpiresAt: null } : dto.certificate ? { certName: dto.certificate.name, certExpiresAt: new Date(`${dto.certificate.expiresAt}T00:00:00.000Z`) } : {}),
      },
    });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "fiscal.settings", entity: "fiscal_settings", entityId: orgId, text: `${ctx.user.name} atualizou as configurações fiscais`, ip });
    return this.settingsDto(s);
  }

  async cscToken(orgId: string) { return decryptSecret((await this.settingsRow(orgId)).cscTokenEnc, this.env.secretsKey); }
}

@Controller("fiscal")
export class FiscalController {
  constructor(private readonly svc: FiscalService) {}
  @RequirePermission("fiscal:view") @Get("notes") list(@Auth() ctx: AuthContext, @Query() q: ListQuery) { return this.svc.list(ctx, q); }
  @RequirePermission("fiscal:view") @Get("summary") summary(@Auth() ctx: AuthContext) { return this.svc.summary(ctx); }
  @RequirePermission("fiscal:view") @Get("pending-sales") pending(@Auth() ctx: AuthContext) { return this.svc.pendingSales(ctx); }
  @RequirePermission("fiscal:create") @Post("notes") emit(@Auth() ctx: AuthContext, @Body() dto: EmitDto, @ClientIp() ip: string) { return this.svc.emit(ctx, dto, ip); }
  @RequirePermission("fiscal:edit") @Post("notes/:id/retry") retry(@Auth() ctx: AuthContext, @Param("id") id: string, @ClientIp() ip: string) { return this.svc.retry(ctx, id, ip); }
  @RequirePermission("fiscal:edit") @Post("notes/:id/cancel") cancel(@Auth() ctx: AuthContext, @Param("id") id: string, @Body() dto: CancelNoteDto, @ClientIp() ip: string) { return this.svc.cancel(ctx, id, dto.reason, ip); }
  @RequirePermission("fiscal:view") @Get("settings") settings(@Auth() ctx: AuthContext) { return this.svc.settings(ctx); }
  @RequirePermission("fiscal:edit") @Put("settings") save(@Auth() ctx: AuthContext, @Body() dto: FiscalSettingsDto, @ClientIp() ip: string) { return this.svc.saveSettings(ctx, dto, ip); }
}

@Module({ controllers: [FiscalController], providers: [FiscalService], exports: [FiscalService] })
export class FiscalModule {}
