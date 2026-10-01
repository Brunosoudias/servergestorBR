import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { AuthContext, AuthedRequest } from "../auth-context";

export const IS_PUBLIC = "isPublic";
export const NO_ORG = "noOrg";
export const PERMISSIONS = "permissions";
export const ALLOW_EXPIRED = "allowExpired";
export const ALLOW_PENDING_PASSWORD = "allowPendingPassword";

export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Rota liberada enquanto o usuário ainda precisa trocar a senha definida pelo superadmin. */
export const AllowPendingPassword = () => SetMetadata(ALLOW_PENDING_PASSWORD, true);
export const AllowExpired = () => SetMetadata(ALLOW_EXPIRED, true);
export const NoOrg = () => SetMetadata(NO_ORG, true);
export const RequirePermission = (...perms: string[]) => SetMetadata(PERMISSIONS, perms);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => ctx.switchToHttp().getRequest<AuthedRequest>().auth);
export const ClientIp = createParamDecorator((_: unknown, ctx: ExecutionContext): string => ctx.switchToHttp().getRequest<AuthedRequest>().ip ?? "");
