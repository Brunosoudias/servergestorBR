import { ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, UnauthorizedException, BadRequestException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { createHash, randomBytes } from "crypto";
import type { Membership, Organization, User } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { hasSuperPowers } from "../common/auth-context";
import { BCRYPT_COST, isLocked, passwordMatches, registerFailure } from "../common/login-attempts";
import { permissionsOf } from "../common/permissions";
import { hashToken } from "../common/guards/session.guard";
import { decryptSecret, encryptSecret } from "../common/secret";
import { generateRecoveryCodes, generateTotpSecret, normalizeRecoveryCode, otpauthUrl, RECOVERY_CODE_RE, verifyTotp } from "../common/totp";
import { ENV, type Env } from "../config/env";
import { MailService } from "../mail/mail.service";
import { PrismaService } from "../prisma/prisma.service";

const MFA_CHALLENGE_MS = 5 * 60 * 1000;
const MFA_ISSUER = "Gestor Br";

export interface SessionDto {
  user: { id: string; name: string; email: string; role: string; status: string; lastAccess: string; isSuperAdmin: boolean; mfaEnabled: boolean; mustChangePassword: boolean };
  organization: { id: string; name: string; cnpj: string; plan: string };
  organizations: { id: string; name: string; cnpj: string; plan: string }[];
  permissions: string[];
}

export type LoginResult = { token: string; expiresAt: Date; session: SessionDto } | { mfaChallenge: string };

const orgDto = (o: Organization) => ({ id: o.id, name: o.name, cnpj: o.cnpj ?? "", plan: o.plan });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** Navegador + sistema, sem números de versão: atualizar o navegador não conta como dispositivo novo. */
const deviceHash = (userId: string, ua: string) => sha256(`${userId}:${ua.replace(/[\d._]+/g, "").replace(/\s+/g, " ").trim().toLowerCase()}`);

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
    const superPowers = hasSuperPowers(user);
    const memberships: (Pick<Membership, "organizationId" | "role" | "status" | "extraPermissions"> & { organization: Organization })[] = await this.prisma.membership.findMany({
      where: { userId: user.id, status: "ativo", ...(superPowers ? {} : { organization: { suspendedAt: null } }) },
      include: { organization: true },
      orderBy: { createdAt: "asc" },
    });
    if (superPowers) {
      const own = new Set(memberships.map((m) => m.organizationId));
      const others = await this.prisma.organization.findMany({ where: { id: { notIn: [...own] } }, orderBy: { createdAt: "asc" } });
      memberships.push(...others.map((o) => ({ organizationId: o.id, role: "owner" as const, status: "ativo" as const, extraPermissions: [], organization: o })));
    }
    const active = memberships.find((m) => m.organizationId === activeOrgId) ?? memberships[0];
    if (!active) throw new ForbiddenException("Sua conta não está vinculada a nenhuma empresa ativa ou o acesso da empresa está suspenso.");
    return {
      user: {
        id: user.id, name: user.name, email: user.email, role: active.role, status: active.status, lastAccess: (user.lastAccessAt ?? user.createdAt).toISOString(),
        isSuperAdmin: user.isSuperAdmin, mfaEnabled: !!user.mfaEnabledAt, mustChangePassword: user.mustChangePassword,
      },
      organization: orgDto(active.organization),
      organizations: memberships.map((m) => orgDto(m.organization)),
      permissions: permissionsOf(active.role, active.extraPermissions),
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
    await this.trackDevice(user, ua, ip);
    const { token, expiresAt } = await this.createSession(user.id, ua, ip);
    return { token, expiresAt, session: await this.buildSession(user, org?.organizationId ?? null) };
  }

  /** Registra o dispositivo e avisa por e-mail quando a conta entra por um navegador/sistema nunca visto. */
  private async trackDevice(user: User, ua: string, ip: string) {
    const hash = deviceHash(user.id, ua);
    const known = await this.prisma.userDevice.updateMany({ where: { userId: user.id, deviceHash: hash }, data: { lastSeenAt: new Date(), lastIp: ip } });
    if (known.count) return;
    const hadOthers = (await this.prisma.userDevice.count({ where: { userId: user.id } })) > 0;
    await this.prisma.userDevice.upsert({
      where: { userId_deviceHash: { userId: user.id, deviceHash: hash } },
      create: { userId: user.id, deviceHash: hash, userAgent: ua.slice(0, 200), lastIp: ip },
      update: { lastSeenAt: new Date(), lastIp: ip },
    });
    if (hadOthers) await this.mail.newDeviceLogin(user.email, user.name, ua, ip);
  }

  private tooMany() {
    return new HttpException("Muitas tentativas incorretas. Tente novamente em alguns minutos.", HttpStatus.TOO_MANY_REQUESTS);
  }

  private async failed(user: User, what: string, ip: string) {
    const n = await registerFailure(this.prisma, user);
    await this.audit.log({ userId: user.id, action: "auth.login_failed", text: `${what} (${n})`, ip });
  }

  async login(input: { email: string; password: string }, ua: string, ip: string): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (isLocked(user)) throw this.tooMany();
    if (!(await passwordMatches(user, input.password)) || !user) {
      if (user) await this.failed(user, "Tentativa de login incorreta", ip);
      throw new UnauthorizedException("E-mail ou senha incorretos.");
    }
    // Com 2FA, o contador de falhas só zera depois do código: senha certa não pode reabrir tentativas de código.
    if (user.mfaEnabledAt) {
      const challenge = randomBytes(32).toString("base64url");
      await this.prisma.authToken.create({ data: { userId: user.id, type: "mfa_challenge", tokenHash: hashToken(challenge), expiresAt: new Date(Date.now() + MFA_CHALLENGE_MS) } });
      return { mfaChallenge: challenge };
    }
    return this.completeLogin(user, ua, ip);
  }

  async verifyMfaLogin(challenge: string, code: string, ua: string, ip: string): Promise<LoginResult> {
    const rec = await this.prisma.authToken.findUnique({ where: { tokenHash: hashToken(challenge) }, include: { user: true } });
    if (!rec || rec.type !== "mfa_challenge" || rec.usedAt || rec.expiresAt < new Date()) throw new UnauthorizedException("A verificação expirou. Entre novamente com e-mail e senha.");
    const user = rec.user;
    if (isLocked(user)) throw this.tooMany();
    if (!(await this.checkSecondFactor(user, code, ip))) {
      await this.failed(user, "Código de verificação em duas etapas incorreto", ip);
      throw new UnauthorizedException("Código de verificação inválido.");
    }
    const claimed = await this.prisma.authToken.updateMany({ where: { id: rec.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count !== 1) throw new UnauthorizedException("A verificação expirou. Entre novamente com e-mail e senha.");
    return this.completeLogin(user, ua, ip);
  }

  /** Aceita o código do app (sem reuso) ou um código de recuperação (consumido de forma atômica). */
  private async checkSecondFactor(user: User, code: string, ip: string) {
    if (!user.mfaEnabledAt || !user.mfaSecretEnc) return false;
    const recovery = normalizeRecoveryCode(code);
    if (RECOVERY_CODE_RE.test(recovery)) {
      const hash = sha256(recovery);
      const used = await this.prisma.$executeRaw`UPDATE "User" SET "mfaRecoveryCodes" = array_remove("mfaRecoveryCodes", ${hash}) WHERE "id" = ${user.id} AND ${hash} = ANY("mfaRecoveryCodes")`;
      if (!used) return false;
      const left = (await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { mfaRecoveryCodes: true } })).mfaRecoveryCodes.length;
      await this.audit.log({ userId: user.id, action: "auth.mfa_recovery_used", text: `${user.name} usou um código de recuperação (restam ${left})`, ip });
      await this.mail.mfaRecoveryUsed(user.email, user.name, left);
      return true;
    }
    const step = verifyTotp(decryptSecret(user.mfaSecretEnc, this.env.secretsKey), code, user.mfaLastStep);
    return step !== null && (await this.prisma.user.updateMany({ where: { id: user.id, mfaLastStep: { lt: step } }, data: { mfaLastStep: step } })).count === 1;
  }

  private async completeLogin(user: User, ua: string, ip: string) {
    const updated = await this.prisma.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null, lastAccessAt: new Date() } });
    await this.trackDevice(updated, ua, ip);
    const session = await this.buildSession(updated, null);
    const { token, expiresAt } = await this.createSession(user.id, ua, ip);
    await this.audit.log({ organizationId: session.organization.id, userId: user.id, action: "auth.login", text: `${user.name} entrou no sistema`, ip });
    return { token, expiresAt, session };
  }

  async logoutByToken(token: string) {
    await this.prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }

  mfaStatus(user: User) {
    return { enabled: !!user.mfaEnabledAt, required: user.isSuperAdmin, recoveryCodesLeft: user.mfaEnabledAt ? user.mfaRecoveryCodes.length : 0 };
  }

  private async issueRecoveryCodes(userId: string) {
    const codes = generateRecoveryCodes();
    await this.prisma.user.update({ where: { id: userId }, data: { mfaRecoveryCodes: codes.map(sha256) } });
    return codes;
  }

  async mfaRegenerateRecoveryCodes(user: User, code: string, ip: string) {
    const fresh = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!fresh.mfaEnabledAt || !fresh.mfaSecretEnc) throw new ConflictException("A verificação em duas etapas não está ativa.");
    if (isLocked(fresh)) throw this.tooMany();
    const step = verifyTotp(decryptSecret(fresh.mfaSecretEnc, this.env.secretsKey), code, fresh.mfaLastStep);
    if (step === null || (await this.prisma.user.updateMany({ where: { id: user.id, mfaLastStep: { lt: step } }, data: { mfaLastStep: step } })).count !== 1) {
      await this.failed(fresh, "Código incorreto ao gerar novos códigos de recuperação", ip);
      throw new BadRequestException("Código inválido. Use o código atual do app autenticador.");
    }
    const recoveryCodes = await this.issueRecoveryCodes(user.id);
    await this.audit.log({ userId: user.id, action: "auth.mfa_recovery_regenerated", text: `${user.name} gerou novos códigos de recuperação`, ip });
    return { recoveryCodes };
  }

  async mfaSetup(user: User) {
    if (user.mfaEnabledAt) throw new ConflictException("A verificação em duas etapas já está ativa.");
    const secret = generateTotpSecret();
    await this.prisma.user.update({ where: { id: user.id }, data: { mfaSecretEnc: encryptSecret(secret, this.env.secretsKey), mfaLastStep: 0 } });
    return { secret, otpauthUrl: otpauthUrl(MFA_ISSUER, user.email, secret) };
  }

  async mfaEnable(user: User, code: string, password: string, sessionId: string, ip: string) {
    const fresh = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (fresh.mfaEnabledAt) throw new ConflictException("A verificação em duas etapas já está ativa.");
    if (!fresh.mfaSecretEnc) throw new BadRequestException("Gere o QR code antes de confirmar.");
    if (isLocked(fresh)) throw this.tooMany();
    if (!(await passwordMatches(fresh, password))) {
      await this.failed(fresh, "Senha incorreta ao ativar a verificação em duas etapas", ip);
      throw new BadRequestException("Senha incorreta.");
    }
    const step = verifyTotp(decryptSecret(fresh.mfaSecretEnc, this.env.secretsKey), code, fresh.mfaLastStep);
    if (step === null) throw new BadRequestException("Código inválido. Confira o horário do celular e tente de novo.");
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { mfaEnabledAt: new Date(), mfaLastStep: step } }),
      this.prisma.session.deleteMany({ where: { userId: user.id, id: { not: sessionId } } }),
    ]);
    const recoveryCodes = await this.issueRecoveryCodes(user.id);
    await this.audit.log({ userId: user.id, action: "auth.mfa_enabled", text: `${user.name} ativou a verificação em duas etapas`, ip });
    return { enabled: true, recoveryCodes };
  }

  async mfaDisable(user: User, password: string, code: string, ip: string) {
    const fresh = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!fresh.mfaEnabledAt || !fresh.mfaSecretEnc) throw new ConflictException("A verificação em duas etapas não está ativa.");
    if (isLocked(fresh)) throw this.tooMany();
    const ok = (await passwordMatches(fresh, password)) && (await this.checkSecondFactor(fresh, code, ip));
    if (!ok) {
      await this.failed(fresh, "Tentativa incorreta de desativar a verificação em duas etapas", ip);
      throw new BadRequestException("Senha ou código inválidos.");
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { mfaEnabledAt: null, mfaSecretEnc: null, mfaRecoveryCodes: [] } });
    await this.audit.log({ userId: user.id, action: "auth.mfa_disabled", text: `${user.name} desativou a verificação em duas etapas`, ip });
    return { enabled: false };
  }

  options() {
    return { passwordRecovery: this.mail.enabled };
  }

  async changePassword(user: User, input: { currentPassword: string; password: string }, sessionId: string, ip: string) {
    const fresh = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (isLocked(fresh)) throw this.tooMany();
    if (!(await passwordMatches(fresh, input.currentPassword))) {
      await this.failed(fresh, "Senha atual incorreta ao trocar a senha", ip);
      throw new BadRequestException("A senha atual está incorreta.");
    }
    if (await bcrypt.compare(input.password, fresh.passwordHash!)) throw new BadRequestException("A nova senha precisa ser diferente da atual.");
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false, failedAttempts: 0, lockedUntil: null } }),
      this.prisma.session.deleteMany({ where: { userId: user.id, id: { not: sessionId } } }),
    ]);
    await this.audit.log({ userId: user.id, action: "auth.password_changed", text: `${user.name} trocou a senha`, ip });
    await this.mail.passwordChanged(updated.email, updated.name);
    return updated;
  }

  async forgotPassword(email: string) {
    if (!this.mail.enabled) throw new BadRequestException("A recuperação de senha por e-mail está desativada. Peça ao superadmin da sua empresa para redefinir sua senha.");
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
    if (!rec || rec.type === "mfa_challenge" || rec.usedAt || rec.expiresAt < new Date()) throw new BadRequestException("Link inválido ou expirado. Solicite um novo.");
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const [user] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: rec.userId }, data: { passwordHash, mustChangePassword: false, failedAttempts: 0, lockedUntil: null }, select: { email: true, name: true } }),
      this.prisma.authToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
      this.prisma.session.deleteMany({ where: { userId: rec.userId } }),
      ...(rec.type === "invite" && rec.organizationId
        ? [this.prisma.membership.updateMany({ where: { userId: rec.userId, organizationId: rec.organizationId, status: "convidado" }, data: { status: "ativo" } })]
        : []),
    ]);
    await this.audit.log({ organizationId: rec.organizationId, userId: rec.userId, action: rec.type === "invite" ? "auth.invite_accepted" : "auth.password_reset", text: rec.type === "invite" ? "Convite aceito e senha definida" : "Senha redefinida" });
    if (rec.type === "password_reset") await this.mail.passwordChanged(user.email, user.name);
    return { ok: true };
  }
}
