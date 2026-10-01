export const PLAN_LIMITS = {
  starter: { users: 2, products: 500, customers: 1000, storageGb: 2 },
  professional: { users: 10, products: 10_000, customers: 20_000, storageGb: 20 },
  business: { users: null, products: null, customers: null, storageGb: 200 },
} as const;
export type PlanId = keyof typeof PLAN_LIMITS;
