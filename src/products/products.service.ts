import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Transform, Type } from "class-transformer";
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength } from "class-validator";
import type { Prisma, Product } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { num } from "../common/money";
import { type ListQuery, page, skipTake } from "../common/pagination";
import { AutomationsService } from "../automations/automations.service";
import { PrismaService } from "../prisma/prisma.service";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const MONEY_MAX = 99_999_999.99;

const QTY = () => Type(() => Number);
class ProductQtyFields {
  @IsOptional() @QTY() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) @Max(1_000_000_000) stock?: number;
  @IsOptional() @QTY() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) @Max(1_000_000_000) minStock?: number;
  @IsOptional() @IsIn(["UN", "KG", "L", "M", "CX"]) unit?: string;
  @IsOptional() @IsBoolean() fractional?: boolean;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(8) ncm?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(8) cest?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(4) cfop?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(8) origin?: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(4) cst?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(6) taxableUnit?: string;
}

export class ProductDto extends ProductQtyFields {
  @Transform(trim) @IsString() @MinLength(2, { message: "Informe o nome do produto." }) @MaxLength(160) name: string;
  @Transform(trim) @IsString() @MinLength(1, { message: "Informe o SKU." }) @MaxLength(60) sku: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(60) barcode?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) category?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) supplier?: string;
  @IsOptional() @IsUrl({ require_protocol: true, require_tld: false, protocols: ["http", "https"] }, { message: "A imagem enviada não é válida. Envie o arquivo novamente." }) @MaxLength(500, { message: "A imagem enviada não é válida. Envie o arquivo novamente." }) image?: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) price: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) cost?: number;
  @IsOptional() @IsIn(["ativo", "inativo"]) status?: "ativo" | "inativo";
}

export class UpdateProductDto extends ProductQtyFields {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(160) name?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) sku?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(60) barcode?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) category?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) supplier?: string;
  @IsOptional() @IsUrl({ require_protocol: true, require_tld: false, protocols: ["http", "https"] }, { message: "A imagem enviada não é válida. Envie o arquivo novamente." }) @MaxLength(500, { message: "A imagem enviada não é válida. Envie o arquivo novamente." }) image?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) price?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MONEY_MAX) cost?: number;
  @IsOptional() @IsIn(["ativo", "inativo"]) status?: "ativo" | "inativo";
}

export const productDto = (p: Product) => ({
  id: p.id, name: p.name, sku: p.sku, barcode: p.barcode, category: p.category, price: num(p.price), cost: num(p.cost),
  stock: num(p.stock), minStock: num(p.minStock), unit: p.unit, fractional: p.fractional,
  ncm: p.ncm, cest: p.cest, cfop: p.cfop, origin: p.origin, cst: p.cst, taxableUnit: p.taxableUnit,
  status: p.status, supplier: p.supplier, image: p.image ?? undefined,
});

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly automations: AutomationsService) {}

  private searchWhere(orgId: string, search?: string): Prisma.ProductWhereInput {
    return {
      organizationId: orgId, deletedAt: null,
      ...(search ? { OR: [
        { name: { contains: search, mode: "insensitive" } }, { sku: { contains: search, mode: "insensitive" } },
        { barcode: { contains: search } }, { category: { contains: search, mode: "insensitive" } },
      ] } : {}),
    };
  }

  async list(ctx: AuthContext, q: ListQuery) {
    const where: Prisma.ProductWhereInput = { ...this.searchWhere(orgOf(ctx), q.search), ...(q.status && q.status !== "all" ? { status: q.status as never } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({ where, orderBy: { createdAt: "desc" }, ...skipTake(q) }),
      this.prisma.product.count({ where }),
    ]);
    return page(rows.map(productDto), total, q);
  }

  async search(ctx: AuthContext, q?: string) {
    const rows = await this.prisma.product.findMany({ where: { ...this.searchWhere(orgOf(ctx), q?.trim().slice(0, 100)), status: "ativo" }, orderBy: { name: "asc" }, take: 50 });
    return rows.map(productDto);
  }

  async get(ctx: AuthContext, id: string) {
    const p = await this.prisma.product.findFirst({ where: { id, organizationId: orgOf(ctx), deletedAt: null } });
    if (!p) throw new NotFoundException();
    return productDto(p);
  }

  async create(ctx: AuthContext, input: ProductDto, ip: string) {
    const orgId = orgOf(ctx);
    if (await this.prisma.product.findUnique({ where: { organizationId_sku: { organizationId: orgId, sku: input.sku } } })) throw new ConflictException("Já existe um produto com este SKU.");
    const p = await this.prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          organizationId: orgId, name: input.name, sku: input.sku, barcode: input.barcode ?? "", category: input.category ?? "", supplier: input.supplier ?? "", image: input.image,
          price: input.price, cost: input.cost ?? 0, stock: input.stock ?? 0, minStock: input.minStock ?? 0, status: input.status ?? "ativo",
          unit: input.unit ?? "UN", fractional: input.fractional ?? (input.unit === "KG" || input.unit === "L" || input.unit === "M"),
          ncm: input.ncm ?? "", cest: input.cest ?? "", cfop: input.cfop ?? "", origin: input.origin ?? 0, cst: input.cst ?? "", taxableUnit: input.taxableUnit ?? "",
        },
      });
      if (num(created.stock) > 0) await tx.stockMovement.create({ data: { organizationId: orgId, productId: created.id, userId: ctx.user.id, type: "entrada", quantity: created.stock, reason: "Estoque inicial" } });
      return created;
    });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "product.create", entity: "product", entityId: p.id, text: `${ctx.user.name} cadastrou o produto ${p.name}`, ip });
    await this.automations.fire(orgId, "Novo produto", { title: `Novo produto: ${p.name}` });
    return productDto(p);
  }

  async update(ctx: AuthContext, id: string, input: UpdateProductDto, ip: string) {
    const orgId = orgOf(ctx);
    const cur = await this.prisma.product.findFirst({ where: { id, organizationId: orgId, deletedAt: null } });
    if (!cur) throw new NotFoundException();
    if (input.sku && input.sku !== cur.sku && (await this.prisma.product.findUnique({ where: { organizationId_sku: { organizationId: orgId, sku: input.sku } } }))) throw new ConflictException("Já existe um produto com este SKU.");
    const p = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({ where: { id }, data: input });
      if (input.stock !== undefined && num(input.stock) !== num(cur.stock)) await tx.stockMovement.create({ data: { organizationId: orgId, productId: id, userId: ctx.user.id, type: "ajuste", quantity: input.stock, reason: `Ajuste pelo cadastro (de ${num(cur.stock)} para ${input.stock})` } });
      return updated;
    });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "product.update", entity: "product", entityId: id, text: `${ctx.user.name} atualizou o produto ${p.name}`, ip });
    return productDto(p);
  }

  async remove(ctx: AuthContext, id: string, ip: string) {
    const orgId = orgOf(ctx);
    const cur = await this.prisma.product.findFirst({ where: { id, organizationId: orgId, deletedAt: null } });
    if (!cur) throw new NotFoundException();
    await this.prisma.product.update({ where: { id }, data: { deletedAt: new Date(), status: "inativo", sku: `${cur.sku}__excluido_${id.slice(-6)}` } });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "product.delete", entity: "product", entityId: id, text: `${ctx.user.name} excluiu o produto ${cur.name}`, ip });
  }
}
