import { Injectable } from "@nestjs/common";
import type { Organization } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import type { AuthContext } from "../common/auth-context";
import { orgOf } from "../common/auth-context";
import { formatCnpj } from "../common/cnpj";
import { PrismaService } from "../prisma/prisma.service";
import type { CompanyDto } from "./company.dto";

const dto = (o: Organization) => ({ id: o.id, name: o.name, cnpj: o.cnpj, email: o.email, phone: o.phone, address: o.address, city: o.city, state: o.state, segment: o.segment, plan: o.plan });

@Injectable()
export class CompanyService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async get(ctx: AuthContext) {
    return dto(await this.prisma.organization.findUniqueOrThrow({ where: { id: orgOf(ctx) } }));
  }

  private data(i: CompanyDto) {
    return { name: i.name, cnpj: formatCnpj(i.cnpj), email: i.email, phone: i.phone, address: i.address ?? "", city: i.city, state: i.state.toUpperCase(), segment: i.segment ?? "" };
  }

  async create(ctx: AuthContext, input: CompanyDto, ip: string) {
    const pending = await this.prisma.membership.findFirst({ where: { userId: ctx.user.id, role: "owner", status: "ativo", organization: { onboarded: false } }, include: { organization: true } });
    const org = pending
      ? await this.prisma.organization.update({ where: { id: pending.organizationId }, data: { ...this.data(input), onboarded: true } })
      : await this.prisma.organization.create({ data: { ...this.data(input), onboarded: true, trialEndsAt: new Date(Date.now() + 14 * 86_400_000), renewsAt: new Date(Date.now() + 14 * 86_400_000), memberships: { create: { userId: ctx.user.id, role: "owner", status: "ativo" } } } });
    await this.audit.log({ organizationId: org.id, userId: ctx.user.id, action: "company.create", entity: "organization", entityId: org.id, text: `${ctx.user.name} cadastrou a empresa ${org.name}`, ip });
    return dto(org);
  }

  async update(ctx: AuthContext, input: CompanyDto, ip: string) {
    const org = await this.prisma.organization.update({ where: { id: orgOf(ctx) }, data: this.data(input) });
    await this.audit.log({ organizationId: org.id, userId: ctx.user.id, action: "company.update", entity: "organization", entityId: org.id, text: `${ctx.user.name} atualizou os dados da empresa`, ip });
    return dto(org);
  }

  async auditTrail(ctx: AuthContext) {
    const rows = await this.audit.recent(orgOf(ctx));
    return rows.map((r) => ({ id: r.id, text: r.text, date: r.createdAt.toISOString() }));
  }
}
