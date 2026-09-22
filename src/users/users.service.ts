import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { IsEmail, IsIn, IsOptional } from "class-validator";
import { Transform } from "class-transformer";
import { randomBytes } from "crypto";
import type { Prisma, User } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { hashToken } from "../common/guards/session.guard";
import { type ListQuery, page, skipTake } from "../common/pagination";
import { ROLES } from "../common/permissions";
import { MailService } from "../mail/mail.service";
import { PrismaService } from "../prisma/prisma.service";

export class InviteDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value)) @IsEmail({}, { message: "Informe um e-mail válido." }) email: string;
  @IsIn(ROLES, { message: "Função inválida." }) role: string;
}
export class UpdateMemberDto {
  @IsOptional() @IsIn(ROLES, { message: "Função inválida." }) role?: string;
  @IsOptional() @IsIn(["ativo", "inativo"], { message: "Status inválido." }) status?: string;
}

const toDto = (m: { role: string; status: string; user: User }) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.role, status: m.status, lastAccess: (m.user.lastAccessAt ?? m.user.createdAt).toISOString() });

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly mail: MailService) {}

  async list(ctx: AuthContext, q: ListQuery) {
    const where: Prisma.MembershipWhereInput = {
      organizationId: orgOf(ctx),
      ...(q.status && q.status !== "all" ? { status: q.status as never } : {}),
      ...(q.search ? { user: { OR: [{ name: { contains: q.search, mode: "insensitive" } }, { email: { contains: q.search, mode: "insensitive" } }] } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.membership.findMany({ where, include: { user: true }, orderBy: { createdAt: "asc" }, ...skipTake(q) }),
      this.prisma.membership.count({ where }),
    ]);
    return page(rows.map(toDto), total, q);
  }

  async invite(ctx: AuthContext, input: InviteDto, ip: string) {
    const orgId = orgOf(ctx);
    if (input.role === "owner") throw new BadRequestException("Não é possível convidar outro proprietário.");
    if (input.role === "admin" && ctx.role !== "owner") throw new ForbiddenException("Apenas o proprietário pode convidar administradores.");

    let user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (user && (await this.prisma.membership.findUnique({ where: { userId_organizationId: { userId: user.id, organizationId: orgId } } }))) {
      throw new ConflictException("Este usuário já faz parte da empresa.");
    }
    user ??= await this.prisma.user.create({ data: { name: input.email.split("@")[0], email: input.email } });
    const member = await this.prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role: input.role as never, status: "convidado" }, include: { user: true } });

    const token = randomBytes(32).toString("base64url");
    await this.prisma.authToken.create({ data: { userId: user.id, type: "invite", tokenHash: hashToken(token), organizationId: orgId, expiresAt: new Date(Date.now() + 7 * 86400000) } });
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    await this.mail.invite(user.email, org.name, ctx.user.name, token);
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "user.invite", entity: "user", entityId: user.id, text: `${ctx.user.name} convidou ${user.email} como ${input.role}`, ip });
    return toDto(member);
  }

  async update(ctx: AuthContext, userId: string, input: UpdateMemberDto, ip: string) {
    const orgId = orgOf(ctx);
    const member = await this.prisma.membership.findUnique({ where: { userId_organizationId: { userId, organizationId: orgId } }, include: { user: true } });
    if (!member) throw new NotFoundException();
    if (member.role === "owner") throw new ForbiddenException("O proprietário não pode ser alterado.");
    if (userId === ctx.user.id) throw new ForbiddenException("Você não pode alterar seu próprio acesso.");
    if (input.role === "owner") throw new BadRequestException("Não é possível promover a proprietário.");
    if ((input.role === "admin" || member.role === "admin") && ctx.role !== "owner") throw new ForbiddenException("Apenas o proprietário pode alterar administradores.");
    if (member.status === "convidado" && input.status === "ativo") throw new BadRequestException("O usuário ativa o acesso ao aceitar o convite.");

    const updated = await this.prisma.membership.update({ where: { id: member.id }, data: { ...(input.role ? { role: input.role as never } : {}), ...(input.status ? { status: input.status as never } : {}) }, include: { user: true } });
    if (input.status === "inativo") await this.prisma.session.deleteMany({ where: { userId } });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "user.update", entity: "user", entityId: userId, text: `${ctx.user.name} alterou o acesso de ${member.user.email}`, ip });
    return toDto(updated);
  }
}
