export type RoleName = "owner" | "admin" | "financeiro" | "fiscal" | "vendedor" | "caixa" | "supervisor" | "estoque" | "visualizador";

const ACTIONS = ["view", "create", "edit", "delete"];
const all = (m: string, acts: string[] = ACTIONS) => acts.map((a) => `${m}:${a}`);
const view = (...m: string[]) => m.map((x) => `${x}:view`);

export const POS_PERMISSIONS = [
  "pos:view", "pos:sell", "pos:discount", "pos:cancel", "pos:open_register", "pos:close_register", "pos:withdrawal", "pos:deposit", "pos:history",
  "pos:manage", "pos:cancel_closed", "pos:return", "pos:price", "pos:settings", "customers:credit",
];
const POS_SUPERVISOR = ["pos:discount", "pos:manage", "pos:cancel_closed", "pos:return", "pos:price", "pos:settings", "customers:credit"];

const EVERYTHING = [
  ...["dashboard", "finance", "sales", "customers", "products", "inventory", "wallet", "automations", "reports", "settings", "fiscal", "marketplaces"].flatMap((m) => all(m)),
  ...POS_PERMISSIONS,
];

export const ROLE_PERMISSIONS: Record<RoleName, string[]> = {
  owner: EVERYTHING,
  admin: EVERYTHING,
  financeiro: [...view("dashboard", "reports"), ...all("finance"), ...all("wallet")],
  fiscal: [...view("dashboard", "sales", "customers"), ...all("fiscal")],
  vendedor: [
    ...view("dashboard", "products", "inventory"), ...all("marketplaces", ["view", "edit"]),
    ...all("sales", ["view", "create", "edit"]), ...all("customers", ["view", "create", "edit"]), "pos:view", "pos:sell", "pos:history",
  ],
  caixa: [...view("dashboard", "products", "customers"), ...POS_PERMISSIONS.filter((p) => !POS_SUPERVISOR.includes(p))],
  supervisor: [
    ...view("dashboard", "products", "sales", "customers"),
    "pos:view", "pos:sell", "pos:history", "pos:open_register", "pos:close_register", "pos:withdrawal", "pos:deposit",
    "pos:discount", "pos:cancel", "pos:cancel_closed", "pos:price", "pos:manage", "pos:return", "customers:credit",
  ],
  estoque: [...view("dashboard"), ...all("products"), ...all("inventory")],
  visualizador: view("dashboard", "finance", "sales", "customers", "products", "inventory", "wallet", "reports", "automations", "fiscal", "marketplaces"),
};

export const ROLES = Object.keys(ROLE_PERMISSIONS) as RoleName[];

const KNOWN = new Set(EVERYTHING);

/** Permissões da função mais as concessões extras, sem duplicar e sem aceitar chave desconhecida. */
export function permissionsOf(role: string | null | undefined, extra: string[] = []) {
  const base = role ? ROLE_PERMISSIONS[role as RoleName] ?? [] : [];
  const added = extra.filter((p) => KNOWN.has(p) && !base.includes(p));
  return [...base, ...added];
}

export function onlyExtra(role: string, extra: string[]) {
  const base = new Set(ROLE_PERMISSIONS[role as RoleName] ?? []);
  return [...new Set(extra.filter((p) => KNOWN.has(p) && !base.has(p)))];
}

export function unknownPermissions(extra: string[]) {
  return extra.filter((p) => !KNOWN.has(p));
}
