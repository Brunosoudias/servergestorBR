import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from "class-validator";
import type { Prisma, RefundMethod } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { type AuthContext, orgOf } from "../common/auth-context";
import { cents, fromCents, num } from "../common/money";
import { FinanceService } from "../finance/finance.service";
import { PrismaService } from "../prisma/prisma.service";
import { padNumber } from "../sales/sale.mapper";
import { PosService } from "./pos.service";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);
const REFUND_LABEL: Record<RefundMethod, string> = { dinheiro: "Dinheiro", credito_cliente: "Crédito do cliente", estorno_externo: "Estorno no cartão/PIX" };

class ReturnItemDto {
  @IsString() @MaxLength(40) saleItemId: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }, { message: "Quantidade inválida." }) @Min(0.001, { message: "Quantidade deve ser maior que zero." }) @Max(100_000) qty: number;
  @IsOptional() @IsBoolean() restock?: boolean;
}
export class SaleReturnDto {
  @IsArray() @ArrayMinSize(1, { message: "Selecione ao menos um item para devolver." }) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ReturnItemDto) items: ReturnItemDto[];
  @Transform(trim) @IsString({ message: "Informe o motivo da devolução." }) @MinLength(3, { message: "Informe o motivo da devolução." }) @MaxLength(200) reason: string;
  @IsIn(["dinheiro", "credito_cliente", "estorno_externo"], { message: "Forma de reembolso inválida." }) refundMethod: RefundMethod;
}

const RETURN_INCLUDE = { items: { include: { saleItem: { select: { name: true } } } }, sale: { select: { number: true } } } satisfies Prisma.SaleReturnInclude;
type ReturnRow = Prisma.SaleReturnGetPayload<{ include: typeof RETURN_INCLUDE }>;
const returnDto = (r: ReturnRow) => ({
  id: r.id, number: padNumber(r.number), saleNumber: padNumber(r.sale.number), reason: r.reason, refundMethod: r.refundMethod, refundLabel: REFUND_LABEL[r.refundMethod],
  total: num(r.total), createdAt: r.createdAt.toISOString(),
  items: r.items.map((i) => ({ saleItemId: i.saleItemId, name: i.saleItem.name, qty: i.qty, amount: num(i.amount), restock: i.restock })),
});

@Injectable()
export class ReturnsService {
  constructor(private readonly prisma: PrismaService, private readonly finance: FinanceService, private readonly audit: AuditService, private readonly pos: PosService) {}

