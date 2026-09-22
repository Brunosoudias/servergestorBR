import { ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, UnauthorizedException, BadRequestException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import type { Membership, Organization, User } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { ROLE_PERMISSIONS, type RoleName } from "../common/permissions";
import { hashToken } from "../common/guards/session.guard";
import { ENV, type Env } from "../config/env";
import { MailService } from "../mail/mail.service";
import { PrismaService } from "../prisma/prisma.service";

const BCRYPT_COST = 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const DUMMY_HASH = bcrypt.hashSync(randomBytes(12).toString("hex"), BCRYPT_COST);

export interface SessionDto {
  user: { id: string; name: string; email: string; role: string; status: string; lastAccess: string };
  organization: { id: string; name: string; cnpj: string; plan: string };
  organizations: { id: string; name: string; cnpj: string; plan: string }[];
  permissions: string[];
}

const orgDto = (o: Organization) => ({ id: o.id, name: o.name, cnpj: o.cnpj, plan: o.plan });

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly mail: MailService, @Inject(ENV) private readonly env: Env) {}

  private async createSession(userId: string, userAgent: string, ip: string) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.env.cookie.ttlDays * 86400000);
    await this.prisma.session.create({ data: { userId, tokenHash: hashToken(token), userAgent: userAgent.slice(0, 200), ip, expiresAt } });
    await this.prisma.session.deleteMany({ where: { userId, expiresAt: { lt: new Date() } } }).catch(() => undefined);
    return { token, expiresAt };
  }

  async buildSession(user: User, activeOrgId: string | null): Promise<SessionDto> {
    const memberships = await this.prisma.membership.findMany({ where: { userId: user.id, status: "ativo" }, include: { organization: true }, orderBy: { createdAt: "asc" } });
    const active: (Membership & { organization: Organization }) | undefined = memberships.find((m) => m.organizationId === activeOrgId) ?? memberships[0];
    if (!active) throw new ForbiddenException("Sua conta não está vinculada a nenhuma empresa ativa.");
    return {
      user: { id: user.id, name: user.name, email: user.email, role: active.role, status: active.status, lastAccess: (user.lastAccessAt ?? user.createdAt).toISOString() },
      organization: orgDto(active.organization),
      organizations: memberships.map((m) => orgDto(m.organization)),
      permissions: ROLE_PERMISSIONS[active.role as RoleName],
    };
  }

  async register(input: { name: string; email: string; password: string }, ua: string, ip: string) {
    if (await this.prisma.user.findUnique({ where: { email: input.email } })) throw new ConflictException("Este e-mail já está cadastrado. Tente entrar ou redefinir a senha.");
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
    const first = input.name.split(" ")[0];
    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { name: input.name, email: input.email, passwordHash, lastAccessAt: new Date() } });
      const org = await tx.organization.create({ data: { name: `Empresa de ${first}`, email: input.email, onboarded: false, trialEndsAt: new Date(Date.now() + 14 * 86_400_000), renewsAt: new Date(Date.now() + 14 * 86_400_000) } });
      await tx.membership.create({ data: { userId: u.id, organizationId: org.id, role: "owner", status: "ativo" } });
      return u;
    });
    const org = await this.prisma.membership.findFirst({ where: { userId: user.id }, select: { organizationId: true } });
    await this.audit.log({ organizationId: org?.organizationId, userId: user.id, action: "auth.register", text: `${user.name} criou a conta`, ip });
    const { token, expiresAt } = await this.createSession(user.id, ua, ip);
    return { token, expiresAt, session: await this.buildSession(user, org?.organizationId ?? null) };
  }

  async login(input: { email: string; password: string }, ua: string, ip: string) {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      throw new HttpException(`Muitas tentativas incorretas. Tente novamente em alguns minutos.`, HttpStatus.TOO_MANY_REQUESTS);
    }
    const ok = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.passwordHash || !ok) {
      if (user) {
        const failed = user.failedAttempts + 1;
        await this.prisma.user.update({ where: { id: user.id }, data: failed >= MAX_FAILED ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000) } : { failedAttempts: failed } });
        await this.audit.log({ userId: user.id, action: "auth.login_failed", text: `Tentativa de login incorreta (${failed})`, ip });
      }
      throw new UnauthorizedException("E-mail ou senha incorretos.");
    }
    const updated = await this.prisma.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null, lastAccessAt: new Date() } });
    const session = await this.buildSession(updated, null);
    const { token, expiresAt } = await this.createSession(user.id, ua, ip);
    await this.audit.log({ organizationId: session.organization.id, userId: user.id, action: "auth.login", text: `${user.name} entrou no sistema`, ip });
    return { token, expiresAt, session };
  }

  async logoutByToken(token: string) {
    await this.prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return { ok: true };
    await this.prisma.authToken.updateMany({ where: { userId: user.id, type: "password_reset", usedAt: null }, data: { usedAt: new Date() } });
    const token = randomBytes(32).toString("base64url");
    await this.prisma.authToken.create({ data: { userId: user.id, type: "password_reset", tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3600000) } });
    await this.mail.passwordReset(user.email, user.name, token);
    return { ok: true };
  }

  async resetPassword(token: string, password: string) {
    const rec = await this.prisma.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!rec || rec.usedAt || rec.expiresAt < new Date()) throw new BadRequestException("Link inválido ou expirado. Solicite um novo.");
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: rec.userId }, data: { passwordHash, failedAttempts: 0, lockedUntil: null } }),
      this.prisma.authToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
      this.prisma.session.deleteMany({ where: { userId: rec.userId } }),
      ...(rec.type === "invite" && rec.organizationId
        ? [this.prisma.membership.updateMany({ where: { userId: rec.userId, organizationId: rec.organizationId, status: "convidado" }, data: { status: "ativo" } })]
        : []),
    ]);
    await this.audit.log({ organizationId: rec.organizationId, userId: rec.userId, action: rec.type === "invite" ? "auth.invite_accepted" : "auth.password_reset", text: rec.type === "invite" ? "Convite aceito e senha definida" : "Senha redefinida" });
    return { ok: true };
  }
}
