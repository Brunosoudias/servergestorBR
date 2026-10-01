import { ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import type { Organization } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import type { AuthContext } from "../common/auth-context";
import { orgOf } from "../common/auth-context";
import { formatCnpj } from "../common/cnpj";
import { PrismaService } from "../prisma/prisma.service";
import type { CompanyDto } from "./company.dto";

const dto = (o: Organization) => ({ id: o.id, name: o.name, cnpj: o.cnpj ?? "", email: o.email, phone: o.phone, address: o.address, city: o.city, state: o.state, segment: o.segment, plan: o.plan });

@Injectable()
export class CompanyService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async get(ctx: AuthContext) {
    return dto(await this.prisma.organization.findUniqueOrThrow({ where: { id: orgOf(ctx) } }));
  }

  private data(i: CompanyDto) {
    return { name: i.name, cnpj: formatCnpj(i.cnpj), email: i.email, phone: i.phone, address: i.address ?? "", city: i.city, state: i.state.toUpperCase(), segment: i.segment ?? "" };
  }

  private async assertCnpjFree(cnpj: string, orgId: string) {
    if (await this.prisma.organization.findFirst({ where: { cnpj, id: { not: orgId } }, select: { id: true } })) {
      throw new ConflictException("Já existe uma empresa cadastrada com este CNPJ. Se ela é sua, peça acesso ao responsável ou fale com o suporte.");
    }
  }

  /** Conclui o onboarding da empresa criada no cadastro. Novas empresas são abertas pela plataforma (superadmin). */
  async create(ctx: AuthContext, input: CompanyDto, ip: string) {
    const pending = await this.prisma.membership.findFirst({ where: { userId: ctx.user.id, role: "owner", status: "ativo", organization: { onboarded: false, suspendedAt: null } } });
    if (!pending) throw new ForbiddenException("Sua empresa já está cadastrada. Para abrir outra empresa, fale com o suporte.");
    const data = this.data(input);
    await this.assertCnpjFree(data.cnpj, pending.organizationId);
    const org = await this.prisma.organization.update({ where: { id: pending.organizationId }, data: { ...data, onboarded: true } });
    await this.audit.log({ organizationId: org.id, userId: ctx.user.id, action: "company.create", entity: "organization", entityId: org.id, text: `${ctx.user.name} cadastrou a empresa ${org.name}`, ip });
    return dto(org);
  }

  async update(ctx: AuthContext, input: CompanyDto, ip: string) {
    const orgId = orgOf(ctx);
    const data = this.data(input);
    await this.assertCnpjFree(data.cnpj, orgId);
    const org = await this.prisma.organization.update({ where: { id: orgId }, data });
    await this.audit.log({ organizationId: org.id, userId: ctx.user.id, action: "company.update", entity: "organization", entityId: org.id, text: `${ctx.user.name} atualizou os dados da empresa`, ip });
    return dto(org);
  }

  async auditTrail(ctx: AuthContext) {
    const rows = await this.audit.recent(orgOf(ctx));
    return rows.map((r) => ({ id: r.id, text: r.text, date: r.createdAt.toISOString() }));
  }
}
