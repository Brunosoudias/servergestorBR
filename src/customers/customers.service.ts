import { Injectable, NotFoundException } from "@nestjs/common";
import { Transform, Type } from "class-transformer";
import { IsEmail, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from "class-validator";
import type { Customer, Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { num } from "../common/money";
import { type ListQuery, page, skipTake } from "../common/pagination";
import { AutomationsService } from "../automations/automations.service";
import { PrismaService } from "../prisma/prisma.service";
import { saleDto, SALE_INCLUDE } from "../sales/sale.mapper";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class CustomerDto {
  @Transform(trim) @IsString() @MinLength(2, { message: "Informe o nome do cliente." }) @MaxLength(160) name: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(30) document?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(30) phone?: string;
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value)) @ValidateIf((_o, v) => typeof v === "string" && v.length > 0) @IsEmail({}, { message: "Informe um e-mail válido." }) @MaxLength(160) email?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99_999_999.99) creditLimit?: number;
}

type Stats = { totalSpent: number; purchases: number; lastPurchase: string; open: number };

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly automations: AutomationsService) {}

  private dto(c: Customer, s?: Stats) {
    return { id: c.id, name: c.name, document: c.document, phone: c.phone, email: c.email, status: c.status, creditLimit: num(c.creditLimit), creditBalance: num(c.creditBalance), totalSpent: s?.totalSpent ?? 0, purchases: s?.purchases ?? 0, lastPurchase: s?.lastPurchase ?? "", open: s?.open ?? 0 };
  }

  private async stats(orgId: string, ids: string[]): Promise<Map<string, Stats>> {
    const map = new Map<string, Stats>();
    if (!ids.length) return map;
    const rows = await this.prisma.sale.groupBy({ by: ["customerId", "status"], where: { organizationId: orgId, customerId: { in: ids }, status: { in: ["concluida", "pendente"] } }, _sum: { total: true }, _count: true, _max: { createdAt: true } });
    for (const r of rows) {
      const s = map.get(r.customerId!) ?? { totalSpent: 0, purchases: 0, lastPurchase: "", open: 0 };
      if (r.status === "concluida") { s.totalSpent += num(r._sum.total); s.purchases += r._count; }
      else s.open += num(r._sum.total);
      const last = r._max.createdAt?.toISOString() ?? "";
      if (last > s.lastPurchase) s.lastPurchase = last;
      map.set(r.customerId!, s);
    }
    return map;
  }

  private where(orgId: string, search?: string): Prisma.CustomerWhereInput {
    return { organizationId: orgId, deletedAt: null, ...(search ? { OR: [
      { name: { contains: search, mode: "insensitive" } }, { document: { contains: search } }, { phone: { contains: search } }, { email: { contains: search, mode: "insensitive" } },
    ] } : {}) };
  }

  async list(ctx: AuthContext, q: ListQuery) {
    const orgId = orgOf(ctx);
    const where = { ...this.where(orgId, q.search), ...(q.status && q.status !== "all" ? { status: q.status as never } : {}) };
    const [rows, total] = await Promise.all([this.prisma.customer.findMany({ where, orderBy: { createdAt: "desc" }, ...skipTake(q) }), this.prisma.customer.count({ where })]);
    const st = await this.stats(orgId, rows.map((r) => r.id));
    return page(rows.map((c) => this.dto(c, st.get(c.id))), total, q);
  }

  async search(ctx: AuthContext, q?: string) {
    const rows = await this.prisma.customer.findMany({ where: this.where(orgOf(ctx), q?.trim().slice(0, 100)), orderBy: { name: "asc" }, take: 50 });
    return rows.map((c) => this.dto(c));
  }

  private async findOr404(orgId: string, id: string) {
    const c = await this.prisma.customer.findFirst({ where: { id, organizationId: orgId, deletedAt: null } });
    if (!c) throw new NotFoundException();
    return c;
  }

  async get(ctx: AuthContext, id: string) {
    const orgId = orgOf(ctx);
    const c = await this.findOr404(orgId, id);
    return this.dto(c, (await this.stats(orgId, [id])).get(id));
  }

  async purchases(ctx: AuthContext, id: string) {
    const orgId = orgOf(ctx);
    await this.findOr404(orgId, id);
    const rows = await this.prisma.sale.findMany({ where: { organizationId: orgId, customerId: id }, include: SALE_INCLUDE, orderBy: { createdAt: "desc" }, take: 100 });
    return rows.map((s) => saleDto(s));
  }

  async create(ctx: AuthContext, input: CustomerDto, ip: string) {
    const orgId = orgOf(ctx);
    const c = await this.prisma.customer.create({ data: { organizationId: orgId, name: input.name, document: input.document ?? "", phone: input.phone ?? "", email: input.email ?? "", notes: input.notes ?? "", creditLimit: input.creditLimit ?? 0 } });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "customer.create", entity: "customer", entityId: c.id, text: `${ctx.user.name} cadastrou o cliente ${c.name}`, ip });
    await this.automations.fire(orgId, "Novo cliente", { title: `Novo cliente: ${c.name}` });
    return this.dto(c);
  }
}
