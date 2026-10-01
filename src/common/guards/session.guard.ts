import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Response } from "express";
import { createHash } from "crypto";
import { ENV, type Env } from "../../config/env";
import { PrismaService } from "../../prisma/prisma.service";
import { type AuthedRequest, hasSuperPowers } from "../auth-context";
import { ALLOW_PENDING_PASSWORD, IS_PUBLIC, NO_ORG } from "../decorators";
import { permissionsOf } from "../permissions";

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

const TOUCH_EVERY_MS = 5 * 60 * 1000; 
const ABSOLUTE_MAX_DAYS = 30; 

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService, @Inject(ENV) private readonly env: Env) {}

  async canActivate(ctx: ExecutionContext) {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const noOrg = this.reflector.getAllAndOverride<boolean>(NO_ORG, targets);

    const http = ctx.switchToHttp();
    const req = http.getRequest<AuthedRequest>();
    const res = http.getResponse<Response>();
    const token = req.cookies?.[this.env.cookie.name] as string | undefined;
    if (!token) throw new UnauthorizedException();
    const reject = () => {
      res.clearCookie(this.env.cookie.name, { httpOnly: true, secure: this.env.cookie.secure, sameSite: "lax", path: "/", domain: this.env.cookie.domain });
      return new UnauthorizedException();
    };

    const session = await this.prisma.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
    const now = Date.now();
    if (!session || session.expiresAt.getTime() < now) {
      if (session) await this.prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
      throw reject();
    }
    if (now - session.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
      const max = session.createdAt.getTime() + ABSOLUTE_MAX_DAYS * 86400000;
      const expiresAt = new Date(Math.min(now + this.env.cookie.ttlDays * 86400000, max));
      await this.prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date(now), expiresAt } }).catch(() => undefined);
    }
    if (session.user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD, targets)) {
      throw new ForbiddenException({ message: "Troque a senha provisória para continuar.", code: "password_change_required" });
    }

    const superAdmin = hasSuperPowers(session.user);
    const memberships = await this.prisma.membership.findMany({
      where: { userId: session.userId, status: "ativo", ...(superAdmin ? {} : { organization: { suspendedAt: null } }) },
      orderBy: { createdAt: "asc" },
    });
    const wanted = req.header("x-organization-id");
    let membership: { organizationId: string; role: string; extraPermissions: string[] } | undefined = wanted ? memberships.find((m) => m.organizationId === wanted) : memberships[0];
    if (!membership && superAdmin) {
      const org = await this.prisma.organization.findFirst({ where: wanted ? { id: wanted } : {}, orderBy: { createdAt: "asc" }, select: { id: true } });
      if (org) membership = { organizationId: org.id, role: "owner", extraPermissions: [] };
    }
    if (wanted && !membership) throw new ForbiddenException("Você não tem acesso a esta empresa.");
    if (!membership && !noOrg) throw new ForbiddenException("Sua conta não está vinculada a nenhuma empresa ativa ou o acesso da empresa está suspenso.");

    req.auth = {
      user: session.user,
      sessionId: session.id,
      organizationId: membership?.organizationId ?? null,
      role: membership?.role ?? null,
      permissions: membership ? permissionsOf(membership.role, membership.extraPermissions) : [],
    };
    return true;
  }
}
