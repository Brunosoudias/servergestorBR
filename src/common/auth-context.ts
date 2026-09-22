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

export function orgOf(ctx: AuthContext): string {
  if (!ctx.organizationId) throw new Error("Rota exige empresa ativa.");
  return ctx.organizationId;
}
