import type { Request } from "express";
import type { User } from "@prisma/client";

export interface AuthContext {
  user: User;
  sessionId: string;
  organizationId: string | null;
  role: string | null;
  permissions: string[];
}

export type AuthedRequest = Request & { auth: AuthContext };

/** Os poderes de superadmin (todas as empresas) só valem com a verificação em duas etapas ativa. */
export const hasSuperPowers = (u: Pick<User, "isSuperAdmin" | "mfaEnabledAt">) => u.isSuperAdmin && !!u.mfaEnabledAt;

export function orgOf(ctx: AuthContext): string {
  if (!ctx.organizationId) throw new Error("Rota exige empresa ativa.");
  return ctx.organizationId;
}
