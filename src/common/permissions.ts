export type RoleName = "owner" | "admin" | "financeiro" | "vendedor" | "caixa" | "estoque" | "visualizador";

const ACTIONS = ["view", "create", "edit", "delete"];
const all = (m: string, acts: string[] = ACTIONS) => acts.map((a) => `${m}:${a}`);
const view = (...m: string[]) => m.map((x) => `${x}:view`);

export const POS_PERMISSIONS = [
  "pos:view", "pos:sell", "pos:discount", "pos:cancel", "pos:open_register", "pos:close_register", "pos:withdrawal", "pos:deposit", "pos:history",
];

const EVERYTHING = [
  ...["dashboard", "finance", "sales", "customers", "products", "inventory", "wallet", "automations", "reports", "settings", "fiscal", "marketplaces"].flatMap((m) => all(m)),
  ...POS_PERMISSIONS,
];

export const ROLE_PERMISSIONS: Record<RoleName, string[]> = {
  owner: EVERYTHING,
  admin: EVERYTHING,
  financeiro: [...view("dashboard", "sales", "customers", "wallet", "reports"), ...all("finance"), ...all("fiscal"), "settings:view"],
  vendedor: [
    ...view("dashboard", "products", "inventory", "fiscal"), ...all("marketplaces", ["view", "edit"]),
    ...all("sales", ["view", "create", "edit"]), ...all("customers", ["view", "create", "edit"]), "pos:view", "pos:sell", "pos:history",
  ],
  caixa: [...view("dashboard", "products", "customers"), ...POS_PERMISSIONS.filter((p) => p !== "pos:discount")],
  estoque: [...view("dashboard", "marketplaces"), ...all("products"), ...all("inventory")],
  visualizador: view("dashboard", "finance", "sales", "customers", "products", "inventory", "wallet", "reports", "automations", "fiscal", "marketplaces"),
};

export const ROLES = Object.keys(ROLE_PERMISSIONS) as RoleName[];
