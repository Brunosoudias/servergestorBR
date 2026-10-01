import { Body, ConflictException, Controller, Get, Global, Injectable, Logger, Module, NotFoundException, OnModuleDestroy, OnModuleInit, Param, Post } from "@nestjs/common";
import { Transform } from "class-transformer";
import { IsIn, IsString, MaxLength, MinLength } from "class-validator";
import type { Automation } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { Auth, ClientIp, RequirePermission } from "../common/decorators";
import { scheduleJob } from "../common/jobs";
import { num } from "../common/money";
import { MailService } from "../mail/mail.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";

export const TRIGGERS = ["Venda realizada", "Venda cancelada", "Conta vencida", "Conta recebida", "Estoque baixo", "Novo cliente", "Novo produto"] as const;
export const ACTIONS = ["Enviar email", "Enviar notificação", "Criar alerta", "Atualizar status", "Enviar webhook", "Enviar WhatsApp (em breve)"] as const;
export const CONDITIONS = ["Sempre", "Valor > R$ 1.000", "Valor > R$ 5.000", "Atraso > 3 dias", "Estoque < mínimo", "Cliente novo"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export interface EventPayload { title: string; amount?: number; daysLate?: number; stock?: number; minStock?: number; }

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
export class AutomationDto {
  @Transform(trim) @IsString({ message: "Informe um nome." }) @MinLength(2, { message: "Informe um nome." }) @MaxLength(80) name: string;
  @IsIn(TRIGGERS as unknown as string[], { message: "Gatilho inválido." }) trigger: string;
  @IsIn(CONDITIONS as unknown as string[], { message: "Condição inválida." }) condition: string;
  @IsIn(ACTIONS as unknown as string[], { message: "Ação inválida." }) action: string;
}

export const automationDto = (a: Automation) => ({
  id: a.id, name: a.name, status: a.status, trigger: a.trigger, condition: a.condition, action: a.action, lastRun: a.lastRunAt?.toISOString() ?? "", runs: a.runs,
});

export function conditionMatches(condition: string, e: EventPayload): boolean {
  if (condition === "Sempre" || condition === "Cliente novo") return true;
  const value = /^Valor > R\$ ([\d.]+)$/.exec(condition);
  if (value) return (e.amount ?? 0) > Number(value[1].replace(/\./g, ""));
  const late = /^Atraso > (\d+) dias$/.exec(condition);
  if (late) return (e.daysLate ?? 0) > Number(late[1]);
  if (condition === "Estoque < mínimo") return e.stock !== undefined && e.minStock !== undefined && e.stock < e.minStock;
  return false;
}

@Injectable()
export class AutomationsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Automations");
  private stop?: () => void;

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly notifications: NotificationsService, private readonly mail: MailService) {}

  onModuleInit() { this.stop = scheduleJob(this.prisma, this.log, "automations.scan-overdue", 3_600_000, () => this.scanOverdue()); }
  onModuleDestroy() { this.stop?.(); }

  async list(ctx: AuthContext) { return (await this.prisma.automation.findMany({ where: { organizationId: orgOf(ctx) }, orderBy: { createdAt: "desc" } })).map(automationDto); }

  async get(ctx: AuthContext, id: string) {
    const a = await this.prisma.automation.findFirst({ where: { id, organizationId: orgOf(ctx) } });
    if (!a) throw new NotFoundException();
    return automationDto(a);
  }

  async create(ctx: AuthContext, dto: AutomationDto, ip: string) {
    const orgId = orgOf(ctx);
    const a = await this.prisma.automation.create({ data: { organizationId: orgId, name: dto.name, trigger: dto.trigger, condition: dto.condition, action: dto.action } });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "automation.create", entity: "automation", entityId: a.id, text: `${ctx.user.name} criou a automação "${a.name}"`, ip });
    return automationDto(a);
  }

  async toggle(ctx: AuthContext, id: string, ip: string) {
    const orgId = orgOf(ctx);
    const cur = await this.prisma.automation.findFirst({ where: { id, organizationId: orgId } });
    if (!cur) throw new NotFoundException();
    const a = await this.prisma.automation.update({ where: { id }, data: { status: cur.status === "ativa" ? "pausada" : "ativa" } });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "automation.toggle", entity: "automation", entityId: id, text: `${ctx.user.name} ${a.status === "ativa" ? "ativou" : "pausou"} a automação "${a.name}"`, ip });
    return automationDto(a);
  }

  async fire(organizationId: string, trigger: Trigger, event: EventPayload): Promise<void> {
    try {
      const rules = await this.prisma.automation.findMany({ where: { organizationId, trigger, status: "ativa" } });
      for (const rule of rules) if (conditionMatches(rule.condition, event)) await this.run(rule, event);
    } catch (e) { this.log.error(`Falha ao processar automações (${trigger}): ${(e as Error).message}`); }
  }

  private async run(rule: Automation, e: EventPayload) {
    let failed: string | null = null;
    switch (rule.action) {
      case "Enviar notificação":
        await this.notifications.notify(rule.organizationId, "Automação", rule.name, e.title); break;
      case "Criar alerta":
        await this.notifications.notify(rule.organizationId, "Sistema", `Alerta: ${rule.name}`, e.title); break;
      case "Enviar email": {
        const owner = await this.prisma.membership.findFirst({ where: { organizationId: rule.organizationId, role: "owner", status: "ativo" }, include: { user: true } });
        if (owner) await this.mail.send(owner.user.email, rule.name, e.title); else failed = "A empresa não tem um responsável ativo para receber o e-mail.";
        break;
      }
      case "Enviar webhook": failed = "Nenhum endereço de webhook configurado."; break;
      default: failed = `A ação "${rule.action}" ainda não está disponível.`;
    }
    await this.prisma.automation.update({ where: { id: rule.id }, data: { runs: { increment: 1 }, lastRunAt: new Date(), ...(failed ? { status: "erro" as const } : {}) } });
    if (failed) await this.notifications.notify(rule.organizationId, "Automação", `Falha em '${rule.name}'`, failed);
  }

  async scanOverdue() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const overdue = await this.prisma.financeEntry.findMany({ where: { status: "pendente", dueDate: { lt: today }, organization: { automations: { some: { trigger: "Conta vencida", status: "ativa" } } } }, take: 500 });
    for (const en of overdue) {
      const daysLate = Math.floor((today.getTime() - en.dueDate.getTime()) / 86_400_000);
      await this.fire(en.organizationId, "Conta vencida", { title: `${en.description} — ${en.party} venceu há ${daysLate} dia(s)`, amount: num(en.amount), daysLate });
    }
  }
}

@Controller("automations")
export class AutomationsController {
  constructor(private readonly svc: AutomationsService) {}
  @RequirePermission("automations:view") @Get() list(@Auth() ctx: AuthContext) { return this.svc.list(ctx); }
  @RequirePermission("automations:view") @Get(":id") get(@Auth() ctx: AuthContext, @Param("id") id: string) { return this.svc.get(ctx, id); }
  @RequirePermission("automations:create") @Post() create(@Auth() ctx: AuthContext, @Body() dto: AutomationDto, @ClientIp() ip: string) { return this.svc.create(ctx, dto, ip); }
  @RequirePermission("automations:edit") @Post(":id/toggle") toggle(@Auth() ctx: AuthContext, @Param("id") id: string, @ClientIp() ip: string) { return this.svc.toggle(ctx, id, ip); }
}

@Global()
@Module({ controllers: [AutomationsController], providers: [AutomationsService], exports: [AutomationsService] })
export class AutomationsModule {}
