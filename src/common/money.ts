import { Prisma } from "@prisma/client";

export const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));
export const cents = (v: number) => Math.round(v * 100);
export const fromCents = (c: number) => c / 100;
