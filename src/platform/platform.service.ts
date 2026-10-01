import { BadRequestException, Body, CanActivate, ConflictException, Controller, ExecutionContext, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { Transform } from "class-transformer";
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import * as bcrypt from "bcryptjs";
import type { Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, type AuthedRequest, hasSuperPowers } from "../common/auth-context";
import { formatCnpj } from "../common/cnpj";
import { Auth, ClientIp, NoOrg } from "../common/decorators";
import { PASSWORD_MSG, PASSWORD_RULE } from "../common/password";
import { ListQuery, page, skipTake } from "../common/pagination";
import { effectiveStatus } from "../common/subscription-state";
import { CompanyDto } from "../company/company.dto";
import { PrismaService } from "../prisma/prisma.service";
import { PLAN_LIMITS, type PlanId, TRIAL_DAYS } from "../subscription/subscription.service";

const PLANS = Object.keys(PLAN_LIMITS);
const STATUSES = ["trial", "active", "cancelled"] as const;
const DAY = 86_400_000;

export class CreatePlatformCompanyDto extends CompanyDto {
  @IsIn(PLANS, { message: "Plano inválido." }) plan: PlanId;
  @IsIn(["trial", "active"], { message: "Situação inválida." }) subscriptionStatus: "trial" | "active";
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value)) @IsString() @MinLength(2, { message: "Informe o nome do administrador." }) @MaxLength(80) adminName: string;
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value)) @IsEmail({}, { message: "Informe um e-mail válido para o administrador." }) @MaxLength(160) adminEmail: string;
  @IsOptional() @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MSG }) adminPassword?: string;
}

export class UpdatePlatformCompanyDto {
  @IsOptional() @IsIn(PLANS, { message: "Plano inválido." }) plan?: PlanId;
  @IsOptional() @IsIn(STATUSES, { message: "Situação inválida." }) subscriptionStatus?: (typeof STATUSES)[number];
  @IsOptional() @IsBoolean() suspended?: boolean;
}

@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const user = ctx.switchToHttp().getRequest<AuthedRequest>().auth?.user;
    if (!user?.isSuperAdmin) throw new ForbiddenException("Apenas o superadmin da plataforma pode gerenciar empresas.");
    if (!hasSuperPowers(user)) throw new ForbiddenException({ message: "Ative a verificação em duas etapas em Configurações > Segurança para gerenciar as empresas.", code: "mfa_required" });
    return true;
  }
}

const withCounts = { _count: { select: { memberships: { where: { status: { not: "inativo" } } } } } } satisfies Prisma.OrganizationInclude;
const withAdmin = { memberships: { where: { role: { in: ["admin", "owner"] } }, include: { user: true }, orderBy: { createdAt: "asc" }, take: 1 } } satisfies Prisma.OrganizationInclude;
type OrgRow = Prisma.OrganizationGetPayload<{ include: typeof withCounts & typeof withAdmin }>;

const toDto = (o: OrgRow) => ({
  id: o.id, name: o.name, cnpj: o.cnpj ?? "", email: o.email, city: o.city, state: o.state, plan: o.plan,
  status: effectiveStatus(o), suspended: !!o.suspendedAt, users: o._count.memberships, userLimit: PLAN_LIMITS[o.plan].users,
  admin: o.memberships[0] ? { name: o.memberships[0].user.name, email: o.memberships[0].user.email } : null,
  createdAt: o.createdAt.toISOString(),
});

@Injectable()
export class PlatformService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(q: ListQuery) {
    const where: Prisma.OrganizationWhereInput = {
      ...(q.status === "suspensa" ? { suspendedAt: { not: null } } : q.status === "ativa" ? { suspendedAt: null } : {}),
      ...(q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { cnpj: { contains: q.search } }, { email: { contains: q.search, mode: "insensitive" } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.organization.findMany({ where, include: { ...withCounts, ...withAdmin }, orderBy: { createdAt: "desc" }, ...skipTake(q) }),
      this.prisma.organization.count({ where }),
    ]);
    return page(rows.map(toDto), total, q);
  }

