import type { Prisma } from "@prisma/client";
import { num } from "../common/money";

export const SALE_LIST_INCLUDE = { customer: { select: { name: true } }, user: { select: { name: true } } } satisfies Prisma.SaleInclude;
export const SALE_INCLUDE = { ...SALE_LIST_INCLUDE, items: true, payments: true } satisfies Prisma.SaleInclude;

type SaleRow = Prisma.SaleGetPayload<{ include: typeof SALE_LIST_INCLUDE }> & Partial<Prisma.SaleGetPayload<{ include: typeof SALE_INCLUDE }>>;

export const padNumber = (n: number) => String(n).padStart(6, "0");

export function saleDto(s: SaleRow) {
  return {
    id: s.id,
    number: padNumber(s.number),
    customer: s.customer?.name ?? "Consumidor",
    date: s.createdAt.toISOString(),
    total: num(s.total),
    payment: s.payment,
    status: s.status,
    origin: s.origin,
    operator: s.user?.name.split(" ")[0],
    register: s.register ?? undefined,
    cashSessionId: s.cashSessionId ?? undefined,
    cancelReason: s.cancelReason ?? undefined,
    document: s.document || undefined,
    ...(s.items ? {
      subtotal: num(s.subtotal), discount: num(s.discount), shipping: num(s.shipping), installments: s.installments,
      items: s.items.map((i) => ({ id: i.id, productId: i.productId, name: i.name, qty: num(i.qty), unitPrice: num(i.unitPrice), discount: num(i.discount), total: num(i.total), returnedQty: num(i.returnedQty) })),
      payments: (s.payments ?? []).map((p) => ({
        method: p.method, amount: num(p.amount), installments: p.installments, status: p.status,
        brand: p.brand ?? undefined, nsu: p.nsu ?? undefined, authorizationCode: p.authorizationCode ?? undefined, acquirer: p.acquirer ?? undefined,
        ...(p.received != null ? { received: num(p.received), change: num(p.change) } : {}),
      })),
    } : {}),
  };
}
