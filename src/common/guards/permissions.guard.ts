import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AuthedRequest } from "../auth-context";
import { PERMISSIONS } from "../decorators";

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext) {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS, [ctx.getHandler(), ctx.getClass()]);
    if (!required?.length) return true;
    const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
    if (!auth || !required.every((p) => auth.permissions.includes(p))) throw new ForbiddenException();
    return true;
  }
}
