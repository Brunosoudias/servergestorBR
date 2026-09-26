/**
 * Dados de demonstração para DESENVOLVIMENTO. Recusa rodar em produção. Pode ser executado várias vezes:
 * cada bloco só grava se a empresa ainda não tiver aquele tipo de dado.
 * Login (senha de todos: senha1234):
 * bruno@empresaabc.com.br superadmin, admin@, maria@ financeiro, fiscal@, joao@ PDV, supervisor@, ana@ estoque, carlos@ vendedor, lia@ consulta.
 *
 * É aqui que vivem os dados que antes eram "mock" no frontend (tudo agora está no banco).
 */
import { PrismaClient, type Marketplace } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { buildAccessKey } from "../src/common/fiscal-key";
import { buildPixPayload } from "../src/common/pix";

const prisma = new PrismaClient();

const PRODUCTS: [string, string, string, number, number, number, number, string][] = [
  ["Notebook Dell Inspiron", "SKU-1001", "Informática", 4500, 3400, 14, 5, "Dell Brasil"],
  ["Mouse Logitech MX", "SKU-1002", "Periféricos", 120, 65, 48, 15, "Logitech"],
  ["Teclado Mecânico RGB", "SKU-1003", "Periféricos", 350, 190, 22, 10, "Fornecedor XPTO"],
  ["Smartphone Samsung A55", "SKU-1004", "Celulares", 1850, 1400, 9, 10, "Samsung"],
  ["Monitor LG 27 4K", "SKU-1005", "Monitores", 2200, 1600, 6, 8, "LG Electronics"],
  ["Headset HyperX Cloud", "SKU-1006", "Áudio", 480, 280, 31, 10, "Kingston"],
  ["Webcam Full HD", "SKU-1007", "Periféricos", 210, 110, 3, 10, "Logitech"],
  ["SSD NVMe 1TB", "SKU-1008", "Armazenamento", 620, 410, 40, 12, "Fornecedor XPTO"],
  ["Cabo HDMI 2m", "SKU-1009", "Acessórios", 35, 12, 120, 40, "Fornecedor XPTO"],
  ["Carregador USB-C 65W", "SKU-1010", "Acessórios", 149, 70, 55, 20, "Anker"],
  ["Impressora Térmica", "SKU-1011", "Impressoras", 890, 610, 7, 5, "Elgin"],
  ["Leitor Código de Barras", "SKU-1012", "Automação", 260, 150, 18, 6, "Elgin"],
];
const NAMES = ["João Silva", "Maria Oliveira", "Empresa ABC LTDA", "Carlos Souza", "Ana Costa", "Tech Solutions ME", "Fernanda Lima", "Ricardo Alves", "Padaria Bom Dia", "Juliana Rocha", "Marcos Pereira", "Studio Criativo"];
const METHODS = ["pix", "credito", "dinheiro", "debito", "boleto"] as const;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const d = (iso: string) => new Date(iso);
const date = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));
const digits = (seed: number, n: number) => Array.from({ length: n }, (_, i) => (seed * (i + 7) * 31 + i * 13) % 10).join("");
const r2 = (v: number) => Math.round(v * 100) / 100;

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("O seed de demonstração não roda em produção.");
  const email = "bruno@empresaabc.com.br";
  const passwordHash = await bcrypt.hash("senha1234", 12);

  // ---------- empresa, dono, cadastros básicos
  let owner = await prisma.user.findUnique({ where: { email }, include: { memberships: true } });
  let orgId: string;
  if (owner) orgId = owner.memberships[0].organizationId;
  else {
    const org = await prisma.organization.create({ data: { name: "Empresa ABC LTDA", cnpj: "12.345.678/0001-90", email: "contato@empresaabc.com.br", phone: "(11) 3000-1000", address: "Av. Paulista, 1000", city: "São Paulo", state: "SP", segment: "Varejo", plan: "professional", onboarded: true } });
    orgId = org.id;
    owner = await prisma.user.create({ data: { name: "Bruno Dias", email, passwordHash, lastAccessAt: d("2026-09-18T10:12:00Z") }, include: { memberships: true } });
    await prisma.membership.create({ data: { userId: owner.id, organizationId: orgId, role: "owner", status: "ativo" } });
  }
  const ownerId = owner.id;
  await prisma.organization.update({ where: { id: orgId }, data: { plan: "professional", subscriptionStatus: "active", renewsAt: new Date(Date.now() + 5 * 86_400_000), onboarded: true } });

  const users: Record<string, string> = { Bruno: ownerId };
  for (const [name, mail, role, last] of [
    ["Admin Silva", "admin@empresaabc.com.br", "admin", "2026-09-18T09:00:00Z"],
    ["Maria Oliveira", "maria@empresaabc.com.br", "financeiro", "2026-09-18T09:40:00Z"],
    ["Paula Nunes", "fiscal@empresaabc.com.br", "fiscal", "2026-09-18T09:20:00Z"],
    ["João Silva", "joao@empresaabc.com.br", "caixa", "2026-09-17T18:02:00Z"],
    ["Paulo Mendes", "supervisor@empresaabc.com.br", "supervisor", "2026-09-18T11:00:00Z"],
    ["Ana Costa", "ana@empresaabc.com.br", "estoque", "2026-09-10T10:00:00Z"],
    ["Carlos Souza", "carlos@empresaabc.com.br", "vendedor", "2026-08-01T10:00:00Z"],
    ["Lia Consulta", "lia@empresaabc.com.br", "visualizador", "2026-09-15T10:00:00Z"],
  ] as const) {
    const existing = await prisma.user.findUnique({ where: { email: mail } });
    const u = existing
      ? await prisma.user.update({ where: { id: existing.id }, data: { name, passwordHash } })
      : await prisma.user.create({ data: { name, email: mail, passwordHash, lastAccessAt: d(last) } });
    await prisma.membership.upsert({ where: { userId_organizationId: { userId: u.id, organizationId: orgId } }, create: { userId: u.id, organizationId: orgId, role, status: "ativo" }, update: { role, status: "ativo" } });
    users[name.split(" ")[0]] = u.id;
  }

  const products = [];
  for (const [name, sku, category, price, cost, stock, minStock, supplier] of PRODUCTS) {
    let p = await prisma.product.findUnique({ where: { organizationId_sku: { organizationId: orgId, sku } } });
    if (!p) {
      p = await prisma.product.create({ data: { organizationId: orgId, name, sku, category, price, cost, stock, minStock, supplier, barcode: `789000${sku.slice(-4)}00` } });
      await prisma.stockMovement.create({ data: { organizationId: orgId, productId: p.id, userId: ownerId, type: "entrada", quantity: stock, reason: "Estoque inicial", createdAt: d("2026-09-01T09:00:00Z") } });
    }
    products.push(p);
  }
  const customers = [];
  for (let i = 0; i < NAMES.length; i++) {
    const name = NAMES[i];
    const found = await prisma.customer.findFirst({ where: { organizationId: orgId, name } });
    customers.push(found ?? (await prisma.customer.create({ data: {
      organizationId: orgId, name, status: i === 9 ? "inativo" : "ativo",
      document: i % 3 === 2 ? `12.${300 + i}.678/0001-9${i % 10}` : `123.456.${700 + i}-0${i % 10}`, phone: `(11) 9${8000 + i * 37}-${1000 + i * 91}`,
      email: name.toLowerCase().normalize("NFD").replace(/[^a-z ]/g, "").trim().replace(/ +/g, ".") + "@email.com",
    } })));
  }

  // ---------- financeiro: contas, categorias
  const accountsExist = (await prisma.account.count({ where: { organizationId: orgId } })) > 1;
  if (!accountsExist) {
    await prisma.account.deleteMany({ where: { organizationId: orgId, transactions: { none: {} } } });
    await prisma.account.createMany({ data: [
      { organizationId: orgId, name: "Itaú Empresas", type: "banco" }, { organizationId: orgId, name: "Caixa da Loja", type: "caixa" },
      { organizationId: orgId, name: "Mercado Pago", type: "carteira" }, { organizationId: orgId, name: "CDB Reserva", type: "investimento" },
    ], skipDuplicates: true });
  }
  await prisma.financeCategory.createMany({ data: [["Vendas", "receita"], ["Serviços", "receita"], ["Fornecedores", "despesa"], ["Utilidades", "despesa"], ["Aluguel", "despesa"], ["Marketing", "despesa"]].map(([name, type]) => ({ organizationId: orgId, name, type: type as "receita" | "despesa" })), skipDuplicates: true });
  const acc = Object.fromEntries((await prisma.account.findMany({ where: { organizationId: orgId } })).map((a) => [a.name, a.id]));

  // ---------- vendas (histórico) + entradas no financeiro
  if (!(await prisma.sale.findFirst({ where: { organizationId: orgId, number: 123 }, select: { id: true } }))) {
    for (let i = 36; i >= 0; i--) {
      const number = 123 - i;
      const total = 120 + ((i * 397) % 4800);
      const status = i % 11 === 0 ? "cancelada" : i % 7 === 0 ? "pendente" : "concluida";
      const method = METHODS[i % 5];
      const created = d(`2026-09-${pad(18 - (i % 15))}T${pad(9 + (i % 9))}:${pad((i * 7) % 60)}:00Z`);
      const customer = i % 5 === 0 ? null : customers[i % NAMES.length];
      const prod = products[i % products.length];
      const operator = i % 2 ? "Bruno" : "Maria";
      const sale = await prisma.sale.create({ data: {
        organizationId: orgId, number, customerId: customer?.id, userId: users[operator], origin: i % 3 === 0 ? "manual" : "pdv", status, payment: method, subtotal: total, total,
        register: i % 3 === 0 ? null : i % 2 ? "Caixa #01" : "Caixa #02", createdAt: created, cancelledAt: status === "cancelada" ? created : null,
        items: { create: [{ productId: prod.id, name: prod.name, qty: 1, unitPrice: total, total }] }, payments: { create: [{ method, amount: total }] },
      } });
      if (status === "concluida") await prisma.transaction.create({ data: { organizationId: orgId, accountId: method === "dinheiro" ? acc["Caixa da Loja"] : acc["Itaú Empresas"], date: date(created.getUTCFullYear(), created.getUTCMonth() + 1, created.getUTCDate()), type: "entrada", description: `Venda #${pad(number, 6)}`, category: "Vendas", amount: total, saleId: sale.id } });
    }
    const top = await prisma.sale.aggregate({ where: { organizationId: orgId }, _max: { number: true } });
    await prisma.counter.upsert({ where: { organizationId_key: { organizationId: orgId, key: "sale" } }, create: { organizationId: orgId, key: "sale", value: top._max.number ?? 123 }, update: { value: top._max.number ?? 123 } });
  }
  // vendas concluídas que ainda não têm a entrada no financeiro (ex.: feitas antes do módulo existir)
  for (const s of await prisma.sale.findMany({ where: { organizationId: orgId, status: "concluida", transactions: { none: {} } } })) {
    await prisma.transaction.create({ data: { organizationId: orgId, accountId: s.payment === "dinheiro" ? acc["Caixa da Loja"] : acc["Itaú Empresas"], date: date(s.createdAt.getUTCFullYear(), s.createdAt.getUTCMonth() + 1, s.createdAt.getUTCDate()), type: "entrada", description: `Venda #${pad(s.number, 6)}`, category: "Vendas", amount: s.total, saleId: s.id } });
  }

  // ---------- contas a pagar / a receber (as liquidadas viram movimentação)
  if ((await prisma.financeEntry.count({ where: { organizationId: orgId } })) === 0) {
    for (const kind of ["pagar", "receber"] as const) {
      for (let i = 0; i < 23; i++) {
        const cancelled = i === 5;
        const settled = !cancelled && i % 6 !== 0 && i % 4 === 0;
        const due = date(2026, i % 3 === 0 ? 10 : 9, 1 + ((i * 3) % 28));
        const paidOn = due.getTime() > date(2026, 9, 18).getTime() ? date(2026, 9, 18) : due;
        const amount = 250 + ((i * 523) % 5200);
        const party = kind === "pagar" ? ["Fornecedor XPTO", "Dell Brasil", "Energia SP", "Aluguel Loja", "Contabilidade"][i % 5] : NAMES[i % NAMES.length];
        const description = kind === "pagar" ? ["Compra de mercadorias", "Conta de energia", "Aluguel", "Honorários"][i % 4] : `Venda #${pad(123 - i, 6)}`;
        const category = kind === "pagar" ? ["Fornecedores", "Utilidades", "Aluguel", "Serviços"][i % 4] : "Vendas";
        const e = await prisma.financeEntry.create({ data: { organizationId: orgId, kind, party, description, category, amount, dueDate: due, method: ["PIX", "Boleto", "Transferência"][i % 3], status: cancelled ? "cancelado" : settled ? "liquidado" : "pendente", settledAt: settled ? paidOn : null } });
        if (settled) await prisma.transaction.create({ data: { organizationId: orgId, accountId: acc["Itaú Empresas"], date: paidOn, type: kind === "pagar" ? "saida" : "entrada", description, category, amount, entryId: e.id } });
      }
    }
  }

  // ---------- histórico de estoque
  if (!(await prisma.stockMovement.findFirst({ where: { organizationId: orgId, reason: "Compra fornecedor" }, select: { id: true } }))) {
    for (let i = 0; i < 33; i++) {
      await prisma.stockMovement.create({ data: { organizationId: orgId, productId: products[i % products.length].id, userId: users[["Bruno", "Maria", "João"][i % 3]], type: (["saida", "entrada", "ajuste"] as const)[i % 3], quantity: 1 + (i % 9), reason: ["Venda PDV", "Compra fornecedor", "Inventário"][i % 3], createdAt: d(`2026-09-${pad(18 - (i % 16))}T1${i % 10}:00:00Z`) } });
    }
  }

  // ---------- automações, notificações, auditoria
  if ((await prisma.automation.count({ where: { organizationId: orgId } })) === 0) {
    await prisma.automation.createMany({ data: [
      { organizationId: orgId, name: "Notificar vendas altas", status: "ativa", trigger: "Venda realizada", condition: "Valor > R$ 1.000", action: "Enviar notificação", lastRunAt: d("2026-09-18T10:32:00Z"), runs: 128 },
      { organizationId: orgId, name: "Alertar estoque baixo", status: "ativa", trigger: "Estoque baixo", condition: "Sempre", action: "Enviar email", lastRunAt: d("2026-09-18T08:00:00Z"), runs: 54 },
      { organizationId: orgId, name: "Cobrança de contas vencidas", status: "pausada", trigger: "Conta vencida", condition: "Atraso > 3 dias", action: "Enviar WhatsApp (em breve)", lastRunAt: d("2026-09-10T09:00:00Z"), runs: 31 },
      { organizationId: orgId, name: "Webhook novo cliente", status: "erro", trigger: "Novo cliente", condition: "Sempre", action: "Enviar webhook", lastRunAt: d("2026-09-17T15:20:00Z"), runs: 12 },
    ] });
  }
  if ((await prisma.notification.count({ where: { organizationId: orgId } })) === 0) {
    const N: [string, string, string, string, boolean][] = [
      ["Financeiro", "5 contas vencem hoje", "Revise suas contas a pagar para evitar juros.", "2026-09-18T08:00:00Z", false],
      ["Estoque", "Estoque baixo: Webcam Full HD", "Restam 3 unidades (mínimo 10).", "2026-09-18T09:10:00Z", false],
      ["Venda", "Venda #000123 concluída", "R$ 850,00 via PIX.", "2026-09-18T10:32:00Z", false],
      ["PDV", "Caixa #01 aberto", "Operador Bruno abriu o caixa.", "2026-09-18T08:05:00Z", true],
      ["Automação", "Falha em 'Webhook novo cliente'", "Endpoint retornou 500.", "2026-09-17T15:20:00Z", false],
      ["Sistema", "Assinatura renova em 5 dias", "Plano Professional — R$ 199,00.", "2026-09-16T12:00:00Z", true],
      ["Segurança", "Novo login detectado", "Chrome em Windows, São Paulo/SP.", "2026-09-15T19:40:00Z", true],
    ];
    for (const [category, title, body, at, read] of N) await prisma.notification.create({ data: { organizationId: orgId, category, title, body, createdAt: d(at), readBy: read ? [ownerId] : [] } });
  }
  if ((await prisma.auditLog.count({ where: { organizationId: orgId } })) < 3) {
    await prisma.auditLog.createMany({ data: [
      { organizationId: orgId, userId: ownerId, action: "sale.create", text: "Bruno criou uma venda", createdAt: d("2026-09-18T10:32:00Z") },
      { organizationId: orgId, userId: users.Maria, action: "product.update", text: "Maria atualizou um produto", createdAt: d("2026-09-18T10:40:00Z") },
      { organizationId: orgId, userId: users["João"], action: "payable.settle", text: "João marcou uma conta como paga", createdAt: d("2026-09-18T11:02:00Z") },
    ] });
  }

  // ---------- fiscal
  await prisma.fiscalSettings.upsert({ where: { organizationId: orgId }, create: { organizationId: orgId, environment: "homologacao", regime: "simples", nfeSeries: "1", nfceSeries: "1", cscId: "000001", certName: "certificado-empresa-abc.pfx", certExpiresAt: date(2027, 3, 14) }, update: {} });
  if ((await prisma.fiscalNote.count({ where: { organizationId: orgId } })) === 0) {
    const sales = await prisma.sale.findMany({ where: { organizationId: orgId, status: { not: "cancelada" } }, orderBy: { number: "desc" }, take: 18, include: { customer: { select: { name: true } } } });
    for (let i = 0; i < sales.length; i++) {
      const s = sales[i];
      const status = i % 9 === 4 ? "rejeitada" : i % 7 === 3 ? "pendente" : i === 11 ? "cancelada" : "autorizada";
      const type = s.origin === "pdv" ? "nfce" : "nfe";
      const number = 1200 - i;
      await prisma.fiscalNote.create({ data: {
        organizationId: orgId, saleId: s.id, type, number, series: "1", total: s.total, customerName: s.customer?.name ?? "", issuedAt: s.createdAt, status,
        key: buildAccessKey({ cnpj: "12345678000190", model: type === "nfe" ? 55 : 65, series: "1", number, date: s.createdAt, code: 10_000_000 + i * 1379 }),
        protocol: status === "autorizada" || status === "cancelada" ? `135${digits(i + 9, 12)}` : null,
        rejectReason: status === "rejeitada" ? "Rejeição 539: Duplicidade de NF-e com diferença na chave de acesso." : null,
      } });
    }
    await prisma.counter.createMany({ data: [{ organizationId: orgId, key: "fiscal-nfe", value: 1200 }, { organizationId: orgId, key: "fiscal-nfce", value: 1200 }], skipDuplicates: true });
  }

  // ---------- PIX
  const pix = await prisma.pixSettings.upsert({ where: { organizationId: orgId }, create: { organizationId: orgId, key: "12345678000190", keyType: "cnpj", merchantName: "Empresa ABC LTDA", city: "Sao Paulo" }, update: {} });
  if ((await prisma.pixCharge.count({ where: { organizationId: orgId } })) === 0) {
    for (let i = 0; i < 14; i++) {
      const status = i % 5 === 0 ? "ativa" : i % 7 === 3 ? "expirada" : i === 9 ? "cancelada" : "paga";
      const amount = 80 + ((i * 271) % 2400);
      const txid = `BRS${20260930 - i}${1000 + i}`;
      const at = new Date(Date.UTC(2026, 8, 19 - i, 9 + (i % 8), (i * 13) % 60));
      const expires = status === "ativa" ? new Date(Date.now() + 86_400_000) : new Date(at.getTime() + 86_400_000);
      await prisma.pixCharge.create({ data: { organizationId: orgId, txid, description: ["Pedido balcão", "Mensalidade", "Serviço técnico", "Venda online"][i % 4], customerName: NAMES[i % NAMES.length], amount, payload: buildPixPayload({ key: pix.key, name: pix.merchantName, city: pix.city, amount, txid }), status, expiresAt: expires, paidAt: status === "paga" ? at : null, createdAt: at } });
    }
  }

  // ---------- conciliação bancária
  const banks = await Promise.all([["Itaú", "Ag 0001 · CC 12345-6", true], ["Nubank PJ", "Ag 0001 · CC 98765-4", false]].map(async ([bank, account, connected]) =>
    prisma.bankConnection.upsert({ where: { organizationId_bank: { organizationId: orgId, bank: bank as string } }, create: { organizationId: orgId, bank: bank as string, account: account as string, connected: connected as boolean, lastSyncAt: connected ? new Date() : null }, update: {} })));
  if ((await prisma.bankLine.count({ where: { organizationId: orgId } })) === 0) {
    const descs = ["PIX RECEBIDO", "TED RECEBIDA", "BOLETO PAGO", "PAGTO FORNECEDOR", "TARIFA BANCARIA", "CREDITO CARTAO", "PIX ENVIADO"];
    const pool = await prisma.transaction.findMany({ where: { organizationId: orgId, status: "confirmada" }, orderBy: [{ date: "desc" }, { id: "asc" }], take: 40 });
    for (let i = 0; i < 22; i++) {
      const out = i % 3 === 1 || i % 7 === 6;
      const status = i % 5 === 2 ? "conciliado" : i === 13 ? "ignorado" : "pendente";
      const pair = status === "pendente" && i % 4 !== 3 ? pool[i] : undefined;
      await prisma.bankLine.create({ data: {
        organizationId: orgId, connectionId: banks[0].id, date: pair ? pair.date : date(2026, 9, 19 - (i % 16)), amount: pair ? (pair.type === "saida" ? -1 : 1) * Number(pair.amount) : (out ? -1 : 1) * (60 + ((i * 337) % 3100)), status,
        description: `${descs[i % descs.length]} ${NAMES[i % NAMES.length].toUpperCase().slice(0, 18)}`, matchText: status === "conciliado" ? (out ? "Pagamento fornecedor" : `Venda #${pad(123 - (i % 10), 6)}`) : null, externalId: `seed-${i}`,
      } });
    }
  }

  // ---------- marketplaces
  const mk: [Marketplace, boolean, string | null, boolean, boolean][] = [["mercadolivre", true, "EMPRESAABC", true, true], ["shopee", true, "empresa.abc", true, false], ["amazon", false, null, false, false], ["magalu", false, null, false, false]];
  for (const [marketplace, connected, account, autoStock, autoOrders] of mk) {
    await prisma.marketplaceConnection.upsert({ where: { organizationId_marketplace: { organizationId: orgId, marketplace } }, create: { organizationId: orgId, marketplace, connected, account, autoStock, autoOrders, lastSyncAt: connected ? new Date() : null }, update: {} });
  }
  if ((await prisma.marketplaceOrder.count({ where: { organizationId: orgId } })) === 0) {
    for (let i = 0; i < 19; i++) {
      const shopee = i % 3 === 2;
      await prisma.marketplaceOrder.create({ data: {
        organizationId: orgId, marketplace: shopee ? "shopee" : "mercadolivre", number: (shopee ? "SP" : "ML") + String(2000000 + i * 137), customerName: NAMES[(i * 3) % NAMES.length],
        orderedAt: new Date(Date.UTC(2026, 8, 19 - (i % 12), 8 + (i % 10))), total: 90 + ((i * 313) % 2800),
        status: i % 10 === 0 ? "cancelado" : i % 4 === 0 ? "novo" : i % 4 === 1 ? "faturado" : i % 4 === 2 ? "enviado" : "entregue", invoiced: i % 4 !== 0 && i % 10 !== 0,
      } });
    }
  }
  if ((await prisma.productListing.count({ where: { organizationId: orgId } })) === 0) {
    await prisma.productListing.createMany({ data: products.flatMap((p, i) => [
      ...(i < 8 ? [{ organizationId: orgId, productId: p.id, marketplace: "mercadolivre" as const, published: true }] : []),
      ...(i < 5 && i % 2 === 0 ? [{ organizationId: orgId, productId: p.id, marketplace: "shopee" as const, published: true }] : []),
    ]) });
  }

  // saldos de abertura: fecham nos valores que a empresa tinha antes do histórico
  const targets: Record<string, number> = { "Itaú Empresas": 48250.9, "Caixa da Loja": 3120, "Mercado Pago": 7890.45, "CDB Reserva": 25000 };
  for (const [name, target] of Object.entries(targets)) {
    const rows = await prisma.transaction.groupBy({ by: ["type"], where: { accountId: acc[name], status: "confirmada" }, _sum: { amount: true } });
    const net = Number(rows.find((r) => r.type === "entrada")?._sum.amount ?? 0) - Number(rows.find((r) => r.type === "saida")?._sum.amount ?? 0);
    await prisma.account.update({ where: { id: acc[name] }, data: { openingBalance: r2(target - net) } });
  }

  console.log("Seed aplicado. Senha de todos: senha1234 (empresa: Empresa ABC LTDA)");
  console.log("  bruno@empresaabc.com.br  superadmin");
  console.log("  admin@empresaabc.com.br  admin");
  console.log("  maria@empresaabc.com.br  financeiro");
  console.log("  fiscal@empresaabc.com.br fiscal");
  console.log("  joao@empresaabc.com.br   PDV");
  console.log("  ana@empresaabc.com.br    estoque");
  console.log("  carlos@empresaabc.com.br vendedor");
  console.log("  lia@empresaabc.com.br    consulta");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