  async create(ctx: AuthContext, input: CreatePlatformCompanyDto, ip: string) {
    const cnpj = formatCnpj(input.cnpj);
    if (await this.prisma.organization.findFirst({ where: { cnpj } })) throw new ConflictException("Já existe uma empresa cadastrada com este CNPJ.");
    const existing = await this.prisma.user.findUnique({ where: { email: input.adminEmail } });
    if (existing?.isSuperAdmin) throw new BadRequestException("O superadmin já acessa todas as empresas. Informe outro e-mail para o administrador.");
    if (!existing && !input.adminPassword) throw new BadRequestException("Defina a senha inicial do administrador.");

    const now = Date.now();
    const trial = input.subscriptionStatus === "trial";
    const org = await this.prisma.$transaction(async (tx) => {
      const admin = existing ?? await tx.user.create({ data: { name: input.adminName, email: input.adminEmail, passwordHash: await bcrypt.hash(input.adminPassword!, 12), mustChangePassword: true } });
      return tx.organization.create({
        data: {
          name: input.name, cnpj, email: input.email, phone: input.phone, address: input.address ?? "", city: input.city, state: input.state.toUpperCase(), segment: input.segment ?? "",
          plan: input.plan, onboarded: true, subscriptionStatus: input.subscriptionStatus,
          trialEndsAt: trial ? new Date(now + TRIAL_DAYS * DAY) : null,
          renewsAt: new Date(now + (trial ? TRIAL_DAYS : 30) * DAY),
          memberships: { create: { userId: admin.id, role: "admin", status: "ativo" } },
        },
        include: { ...withCounts, ...withAdmin },
      });
    });
    await this.audit.log({ organizationId: org.id, userId: ctx.user.id, action: "platform.company_create", entity: "organization", entityId: org.id, text: `${ctx.user.name} cadastrou a empresa ${org.name} no plano ${org.plan}, com ${input.adminEmail} como admin`, ip });
    return toDto(org);
  }

  async update(ctx: AuthContext, id: string, input: UpdatePlatformCompanyDto, ip: string) {
    const current = await this.prisma.organization.findUnique({ where: { id } });
    if (!current) throw new NotFoundException();
    const now = Date.now();
    const data: Prisma.OrganizationUpdateInput = {
      ...(input.plan ? { plan: input.plan } : {}),
      ...(input.subscriptionStatus ? { subscriptionStatus: input.subscriptionStatus, cancelAtPeriodEnd: false } : {}),
      ...(input.subscriptionStatus === "active" && current.subscriptionStatus !== "active" ? { renewsAt: new Date(now + 30 * DAY) } : {}),
      ...(input.subscriptionStatus === "trial" && current.subscriptionStatus !== "trial" ? { trialEndsAt: new Date(now + TRIAL_DAYS * DAY), renewsAt: new Date(now + TRIAL_DAYS * DAY) } : {}),
      ...(input.suspended === undefined ? {} : { suspendedAt: input.suspended ? current.suspendedAt ?? new Date() : null }),
    };
    const org = await this.prisma.organization.update({ where: { id }, data, include: { ...withCounts, ...withAdmin } });
    const changes = [
      input.plan && input.plan !== current.plan ? `plano para ${input.plan}` : "",
      input.subscriptionStatus && input.subscriptionStatus !== current.subscriptionStatus ? `situação para ${input.subscriptionStatus}` : "",
      input.suspended === true && !current.suspendedAt ? "suspendeu o acesso" : "",
      input.suspended === false && current.suspendedAt ? "reativou o acesso" : "",
    ].filter(Boolean);
    if (changes.length) await this.audit.log({ organizationId: id, userId: ctx.user.id, action: "platform.company_update", entity: "organization", entityId: id, text: `${ctx.user.name} alterou a empresa ${org.name}: ${changes.join(", ")}`, ip });
    return toDto(org);
  }
}

@NoOrg()
@UseGuards(SuperAdminGuard)
@Controller("platform/companies")
export class PlatformController {
  constructor(private readonly svc: PlatformService) {}
  @Get() list(@Query() q: ListQuery) { return this.svc.list(q); }
  @Post() create(@Auth() ctx: AuthContext, @Body() dto: CreatePlatformCompanyDto, @ClientIp() ip: string) { return this.svc.create(ctx, dto, ip); }
  @Patch(":id") update(@Auth() ctx: AuthContext, @Param("id") id: string, @Body() dto: UpdatePlatformCompanyDto, @ClientIp() ip: string) { return this.svc.update(ctx, id, dto, ip); }
}

@Module({ controllers: [PlatformController], providers: [PlatformService, SuperAdminGuard] })
export class PlatformModule {}
