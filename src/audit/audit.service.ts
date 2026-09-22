import { Global, Injectable, Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface AuditEntry { organizationId?: string | null; userId?: string | null; action: string; text: string; entity?: string; entityId?: string; ip?: string; }

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(e: AuditEntry) {
    try {
      await this.prisma.auditLog.create({ data: { organizationId: e.organizationId ?? null, userId: e.userId ?? null, action: e.action, text: e.text, entity: e.entity ?? "", entityId: e.entityId ?? "", ip: e.ip ?? "" } });
    } catch { /* auditoria nunca derruba a operação principal */ }
  }

  recent(organizationId: string, take = 50) {
    return this.prisma.auditLog.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
