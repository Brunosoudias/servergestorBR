import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";
import * as bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import type { Prisma, User } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { hashToken } from "../common/guards/session.guard";
import { type ListQuery, page, skipTake } from "../common/pagination";
import { onlyExtra, ROLES, unknownPermissions } from "../common/permissions";
import { MailService } from "../mail/mail.service";
import { PrismaService } from "../prisma/prisma.service";

const lower = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,72}$/;

export class InviteDto {
  @Transform(lower) @IsEmail({}, { message: "Informe um e-mail válido." }) email: string;
  @IsIn(ROLES, { message: "Função inválida." }) role: string;
}
export class CreateUserDto {
  @Transform(trim) @IsString() @MinLength(2, { message: "Informe o nome." }) @MaxLength(80) name: string;
  @Transform(lower) @IsEmail({}, { message: "Informe um e-mail válido." }) @MaxLength(160) email: string;
  @IsString() @Matches(PASSWORD_RULE, { message: "A senha deve ter de 8 a 72 caracteres, com letras e números." }) password: string;
  @IsIn(ROLES, { message: "Função inválida." }) role: string;
}
const blankToUndefined = ({ value }: { value: unknown }) => (typeof value === "string" && value.trim() === "" ? undefined : value);

export class UpdateMemberDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2, { message: "Informe o nome." }) @MaxLength(80) name?: string;
  @IsOptional() @IsIn(ROLES, { message: "Função inválida." }) role?: string;
  @IsOptional() @IsIn(["ativo", "inativo"], { message: "Status inválido." }) status?: string;
  @IsOptional() @Transform(blankToUndefined) @IsString() @Matches(PASSWORD_RULE, { message: "A senha deve ter de 8 a 72 caracteres, com letras e números." }) password?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(80) @IsString({ each: true }) extraPermissions?: string[];
}

const toDto = (m: { role: string; status: string; extraPermissions: string[]; user: User }) => ({
  id: m.user.id, name: m.user.name, email: m.user.email, role: m.role, status: m.status, extraPermissions: m.extraPermissions,
  lastAccess: (m.user.lastAccessAt ?? m.user.createdAt).toISOString(),
});

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

  private assertAssignable(ctx: AuthContext, role: string, verb: "convidar" | "criar") {
    if (role === "owner") throw new BadRequestException(verb === "criar" ? "Não é possível criar outro superadmin." : "Não é possível convidar outro superadmin.");
    if (role === "admin" && ctx.role !== "owner") throw new ForbiddenException("Apenas o superadmin pode criar administradores.");
  }

  async create(ctx: AuthContext, input: CreateUserDto, ip: string) {
    const orgId = orgOf(ctx);
    this.assertAssignable(ctx, input.role, "criar");
    if (await this.prisma.user.findUnique({ where: { email: input.email } })) throw new ConflictException("Este e-mail já está cadastrado.");
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await this.prisma.user.create({ data: { name: input.name, email: input.email, passwordHash, lastAccessAt: null } });
    const member = await this.prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role: input.role as never, status: "ativo" }, include: { user: true } });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "user.create", entity: "user", entityId: user.id, text: `${ctx.user.name} criou ${user.email} como ${input.role}`, ip });
    return toDto(member);
  }

  async invite(ctx: AuthContext, input: InviteDto, ip: string) {
    const orgId = orgOf(ctx);
    this.assertAssignable(ctx, input.role, "convidar");

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
    if (member.role === "owner") throw new ForbiddenException("O superadmin não pode ser alterado.");
    if (userId === ctx.user.id) throw new ForbiddenException("Você não pode alterar seu próprio acesso.");
    if (input.role === "owner") throw new BadRequestException("Não é possível promover a superadmin.");
    if ((input.role === "admin" || member.role === "admin") && ctx.role !== "owner") throw new ForbiddenException("Apenas o superadmin pode alterar administradores.");
    if (member.status === "convidado" && input.status === "ativo") throw new BadRequestException("O usuário ativa o acesso ao aceitar o convite.");
    if (input.extraPermissions) {
      const unknown = unknownPermissions(input.extraPermissions);
      if (unknown.length) throw new BadRequestException("Há uma permissão inválida na lista.");
    }

    const role = input.role ?? member.role;
    const extraPermissions = input.extraPermissions ? onlyExtra(role, input.extraPermissions) : input.role ? onlyExtra(role, member.extraPermissions) : undefined;
    if (input.name || input.password) {
      await this.prisma.user.update({ where: { id: userId }, data: { ...(input.name ? { name: input.name } : {}), ...(input.password ? { passwordHash: await bcrypt.hash(input.password, 12) } : {}) } });
    }
    const updated = await this.prisma.membership.update({
      where: { id: member.id },
      data: { ...(input.role ? { role: input.role as never } : {}), ...(input.status ? { status: input.status as never } : {}), ...(extraPermissions ? { extraPermissions } : {}) },
      include: { user: true },
    });
    if (input.status === "inativo" || input.password) await this.prisma.session.deleteMany({ where: { userId } });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "user.update", entity: "user", entityId: userId, text: `${ctx.user.name} alterou o acesso de ${member.user.email}`, ip });
    return toDto(updated);
  }
}