  async create(ctx: AuthContext, saleId: string, dto: SaleReturnDto, ip: string) {
    const orgId = orgOf(ctx);
    const sale = await this.prisma.sale.findFirst({ where: { id: saleId, organizationId: orgId }, include: { items: true } });
    if (!sale) throw new NotFoundException();
    if (sale.status !== "concluida") throw new ConflictException("Só é possível devolver itens de vendas concluídas.");
    if (dto.refundMethod === "credito_cliente" && !sale.customerId) throw new BadRequestException("Esta venda não tem cliente: escolha outra forma de reembolso.");
    const session = await this.prisma.cashSession.findFirst({ where: { organizationId: orgId, userId: ctx.user.id, status: "aberto" } });
    if (dto.refundMethod === "dinheiro" && !session) throw new ConflictException("Abra o caixa para devolver o dinheiro.");

    const merged = new Map<string, { qty: number; restock: boolean }>();
    for (const i of dto.items) {
      const cur = merged.get(i.saleItemId);
      merged.set(i.saleItemId, { qty: (cur?.qty ?? 0) + i.qty, restock: i.restock ?? cur?.restock ?? true });
    }
    const subtotal = sale.items.reduce((a, i) => a + cents(num(i.total)), 0);
    const afterDiscount = subtotal - cents(num(sale.discount));
    const lines = [...merged].map(([id, v]) => {
      const item = sale.items.find((i) => i.id === id);
      if (!item) throw new BadRequestException("Item não pertence a esta venda.");
      const avail = Math.round((num(item.qty) - num(item.returnedQty)) * 1000) / 1000;
      if (v.qty > avail + 0.0005) throw new BadRequestException(avail === 0 ? `${item.name} já foi totalmente devolvido.` : `Só restam ${avail} de ${item.name} para devolver.`);
      const amount = subtotal > 0 ? Math.round(((cents(num(item.total)) * v.qty) / num(item.qty)) * (afterDiscount / subtotal)) : 0;
      return { item, qty: v.qty, restock: v.restock, amount };
    });
    const total = lines.reduce((a, l) => a + l.amount, 0);

    const created = await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM "Sale" WHERE id = ${sale.id} FOR UPDATE`;
      if (locked?.status !== "concluida") throw new ConflictException("Só é possível devolver itens de vendas concluídas.");
      for (const l of lines) {
        const r = await tx.saleItem.updateMany({ where: { id: l.item.id, returnedQty: { lte: num(l.item.qty) - l.qty } }, data: { returnedQty: { increment: l.qty } } });
        if (r.count === 0) throw new ConflictException("Os itens já foram devolvidos em outra operação. Atualize a tela.");
      }
      const counter = await tx.counter.upsert({ where: { organizationId_key: { organizationId: orgId, key: "sale-return" } }, create: { organizationId: orgId, key: "sale-return", value: 1 }, update: { value: { increment: 1 } } });
      const ret = await tx.saleReturn.create({
        data: {
          organizationId: orgId, saleId: sale.id, number: counter.value, userId: ctx.user.id, cashSessionId: session?.id ?? null, reason: dto.reason, refundMethod: dto.refundMethod, total: fromCents(total),
          items: { create: lines.map((l) => ({ saleItemId: l.item.id, qty: l.qty, amount: fromCents(l.amount), restock: l.restock })) },
        },
        include: RETURN_INCLUDE,
      });
      const label = `Devolução #${padNumber(ret.number)} da venda #${padNumber(sale.number)}`;
      for (const l of lines.filter((x) => x.restock)) {
        await tx.product.update({ where: { id: l.item.productId }, data: { stock: { increment: l.qty } } });
        await tx.stockMovement.create({ data: { organizationId: orgId, productId: l.item.productId, userId: ctx.user.id, type: "entrada", quantity: l.qty, reason: label } });
      }
      if (total > 0) {
        if (dto.refundMethod === "dinheiro") {
          await tx.$queryRaw`SELECT id FROM "CashSession" WHERE id = ${session!.id} FOR UPDATE`;
          await tx.cashMovement.create({ data: { organizationId: orgId, sessionId: session!.id, userId: ctx.user.id, type: "estorno", method: "dinheiro", amount: fromCents(total), reason: label, notes: dto.reason, saleId: sale.id } });
          const t = await this.pos.totals(session!, tx);
          if (t.expected < 0) throw new ConflictException(`Não há dinheiro suficiente no caixa para devolver R$ ${fromCents(total).toFixed(2).replace(".", ",")}. Faça um suprimento antes.`);
          const cashAcc = await this.finance.cashAccount(tx, orgId);
          await this.finance.transfer(tx, orgId, { fromAccountId: cashAcc.id, amount: fromCents(total), description: label, category: "Devoluções", saleId: sale.id });
        } else if (dto.refundMethod === "credito_cliente") {
          await tx.customer.update({ where: { id: sale.customerId! }, data: { creditBalance: { increment: fromCents(total) } } });
          await tx.customerCreditMovement.create({ data: { organizationId: orgId, customerId: sale.customerId!, type: "entrada", amount: fromCents(total), description: label, saleId: sale.id, returnId: ret.id, userId: ctx.user.id } });
        } else {
          await this.finance.recordMovement(tx, orgId, { type: "saida", description: label, category: "Devoluções", amount: fromCents(total) });
        }
      }
      return ret;
    });
    await this.audit.log({ organizationId: orgId, userId: ctx.user.id, action: "sale.return", entity: "sale", entityId: sale.id, text: `${ctx.user.name} registrou a devolução #${padNumber(created.number)} da venda #${padNumber(sale.number)} (R$ ${fromCents(total).toFixed(2).replace(".", ",")}, ${REFUND_LABEL[dto.refundMethod]}): ${dto.reason}`, ip });
    return returnDto(created);
  }

  async list(ctx: AuthContext, saleId: string) {
    const rows = await this.prisma.saleReturn.findMany({ where: { saleId, organizationId: orgOf(ctx) }, include: RETURN_INCLUDE, orderBy: { createdAt: "asc" } });
    return rows.map(returnDto);
  }

  async customerCredit(ctx: AuthContext, customerId: string) {
    const orgId = orgOf(ctx);
    const c = await this.prisma.customer.findFirst({ where: { id: customerId, organizationId: orgId }, select: { creditBalance: true } });
    if (!c) throw new NotFoundException();
    const history = await this.prisma.customerCreditMovement.findMany({ where: { customerId, organizationId: orgId }, orderBy: { createdAt: "desc" }, take: 20 });
    return { balance: num(c.creditBalance), history: history.map((h) => ({ id: h.id, type: h.type, amount: num(h.amount), description: h.description, createdAt: h.createdAt.toISOString() })) };
  }
}
