export type EffectiveStatus = "trial" | "active" | "cancelled" | "expired";

interface OrgBilling { subscriptionStatus: "trial" | "active" | "cancelled"; trialEndsAt: Date | null }

/** Teste vencido vira "expired" na leitura; não depende de job para virar. */
export function effectiveStatus(org: OrgBilling, now = Date.now()): EffectiveStatus {
  if (org.subscriptionStatus === "trial" && org.trialEndsAt && org.trialEndsAt.getTime() <= now) return "expired";
  return org.subscriptionStatus;
}

export function trialDaysLeft(org: OrgBilling, now = Date.now()): number | null {
  if (org.subscriptionStatus !== "trial" || !org.trialEndsAt) return null;
  return Math.max(0, Math.ceil((org.trialEndsAt.getTime() - now) / 86_400_000));
}
