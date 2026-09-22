import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, Module, NotFoundException, Post, Query } from "@nestjs/common";
import { Transform, Type } from "class-transformer";
import { IsIn, IsInt, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
import { Prisma } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { AutomationsService } from "../automations/automations.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { Auth, ClientIp, RequirePermission } from "../common/decorators";
import { num } from "../common/money";
import { ListQuery, page, skipTake } from "../common/pagination";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class MovementDto {
  @IsString({ message: "Selecione o produto." }) @MinLength(1, { message: "Selecione o produto." }) productId: string;
  @IsIn(["entrada", "saida", "ajuste"], { message: "Tipo de movimentação inválido." }) type: "entrada" | "saida" | "ajuste";
  @Type(() => Number) @IsInt({ message: "A quantidade deve ser um número inteiro." }) @Min(0) @Max(1_000_000_000) quantity: number;
  @Transform(trim) @IsString() @MinLength(2, { message: "Informe o motivo." }) @MaxLength(200) reason: string;
}

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly notifications: NotificationsService, private readonly automations: AutomationsService) {}

  async summary(ctx: AuthContext) {
    const orgId = orgOf(ctx);
    const [row] = await this.prisma.$queryRaw<{ units: bigint | null; value: Prisma.Decimal | null; products: bigint; below: bigint }[]>(Prisma.sql`
      SELECT COALESCE(SUM("stock"), 0) AS units, COALESCE(SUM("stock" * "cost"), 0) AS value, COUNT(*) AS products,
             COUNT(*) FILTER (WHERE "stock" < "minStock") AS below
      FROM "Product" WHERE "organizationId" = ${orgId} AND "deletedAt" IS NULL`);
    return { totalUnits: Number(row.units ?? 0), totalValue: num(row.value), products: Number(row.products), belowMin: Number(row.below) };
  }

  async movements(ctx: AuthContext, q: ListQuery) {
    const orgId = orgOf(ctx);
    const where: Prisma.StockMovementWhereInput = {
      organizationId: orgId, ...(q.status === "entrada" || q.status === "saida" || q.status === "ajuste" ? { type: q.status } : {}),
      ...(q.search ? { OR: [{ reason: { contains: q.search, mode: "insensitive" } }, { product: { name: { contains: q.search, mode: "insensitive" } } }, { user: { name: { contains: q.search, mode: "insensitive" } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.stockMovement.findMany({ where, include: { product: { select: { name: true } }, user: { select: { name: true } } }, orderBy: { createdAt: "desc" }, ...skipTake(q) }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return page(rows.map((m) => ({ id: m.id, date: m.createdAt.toISOString(), product: m.product.name, type: m.type, quantity: m.quantity, reason: m.reason, user: m.user?.name.split(" ")[0] ?? "—" })), total, q);
  }

  async register(ctx: AuthContext, dto: MovementDto, ip: string) {
    const orgId = orgOf(ctx);
    if (dto.type !== "ajuste" && dto.quantity < 1) throw new BadRequestException("A quantidade deve ser de pelo menos 1.");
    const result = await this.prisma.$transaction(async (tx) => {
      const p = await tx.product.findFirst({ where: { id: dto.productId, organizationId: orgId, deletedAt: null } });
      if (!p) throw new NotFoundException("Produto não encontrado.");
      if (dto.type === "saida") {
        const r = await tx.product.updateMany({ where: { id: p.id, organizationId: orgId, stock: { gte: dto.quantity } }, data: { stock: { decrement: dto.quantity } } });
        if (r.count === 0) throw new ConflictException(`Estoque insuficiente para ${p.name} (saldo: ${p.stock}).`);
      } else if (dto.type === "entrada") {
        await tx.product.update({ where: { id: p.id }, data: { stock: { increment: dto.quantity } } });
      } else {
        await tx.product.update({ where: { id: p.id }, data: { stock: dto.quantity } });
      }
      const m = await tx.stockMovement.create({ data: { organizationId: orgId, productId: p.id, userId: ctx.user.id, type: dto.type, quantity: dto.quantity, reason: dto.reason }, include: { product: { select: { name: true } }, user: { select: { name: true } } } });
      const after = await tx.product.findUniqueOrThrow({ where: { id: p.id }, select: { stock: true, minStock: true, name: true } });
      return { m, after };
    });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "inventory.move", entity: "product", entityId: dto.productId, text: `${ctx.user.name} registrou ${dto.type} de ${dto.quantity} un. em ${result.m.product.name}`, ip });
    await this.lowStockAlert(orgId, result.after);
    const m = result.m;
    return { id: m.id, date: m.createdAt.toISOString(), product: m.product.name, type: m.type, quantity: m.quantity, reason: m.reason, user: m.user?.name.split(" ")[0] ?? "—" };
  }

  async lowStockAlert(orgId: string, p: { name: string; stock: number; minStock: number }) {
    if (p.stock >= p.minStock) return;
    await this.notifications.notify(orgId, "Estoque", `Estoque baixo: ${p.name}`, `Restam ${p.stock} unidades (mínimo ${p.minStock}).`);
    await this.automations.fire(orgId, "Estoque baixo", { title: `Estoque baixo: ${p.name} (${p.stock} un., mínimo ${p.minStock})`, stock: p.stock, minStock: p.minStock });
  }
}

@Controller("inventory")
export class InventoryController {
  constructor(private readonly inv: InventoryService) {}
  @RequirePermission("inventory:view") @Get("summary") summary(@Auth() ctx: AuthContext) { return this.inv.summary(ctx); }
  @RequirePermission("inventory:view") @Get("movements") movements(@Auth() ctx: AuthContext, @Query() q: ListQuery) { return this.inv.movements(ctx, q); }
  @RequirePermission("inventory:create") @Post("movements") register(@Auth() ctx: AuthContext, @Body() dto: MovementDto, @ClientIp() ip: string) { return this.inv.register(ctx, dto, ip); }
}

@Module({ controllers: [InventoryController], providers: [InventoryService], exports: [InventoryService] })
export class InventoryModule {}
