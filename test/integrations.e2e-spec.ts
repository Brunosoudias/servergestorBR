import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcryptjs";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { ENV, loadEnv } from "../src/config/env";
import { configureApp } from "../src/main";
import { MailService } from "../src/mail/mail.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { mailMock, randomCnpj } from "./helpers";

process.env.FISCAL_SANDBOX_DELAY_MS = "0";
const PASSWORD = "Senha@1234";
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const MAIL = mailMock();

async function boot(override?: Record<string, unknown>) {
  let b = Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MailService).useValue(MAIL);
  if (override) b = b.overrideProvider(ENV).useValue({ ...loadEnv(), ...override });
  const mod = await b.compile();
  const app = mod.createNestApplication();
  configureApp(app as never, loadEnv());
  await app.init();
  return app;
}

describe("Integrações frontend ↔ backend (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const server = () => app.getHttpServer();

  beforeAll(async () => { app = await boot(); prisma = app.get(PrismaService); });
  afterAll(async () => { await app.close(); });

  async function signup() {
    const agent = request.agent(server());
    const tag = uniq();
    const res = await agent.post("/auth/register").send({ name: `Usuário ${tag}`, email: `${tag}@teste.com`, password: PASSWORD }).expect(201);
    const orgId = res.body.organization.id as string;
    const api = (agentX: request.Agent) => ({
      get: (u: string) => agentX.get(u).set("X-Organization-Id", orgId),
      post: (u: string) => agentX.post(u).set("X-Organization-Id", orgId),
      put: (u: string) => agentX.put(u).set("X-Organization-Id", orgId),
      patch: (u: string) => agentX.patch(u).set("X-Organization-Id", orgId),
    });
    return { agent, orgId, tag, ...api(agent), userId: res.body.user.id as string, api };
  }
  type Ctx = Awaited<ReturnType<typeof signup>>;
  const asRole = async (c: Ctx, role: string) => {
    const email = `${role}${uniq()}@teste.com`;
    const user = await prisma.user.create({ data: { name: "Maria Operadora", email, passwordHash: await bcrypt.hash(PASSWORD, 4) } });
    await prisma.membership.create({ data: { userId: user.id, organizationId: c.orgId, role: role as never, status: "ativo" } });
    const agent = request.agent(server());
    await agent.post("/auth/login").send({ email, password: PASSWORD }).expect(200);
    return c.api(agent);
  };
  const product = async (c: Ctx, o: Record<string, unknown> = {}) => (await c.post("/products").send({ name: "Mouse", sku: `SKU-${uniq()}`, price: 100, cost: 40, stock: 10, minStock: 2, ...o }).expect(201)).body;
  const sellManual = async (c: Ctx, productId: string, qty = 2, payment = "pix") => (await c.post("/sales").send({ items: [{ productId, qty }], payment }).expect(201)).body;
  const complete = (c: Ctx, id: string) => c.post(`/sales/${id}/complete`).expect(201);
  const openRegister = (c: Ctx) => c.post("/pos/register/open").send({ initial: 100 }).expect(201);

  describe("Financeiro e carteira", () => {
    it("cria conta padrão e categorias na primeira leitura", async () => {
      const c = await signup();
      const accs = (await c.get("/finance/accounts").expect(200)).body;
      expect(accs).toHaveLength(1);
      expect(accs[0]).toMatchObject({ name: "Caixa da Loja", type: "Caixa", balance: 0, status: "ativa" });
      const cats = (await c.get("/finance/categories").expect(200)).body;
      expect(cats.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(["Vendas", "Fornecedores"]));
    });

    it("conta a pagar: cria, lista, baixa uma vez e gera saída no financeiro e na carteira", async () => {
      const c = await signup();
      const created = (await c.post("/finance/payables").send({ party: "Fornecedor XPTO", description: "Compra de mercadorias", category: "Fornecedores", amount: 250.5, dueDate: "2099-01-10", method: "PIX" }).expect(201)).body;
      expect(created).toMatchObject({ status: "pendente", dueDate: "2099-01-10", amount: 250.5 });
      const list = (await c.get("/finance/payables").expect(200)).body;
      expect(list.total).toBe(1);
      await c.post(`/finance/payables/${created.id}/settle`).expect(201).expect((r) => expect(r.body.status).toBe("pago"));
      await c.post(`/finance/payables/${created.id}/settle`).expect(409);
      const tx = (await c.get("/finance/transactions").expect(200)).body;
      expect(tx.data[0]).toMatchObject({ type: "saida", amount: 250.5, category: "Fornecedores" });
      const overview = (await c.get("/finance/overview").expect(200)).body;
      expect(overview.balance).toBe(-250.5);
      const summary = (await c.get("/wallet/summary").expect(200)).body;
      expect(summary).toMatchObject({ available: -250.5, spent: 250.5, received: 0 });
    });

    it("vencido é derivado: pendente com vencimento passado; filtro por status", async () => {
      const c = await signup();
      await c.post("/finance/receivables").send({ party: "Cliente", description: "Venda antiga", category: "Vendas", amount: 90, dueDate: "2020-01-01" }).expect(201);
      await c.post("/finance/receivables").send({ party: "Cliente", description: "Venda futura", category: "Vendas", amount: 10, dueDate: "2099-01-01" }).expect(201);
      const venc = (await c.get("/finance/receivables?status=vencido").expect(200)).body;
      expect(venc.total).toBe(1);
      expect(venc.data[0].status).toBe("vencido");
      expect((await c.get("/finance/receivables?status=pendente").expect(200)).body.total).toBe(1);
      const ov = (await c.get("/finance/overview").expect(200)).body;
      expect(ov.receivable).toBe(100);
    });

    it("valida entradas (valor, vencimento) e a paginação", async () => {
      const c = await signup();
      await c.post("/finance/payables").send({ party: "X", description: "Y", category: "Z", amount: 0, dueDate: "2099-01-10" }).expect(400);
      await c.post("/finance/payables").send({ party: "Fornecedor", description: "Desc", category: "Aluguel", amount: 10, dueDate: "10/01/2099" }).expect(400);
      for (let i = 0; i < 3; i++) await c.post("/finance/payables").send({ party: `F${i}`, description: `Desc ${i}`, category: "Aluguel", amount: 10 + i, dueDate: "2099-01-10" }).expect(201);
      const p = (await c.get("/finance/payables?pageSize=2&page=2").expect(200)).body;
      expect(p).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(p.data).toHaveLength(1);
    });

    it("venda concluída entra no financeiro; cancelamento lança o estorno", async () => {
      const c = await signup();
      const p = await product(c);
      await openRegister(c);
      const sale = (await c.post("/pos/sales").send({ items: [{ productId: p.id, qty: 2, discount: 0 }], discount: 0, total: 200, payments: [{ method: "dinheiro", amount: 200 }] }).expect(201)).body;
      let accs = (await c.get("/finance/accounts").expect(200)).body;
      expect(accs.find((a: { name: string }) => a.name === "Caixa da Loja").balance).toBe(200);
      await c.post(`/pos/sales/${sale.id}/cancel`).send({ reason: "Cliente desistiu" }).expect(200);
      accs = (await c.get("/finance/accounts").expect(200)).body;
      expect(accs.find((a: { name: string }) => a.name === "Caixa da Loja").balance).toBe(0);
      const stmt = (await c.get("/wallet/statement").expect(200)).body;
      expect(stmt.data.map((x: { description: string }) => x.description)).toEqual(expect.arrayContaining([expect.stringMatching(/^Estorno da venda/), expect.stringMatching(/^Venda #/)]));
    });

    it("extrato da carteira traz saldo corrente e aceita busca e paginação", async () => {
      const c = await signup();
      for (const [d, a] of [["Entrada A", 100], ["Entrada B", 50]] as const) {
        const r = (await c.post("/finance/receivables").send({ party: "Pessoa", description: d, category: "Vendas", amount: a, dueDate: "2099-01-01" }).expect(201)).body;
        await c.post(`/finance/receivables/${r.id}/settle`).expect(201);
      }
      const stmt = (await c.get("/wallet/statement").expect(200)).body;
      expect(stmt.total).toBe(2);
      expect(stmt.data.map((x: { balance: number }) => x.balance)).toEqual([150, 100]);
      const found = (await c.get("/wallet/statement?search=entrada%20a").expect(200)).body;
      expect(found.data).toHaveLength(1);
      expect(found.data[0]).toMatchObject({ in: 100, balance: 100 });
    });

    it("financeiro exige permissão e é isolado por empresa", async () => {
      const a = await signup();
      const b = await signup();
      const e = (await a.post("/finance/payables").send({ party: "Fornecedor", description: "Segredo", category: "Aluguel", amount: 5, dueDate: "2099-01-01" }).expect(201)).body;
      expect((await b.get("/finance/payables").expect(200)).body.total).toBe(0);
      await b.post(`/finance/payables/${e.id}/settle`).expect(404);
      const vendedor = await asRole(a, "vendedor");
      await vendedor.get("/finance/overview").expect(403);
      const financeiro = await asRole(a, "financeiro");
      await financeiro.get("/finance/overview").expect(200);
      const visualizador = await asRole(a, "visualizador");
      await visualizador.get("/finance/payables").expect(200);
      await visualizador.post("/finance/payables").send({ party: "F", description: "D", category: "C", amount: 1, dueDate: "2099-01-01" }).expect(403);
    });
  });

  describe("Estoque", () => {
    it("entrada soma, saída subtrai e ajuste define a contagem; tudo vira movimentação", async () => {
      const c = await signup();
      const p = await product(c, { stock: 10 });
      await c.post("/inventory/movements").send({ productId: p.id, type: "entrada", quantity: 5, reason: "Compra fornecedor" }).expect(201);
      await c.post("/inventory/movements").send({ productId: p.id, type: "saida", quantity: 3, reason: "Perda" }).expect(201);
      expect((await c.get(`/products/${p.id}`).expect(200)).body.stock).toBe(12);
      await c.post("/inventory/movements").send({ productId: p.id, type: "ajuste", quantity: 7, reason: "Inventário" }).expect(201);
      expect((await c.get(`/products/${p.id}`).expect(200)).body.stock).toBe(7);
      const mv = (await c.get("/inventory/movements?pageSize=10").expect(200)).body;
      expect(mv.data.map((m: { type: string }) => m.type)).toEqual(expect.arrayContaining(["entrada", "saida", "ajuste"]));
      expect((await c.get("/inventory/movements?status=ajuste").expect(200)).body.total).toBe(1);
      const s = (await c.get("/inventory/summary").expect(200)).body;
      expect(s).toMatchObject({ totalUnits: 7, totalValue: 280, products: 1, belowMin: 0 });
    });

    it("recusa saída maior que o saldo e quantidade inválida; alerta de estoque baixo vira notificação", async () => {
      const c = await signup();
      const p = await product(c, { stock: 4, minStock: 3 });
      await c.post("/inventory/movements").send({ productId: p.id, type: "saida", quantity: 9, reason: "Erro" }).expect(409);
      await c.post("/inventory/movements").send({ productId: p.id, type: "entrada", quantity: 0, reason: "Nada" }).expect(400);
      await c.post("/inventory/movements").send({ productId: p.id, type: "saida", quantity: 2, reason: "Venda balcão" }).expect(201);
      const n = (await c.get("/notifications").expect(200)).body;
      expect(n.some((x: { category: string; title: string }) => x.category === "Estoque" && x.title.includes("Estoque baixo"))).toBe(true);
      expect((await c.get("/inventory/summary").expect(200)).body.belowMin).toBe(1);
    });

    it("saídas simultâneas nunca deixam o estoque negativo", async () => {
      const c = await signup();
      const p = await product(c, { stock: 5 });
      const res = await Promise.all(Array.from({ length: 6 }, () => c.post("/inventory/movements").send({ productId: p.id, type: "saida", quantity: 1, reason: "Corrida" })));
      expect(res.filter((r) => r.status === 201)).toHaveLength(5);
      expect((await c.get(`/products/${p.id}`).expect(200)).body.stock).toBe(0);
    });

    it("estoque respeita permissões e isolamento", async () => {
      const a = await signup(); const b = await signup();
      const p = await product(a);
      await b.post("/inventory/movements").send({ productId: p.id, type: "entrada", quantity: 1, reason: "Invasor" }).expect(404);
      const vend = await asRole(a, "vendedor");
      await vend.get("/inventory/summary").expect(200);
      await vend.post("/inventory/movements").send({ productId: p.id, type: "entrada", quantity: 1, reason: "Sem permissão" }).expect(403);
      const est = await asRole(a, "estoque");
      await est.post("/inventory/movements").send({ productId: p.id, type: "entrada", quantity: 1, reason: "Estoquista" }).expect(201);
    });
  });

  describe("Dashboard, relatórios e busca", () => {
    async function withData() {
      const c = await signup();
      const p = await product(c, { name: "Notebook Teste", price: 1000, stock: 20 });
      await openRegister(c);
      await c.post("/pos/sales").send({ items: [{ productId: p.id, qty: 2, discount: 0 }], discount: 0, total: 2000, payments: [{ method: "pix", amount: 2000 }] }).expect(201);
      await c.post("/finance/payables").send({ party: "Aluguel Loja", description: "Aluguel de setembro", category: "Aluguel", amount: 500, dueDate: "2099-01-10" }).expect(201);
      return { c, p };
    }

    it("dashboard calcula KPIs, séries, alertas e atividade a partir do banco", async () => {
      const { c } = await withData();
      const d = (await c.get("/dashboard?range=30d").expect(200)).body;
      expect(d.kpis.map((k: { key: string }) => k.key)).toEqual(["receita", "despesa", "lucro", "saldo", "receber", "pagar"]);
      const k = Object.fromEntries(d.kpis.map((x: { key: string; value: number }) => [x.key, x.value]));
      expect(k).toMatchObject({ receita: 2000, despesa: 0, lucro: 2000, saldo: 2000, pagar: 500 });
      expect(d.cashflow).toHaveLength(6);
      expect(d.cashflow[5].receita).toBe(2000);
      expect(d.sales[5].vendas).toBe(1);
      expect(d.stock[0].mov).toBeGreaterThan(0);
      expect(d.activity.some((a: { kind: string }) => a.kind === "sale")).toBe(true);
      expect(Array.isArray(d.alerts)).toBe(true);
      await c.get("/dashboard?range=2026-01-01_2026-01-31").expect(200);
      await c.get("/dashboard?range=today").expect(200);
    });

    it("relatórios dos quatro grupos têm o formato esperado; grupo desconhecido dá 400", async () => {
      const { c } = await withData();
      const v = (await c.get("/reports/vendas").expect(200)).body;
      expect(v.metrics[0]).toMatchObject({ label: "Total vendido", value: 2000, kind: "money" });
      expect(v.rows[0]).toMatchObject({ name: "Notebook Teste", a: 2, b: 2000 });
      const f = (await c.get("/reports/financeiro").expect(200)).body;
      expect(f.metrics.map((m: { value: number }) => m.value)).toEqual([2000, 0, 2000]);
      const e = (await c.get("/reports/estoque").expect(200)).body;
      expect(e.columns).toEqual(["Produto", "Estoque", "Mínimo"]);
      const p = (await c.get("/reports/pdv").expect(200)).body;
      expect(p.metrics[1]).toMatchObject({ label: "Vendas", value: 1 });
      expect(p.rows.map((r: { name: string }) => r.name)).toEqual(expect.arrayContaining(["Cancelamentos", "Descontos"]));
      await c.get("/reports/nada").expect(400);
    });

    it("busca global agrupa resultados e só mostra o que a função pode ver", async () => {
      const { c } = await withData();
      await c.post("/customers").send({ name: "Notebook Cliente", document: "12345678909", phone: "11999999999", email: "n@x.com" }).expect(201);
      const r = (await c.get("/search?q=notebook").expect(200)).body;
      expect(r.map((g: { title: string }) => g.title)).toEqual(expect.arrayContaining(["Clientes", "Produtos"]));
      expect((await c.get("/search?q=a").expect(200)).body).toEqual([]);
      const caixa = await asRole(c, "caixa");
      const g = (await caixa.get("/search?q=aluguel").expect(200)).body;
      expect(g.find((x: { title: string }) => x.title === "Financeiro")).toBeUndefined();
    });

    it("checklist de primeiros passos vem dos dados reais da empresa", async () => {
      const c = await signup();
      const keys = async () => Object.fromEntries((await c.get("/dashboard/checklist").expect(200)).body.map((s: { key: string; done: boolean }) => [s.key, s.done]));
      expect(await keys()).toMatchObject({ customer: false, product: false, sale: false, register: false, movement: false });
      const p = await product(c);
      await c.post("/customers").send({ name: "Cliente Um", document: "12345678909", phone: "11999999999", email: "c@x.com" }).expect(201);
      await openRegister(c);
      await c.post("/inventory/movements").send({ productId: p.id, type: "entrada", quantity: 1, reason: "Compra" }).expect(201);
      await complete(c, (await sellManual(c, p.id)).id);
      expect(Object.values(await keys()).filter(Boolean).length).toBeGreaterThanOrEqual(5);
      expect(await keys()).toMatchObject({ customer: true, product: true, sale: true, register: true, movement: true });
    });

    it("dashboard, relatórios e busca exigem permissão", async () => {
      const { c } = await withData();
      const est = await asRole(c, "estoque");
      await est.get("/dashboard").expect(200);
      await est.get("/reports/vendas").expect(403);
    });
  });

  describe("Notificações e automações", () => {
    it("venda gera aviso; leitura é por usuário; marcar todas como lidas", async () => {
      const c = await signup();
      const p = await product(c);
      const sale = await sellManual(c, p.id);
      await complete(c, sale.id);
      const list = (await c.get("/notifications").expect(200)).body;
      const n = list.find((x: { title: string }) => x.title.startsWith("Venda #"));
      expect(n).toMatchObject({ category: "Venda", read: false });
      const other = await asRole(c, "financeiro");
      await c.post(`/notifications/${n.id}/read`).expect(201);
      expect((await c.get("/notifications").expect(200)).body.find((x: { id: string }) => x.id === n.id).read).toBe(true);
      expect((await other.get("/notifications").expect(200)).body.find((x: { id: string }) => x.id === n.id).read).toBe(false);
      await other.post("/notifications/read-all").expect(201);
      expect((await other.get("/notifications").expect(200)).body.every((x: { read: boolean }) => x.read)).toBe(true);
      await c.post("/notifications/naoexiste/read").expect(404);
    });

    it("automação: cria, alterna e dispara por gatilho e condição (Valor > R$ 1.000)", async () => {
      const c = await signup();
      const a = (await c.post("/automations").send({ name: "Vendas altas", trigger: "Venda realizada", condition: "Valor > R$ 1.000", action: "Enviar notificação" }).expect(201)).body;
      expect(a).toMatchObject({ status: "ativa", runs: 0 });
      const cheap = await product(c, { price: 100 });
      const big = await product(c, { price: 5000 });
      await complete(c, (await sellManual(c, cheap.id, 1)).id);
      expect((await c.get(`/automations/${a.id}`).expect(200)).body.runs).toBe(0);
      await complete(c, (await sellManual(c, big.id, 1)).id);
      const after = (await c.get(`/automations/${a.id}`).expect(200)).body;
      expect(after.runs).toBe(1);
      expect(after.lastRun).not.toBe("");
      expect((await c.get("/notifications").expect(200)).body.some((n: { category: string; title: string }) => n.category === "Automação" && n.title === "Vendas altas")).toBe(true);
      const t = (await c.post(`/automations/${a.id}/toggle`).expect(201)).body;
      expect(t.status).toBe("pausada");
      await complete(c, (await sellManual(c, big.id, 1)).id);
      expect((await c.get(`/automations/${a.id}`).expect(200)).body.runs).toBe(1);
    });

    it("ação sem integração (webhook) marca erro e avisa; automações são validadas e isoladas", async () => {
      const c = await signup(); const other = await signup();
      const a = (await c.post("/automations").send({ name: "Webhook novo produto", trigger: "Novo produto", condition: "Sempre", action: "Enviar webhook" }).expect(201)).body;
      await product(c);
      const after = (await c.get(`/automations/${a.id}`).expect(200)).body;
      expect(after).toMatchObject({ status: "erro", runs: 1 });
      expect((await c.get("/notifications").expect(200)).body.some((n: { title: string }) => n.title.includes("Falha em"))).toBe(true);
      await c.post("/automations").send({ name: "x", trigger: "Inexistente", condition: "Sempre", action: "Criar alerta" }).expect(400);
      await other.get(`/automations/${a.id}`).expect(404);
      await other.post(`/automations/${a.id}/toggle`).expect(404);
      const vis = await asRole(c, "visualizador");
      await vis.get("/automations").expect(200);
      await vis.post("/automations").send({ name: "Nova", trigger: "Novo cliente", condition: "Sempre", action: "Criar alerta" }).expect(403);
    });
  });

  describe("Assinatura", () => {
    it("mostra plano, período de teste e uso real; troca de plano e cancelamento no sandbox", async () => {
      const c = await signup();
      await product(c);
      const cur = (await c.get("/subscription").expect(200)).body;
      expect(cur).toMatchObject({ planId: "starter", status: "trial", cancelAtPeriodEnd: false });
      expect(cur.usage.products).toEqual([1, 500]);
      expect(cur.usage.users[0]).toBe(1);
      const days = (new Date(cur.nextBilling).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(12);
      expect(days).toBeLessThan(15);
      const ck = (await c.post("/subscription/checkout").send({ planId: "business" }).expect(201)).body;
      expect(ck).toEqual({ checkoutUrl: null, planId: "business" });
      const after = (await c.get("/subscription").expect(200)).body;
      expect(after).toMatchObject({ planId: "business", status: "active" });
      expect(after.usage.products[1]).toBeNull();
      await c.post("/subscription/checkout").send({ planId: "ouro" }).expect(400);
      await c.post("/subscription/cancel").expect(201);
      expect((await c.get("/subscription").expect(200)).body.cancelAtPeriodEnd).toBe(true);
      const fin = await asRole(c, "financeiro");
      await fin.get("/subscription").expect(403);
      await fin.post("/subscription/checkout").send({ planId: "starter" }).expect(403);
    });
  });

  describe("Expiração do teste", () => {
    it("teste em andamento informa os dias restantes e não bloqueia nada", async () => {
      const c = await signup();
      const cur = (await c.get("/subscription").expect(200)).body;
      expect(cur.status).toBe("trial");
      expect(cur.trialDaysLeft).toBeGreaterThanOrEqual(13);
      await product(c);
    });

    it("teste vencido: leitura liberada, escrita 402 trial_expired, checkout libera de novo", async () => {
      const c = await signup();
      const p = await product(c);
      await prisma.organization.update({ where: { id: c.orgId }, data: { trialEndsAt: new Date(Date.now() - 60_000) } });

      const cur = (await c.get("/subscription").expect(200)).body;
      expect(cur).toMatchObject({ status: "expired", trialDaysLeft: 0 });
      await c.get("/products").expect(200);
      await c.get("/dashboard").expect(200);

      const blocked = await c.post("/products").send({ name: "Teclado", sku: `SKU-${uniq()}`, price: 10, cost: 5, stock: 1, minStock: 0 }).expect(402);
      expect(blocked.body).toMatchObject({ statusCode: 402, code: "trial_expired" });
      await c.post("/sales").send({ items: [{ productId: p.id, qty: 1 }], payment: "pix" }).expect(402);
      await c.put(`/products/${p.id}`).send({ price: 120 }).expect(402);

      await c.post("/subscription/checkout").send({ planId: "starter" }).expect(201);
      expect((await c.get("/subscription").expect(200)).body).toMatchObject({ status: "active", trialDaysLeft: null });
      await product(c);
    });

    it("teste vencido: cancelar assinatura continua permitido e o bloqueio vale para todos os papéis", async () => {
      const c = await signup();
      await prisma.organization.update({ where: { id: c.orgId }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
      const fin = await asRole(c, "financeiro");
      await fin.post("/finance/payables").send({}).expect(402);
      await c.post("/subscription/cancel").expect(201);
    });

    it("empresa já ativa não é afetada por trialEndsAt no passado", async () => {
      const c = await signup();
      await prisma.organization.update({ where: { id: c.orgId }, data: { subscriptionStatus: "active", trialEndsAt: new Date(Date.now() - 86_400_000) } });
      await product(c);
    });
  });

  describe("Fiscal", () => {
    it("emite nota de venda concluída, autoriza, gera chave válida e não duplica", async () => {
      const c = await signup();
      const p = await product(c);
      const sale = await sellManual(c, p.id);
      await c.post("/fiscal/notes").send({ saleNumber: sale.number, type: "NF-e" }).expect(409);
      await complete(c, sale.id);
      expect((await c.get("/fiscal/pending-sales").expect(200)).body).toHaveLength(1);
      const note = (await c.post("/fiscal/notes").send({ saleNumber: sale.number, type: "NF-e" }).expect(201)).body;
      expect(note).toMatchObject({ type: "NF-e", number: "1", series: "1", saleNumber: sale.number, status: "pendente" });
      expect(note.key).toMatch(/^\d{44}$/);
      const listed = (await c.get("/fiscal/notes").expect(200)).body;
      expect(listed.data[0]).toMatchObject({ status: "autorizada" });
      expect(listed.data[0].protocol).toMatch(/^135\d+/);
      await c.post("/fiscal/notes").send({ saleNumber: sale.number, type: "NF-e" }).expect(409);
      expect((await c.get("/fiscal/pending-sales").expect(200)).body).toHaveLength(0);
      const sum = (await c.get("/fiscal/summary").expect(200)).body;
      expect(sum).toMatchObject({ authorized: 1, pending: 0, rejected: 0, issued: 200 });
    });

    it("cancela nota autorizada (com motivo) e reenvia só rejeitadas; numeração sequencial", async () => {
      const c = await signup();
      const p = await product(c);
      const s1 = await sellManual(c, p.id, 1); await complete(c, s1.id);
      const s2 = await sellManual(c, p.id, 1); await complete(c, s2.id);
      const n1 = (await c.post("/fiscal/notes").send({ saleNumber: s1.number, type: "NFC-e" }).expect(201)).body;
      const n2 = (await c.post("/fiscal/notes").send({ saleNumber: s2.number, type: "NFC-e" }).expect(201)).body;
      expect([n1.number, n2.number]).toEqual(["1", "2"]);
      await c.post(`/fiscal/notes/${n1.id}/retry`).expect(409);
      await c.post(`/fiscal/notes/${n1.id}/cancel`).send({ reason: "x" }).expect(400);
      const cancelled = (await c.post(`/fiscal/notes/${n1.id}/cancel`).send({ reason: "Erro de digitação no valor" }).expect(201)).body;
      expect(cancelled.status).toBe("cancelada");
      await c.post(`/fiscal/notes/${n1.id}/cancel`).send({ reason: "Cancelar de novo" }).expect(409);
      await prisma.fiscalNote.update({ where: { id: n2.id }, data: { status: "rejeitada", protocol: null, rejectReason: "Rejeição 539" } });
      const retry = (await c.post(`/fiscal/notes/${n2.id}/retry`).expect(201)).body;
      expect(retry).toMatchObject({ status: "autorizada" });
      expect(retry.rejectReason).toBeUndefined();
      expect((await c.get("/fiscal/pending-sales").expect(200)).body.map((s: { number: string }) => s.number)).toEqual([s1.number]);
    });

    it("configurações: token CSC nunca volta em claro, certificado é guardado, permissões e isolamento", async () => {
      const c = await signup(); const b = await signup();
      const init = (await c.get("/fiscal/settings").expect(200)).body;
      expect(init).toMatchObject({ environment: "homologacao", regime: "simples", nfeSeries: "1", cscToken: "", certificate: null });
      const saved = (await c.put("/fiscal/settings").send({ environment: "producao", regime: "presumido", nfeSeries: "2", cscId: "000123", cscToken: "SEGREDO-CSC", certificate: { name: "empresa.pfx", expiresAt: "2027-03-14" } }).expect(200)).body;
      expect(saved).toMatchObject({ environment: "producao", regime: "presumido", nfeSeries: "2", cscId: "000123", certificate: { name: "empresa.pfx", expiresAt: "2027-03-14" } });
      expect(saved.cscToken).not.toContain("SEGREDO");
      expect(saved.cscToken).not.toBe("");
      const row = await prisma.fiscalSettings.findUniqueOrThrow({ where: { organizationId: c.orgId } });
      expect(row.cscTokenEnc).not.toContain("SEGREDO");
      await c.put("/fiscal/settings").send({ cscToken: saved.cscToken }).expect(200);
      expect((await prisma.fiscalSettings.findUniqueOrThrow({ where: { organizationId: c.orgId } })).cscTokenEnc).toBe(row.cscTokenEnc);
      await c.put("/fiscal/settings").send({ certificate: null }).expect(200).expect((r) => expect(r.body.certificate).toBeNull());
      expect((await b.get("/fiscal/settings").expect(200)).body.cscId).toBe("");
      const viewer = await asRole(c, "visualizador");
      await viewer.get("/fiscal/notes").expect(200);
      await viewer.put("/fiscal/settings").send({ regime: "real" }).expect(403);
      await (await asRole(c, "vendedor")).get("/fiscal/notes").expect(403);
    });
  });

  describe("PIX", () => {
    it("configuração inicial vem da empresa; cobrança gera BR Code válido e baixa no financeiro ao pagar", async () => {
      const c = await signup();
      const cnpj = randomCnpj();
      await c.put("/company").send({ name: "Loja Teste", cnpj, email: "l@x.com", phone: "11999999999", city: "Sao Paulo", state: "SP" }).expect(200);
      const st = (await c.get("/pix/settings").expect(200)).body;
      expect(st).toMatchObject({ key: cnpj, keyType: "cnpj", merchantName: "Loja Teste", sandbox: true });
      const ch = (await c.post("/pix/charges").send({ description: "Pedido balcão", customer: "João", amount: 150.75, expiresInMinutes: 30 }).expect(201)).body;
      expect(ch).toMatchObject({ status: "ativa", amount: 150.75, customer: "João" });
      expect(ch.payload).toMatch(/^000201/);
      expect(ch.payload).toContain("br.gov.bcb.pix");
      expect(ch.payload).toContain("150.75");
      expect(ch.payload).toMatch(/6304[0-9A-F]{4}$/);
      expect((await c.get("/pix/summary").expect(200)).body).toMatchObject({ pending: 150.75, activeCount: 1, received: 0 });
      const paid = (await c.post(`/pix/charges/${ch.id}/simulate-payment`).expect(201)).body;
      expect(paid.status).toBe("paga");
      await c.post(`/pix/charges/${ch.id}/simulate-payment`).expect(409);
      await c.post(`/pix/charges/${ch.id}/cancel`).expect(409);
      expect((await c.get("/pix/summary").expect(200)).body).toMatchObject({ received: 150.75, paidCount: 1, pending: 0 });
      expect((await c.get("/finance/overview").expect(200)).body.balance).toBe(150.75);
      const tx = (await c.get("/finance/transactions").expect(200)).body.data[0];
      expect(tx).toMatchObject({ type: "entrada", amount: 150.75, description: expect.stringContaining(ch.txid) });
    });

    it("cancela, expira por prazo, filtra e valida; isolamento por empresa", async () => {
      const c = await signup(); const b = await signup();
      await c.put("/pix/settings").send({ key: "chave@loja.com", keyType: "email", merchantName: "Loja Teste", city: "Sao Paulo" }).expect(200);
      const a1 = (await c.post("/pix/charges").send({ description: "A cancelar", amount: 10, expiresInMinutes: 10 }).expect(201)).body;
      await c.post(`/pix/charges/${a1.id}/cancel`).expect(201).expect((r) => expect(r.body.status).toBe("cancelada"));
      const a2 = (await c.post("/pix/charges").send({ description: "Vai expirar", amount: 20, expiresInMinutes: 5 }).expect(201)).body;
      await prisma.pixCharge.update({ where: { id: a2.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const exp = (await c.get("/pix/charges?status=expirada").expect(200)).body;
      expect(exp.total).toBe(1);
      await c.post(`/pix/charges/${a2.id}/simulate-payment`).expect(409);
      await c.post("/pix/charges").send({ description: "x", amount: 0, expiresInMinutes: 5 }).expect(400);
      await c.post("/pix/charges").send({ description: "ok", amount: 5, expiresInMinutes: 0 }).expect(400);
      expect((await c.get("/pix/charges?search=cancelar").expect(200)).body.total).toBe(1);
      await b.post(`/pix/charges/${a1.id}/cancel`).expect(404);
      expect((await b.get("/pix/charges").expect(200)).body.total).toBe(0);
      const cx = await asRole(c, "caixa");
      await cx.get("/pix/charges").expect(403);
    });
  });

  describe("Conciliação bancária", () => {
    const OFX = `OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>\n<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260918120000<TRNAMT>150.75<FITID>A1<MEMO>PIX RECEBIDO JOAO\n</STMTTRN>\n<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260917<TRNAMT>-1200.00<FITID>B2<MEMO>PAGTO FORNECEDOR\n</STMTTRN>\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

    it("importa OFX e CSV, ignora repetidos e recusa arquivo sem lançamentos", async () => {
      const c = await signup();
      expect((await c.post("/bank/import").send({ fileName: "extrato.ofx", content: OFX }).expect(201)).body).toEqual({ imported: 2 });
      expect((await c.post("/bank/import").send({ fileName: "extrato.ofx", content: OFX }).expect(201)).body).toEqual({ imported: 0 });
      const csv = "Data;Descrição;Valor\n19/09/2026;TED RECEBIDA MARIA;2.500,00\n19/09/2026;TARIFA;-15,90\n";
      expect((await c.post("/bank/import").send({ fileName: "extrato.csv", content: csv }).expect(201)).body).toEqual({ imported: 2 });
      expect((await c.post("/bank/import").send({ fileName: "extrato.csv", content: csv }).expect(201)).body).toEqual({ imported: 0 });
      await c.post("/bank/import").send({ fileName: "lixo.csv", content: "nada de util aqui, só texto solto" }).expect(400);
      await c.post("/bank/import").send({ fileName: "vazio.csv", content: "" }).expect(400);
      const lines = (await c.get("/bank/lines?pageSize=10").expect(200)).body;
      expect(lines.total).toBe(4);
      expect(lines.data.find((l: { description: string }) => l.description === "TED RECEBIDA MARIA")).toMatchObject({ amount: 2500, status: "pendente" });
      expect(lines.data.find((l: { description: string }) => l.description === "TARIFA").amount).toBe(-15.9);
    });

    it("aceita extratos grandes (acima de 100 kb) só na importação e limita a 5.000 lançamentos", async () => {
      const c = await signup();
      const big = ["Data;Descrição;Valor", ...Array.from({ length: 6000 }, (_, i) => `19/09/2026;LINHA ${i} DO EXTRATO BANCARIO;-${i + 1},00`)].join("\n");
      expect(big.length).toBeGreaterThan(200_000);
      expect((await c.post("/bank/import").send({ fileName: "grande.csv", content: big }).expect(201)).body).toEqual({ imported: 5000 });
      await c.post("/products").send({ name: "Grande", sku: "G1", price: 1, image: "x".repeat(200_000) }).expect(413);
    });

    it("sugere o lançamento de mesmo valor e concilia; sem par cria o lançamento; ignora; resumo", async () => {
      const c = await signup();
      const r = (await c.post("/finance/receivables").send({ party: "João", description: "Venda balcão", category: "Vendas", amount: 150.75, dueDate: "2026-09-18" }).expect(201)).body;
      await c.post(`/finance/receivables/${r.id}/settle`).expect(201);
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      await c.post("/bank/import").send({ fileName: "e.ofx", content: OFX.replace("20260918120000", `${today}120000`) }).expect(201);
      const sum1 = (await c.get("/bank/summary").expect(200)).body;
      expect(sum1).toMatchObject({ pending: 2, suggested: 1, reconciledPct: 0 });
      const pend = (await c.get("/bank/lines?status=pendente").expect(200)).body.data;
      const withSug = pend.find((l: { suggestion?: unknown }) => l.suggestion);
      expect(withSug.suggestion).toMatchObject({ description: "Venda balcão", amount: 150.75 });
      const done = (await c.post(`/bank/lines/${withSug.id}/reconcile`).expect(201)).body;
      expect(done).toMatchObject({ status: "conciliado", match: "Venda balcão" });
      await c.post(`/bank/lines/${withSug.id}/reconcile`).expect(409);
      const noSug = pend.find((l: { suggestion?: unknown }) => !l.suggestion);
      await c.post(`/bank/lines/${noSug.id}/reconcile`).expect(409);
      const bal0 = (await c.get("/finance/overview").expect(200)).body.balance;
      const created = (await c.post(`/bank/lines/${noSug.id}/create-entry`).send({ category: "Fornecedores" }).expect(201)).body;
      expect(created).toMatchObject({ status: "conciliado", match: "Lançamento criado (Fornecedores)" });
      expect((await c.get("/finance/overview").expect(200)).body.balance).toBe(bal0 - 1200);
      await c.post(`/bank/lines/${noSug.id}/ignore`).expect(409);
      await c.post("/bank/import").send({ fileName: "n.csv", content: "Data;Descrição;Valor\n20/09/2026;COBRANCA X;-30,00\n" }).expect(201);
      const line = (await c.get("/bank/lines?status=pendente").expect(200)).body.data[0];
      await c.post(`/bank/lines/${line.id}/ignore`).expect(201).expect((res) => expect(res.body.status).toBe("ignorado"));
      const s = (await c.get("/bank/summary").expect(200)).body;
      expect(s.reconciledPct).toBe(67);
      await c.post("/bank/lines/naoexiste/ignore").expect(404);
    });

    it("conexões bancárias: liga/desliga no sandbox; permissões e isolamento", async () => {
      const c = await signup(); const b = await signup();
      const conns = (await c.get("/bank/connections").expect(200)).body;
      expect(conns.length).toBeGreaterThanOrEqual(2);
      expect(conns.every((x: { connected: boolean }) => !x.connected)).toBe(true);
      const on = (await c.post(`/bank/connections/${conns[0].id}/toggle`).expect(201)).body;
      expect(on.connected).toBe(true);
      expect(on.lastSync).toBeTruthy();
      expect((await c.post(`/bank/connections/${conns[0].id}/toggle`).expect(201)).body.connected).toBe(false);
      await b.post(`/bank/connections/${conns[0].id}/toggle`).expect(404);
      const vis = await asRole(c, "visualizador");
      await vis.get("/bank/lines").expect(200);
      await vis.post("/bank/import").send({ fileName: "a.csv", content: "Data;Descrição;Valor\n20/09/2026;X;1,00\n" }).expect(403);
    });
  });

  describe("Marketplaces", () => {
    it("conecta, publica anúncios só com canal conectado e desconecta despublicando", async () => {
      const c = await signup();
      const p = await product(c);
      const conns = (await c.get("/marketplaces").expect(200)).body;
      expect(conns.map((x: { id: string }) => x.id)).toEqual(["mercadolivre", "shopee", "amazon", "magalu"]);
      expect(conns.every((x: { connected: boolean }) => !x.connected)).toBe(true);
      await c.post(`/marketplaces/listings/${p.id}/toggle`).send({ marketplace: "shopee" }).expect(409);
      const ml = (await c.post("/marketplaces/mercadolivre/connect").expect(201)).body;
      expect(ml).toMatchObject({ connected: true, autoStock: true, autoOrders: true, listings: 0 });
      const listing = (await c.post(`/marketplaces/listings/${p.id}/toggle`).send({ marketplace: "mercadolivre" }).expect(201)).body;
      expect(listing.published).toMatchObject({ mercadolivre: true, shopee: false });
      expect((await c.get("/marketplaces").expect(200)).body[0].listings).toBe(1);
      expect((await c.get("/marketplaces/listings").expect(200)).body.data[0].published.mercadolivre).toBe(true);
      expect((await c.post(`/marketplaces/listings/${p.id}/toggle`).send({ marketplace: "mercadolivre" }).expect(201)).body.published.mercadolivre).toBe(false);
      await c.post(`/marketplaces/listings/${p.id}/toggle`).send({ marketplace: "orkut" }).expect(400);
      await c.post(`/marketplaces/listings/${p.id}/toggle`).send({ marketplace: "mercadolivre" }).expect(201);
      const upd = (await c.patch("/marketplaces/mercadolivre").send({ autoStock: false }).expect(200)).body;
      expect(upd).toMatchObject({ autoStock: false, autoOrders: true });
      await c.patch("/marketplaces/shopee").send({ autoStock: true }).expect(409);
      const sync = (await c.post("/marketplaces/mercadolivre/sync").expect(201)).body;
      expect(sync.lastSync).toBeTruthy();
      await c.post("/marketplaces/amazon/sync").expect(409);
      const off = (await c.post("/marketplaces/mercadolivre/disconnect").expect(201)).body;
      expect(off).toMatchObject({ connected: false, listings: 0 });
      await c.post("/marketplaces/orkut/connect").expect(404);
    });

    it("importa pedido como venda uma única vez: cria a venda e lança no financeiro", async () => {
      const c = await signup();
      const o = await prisma.marketplaceOrder.create({ data: { organizationId: c.orgId, marketplace: "shopee", number: "SP1001", customerName: "Fernanda", total: 320.5, status: "novo" } });
      const cancelled = await prisma.marketplaceOrder.create({ data: { organizationId: c.orgId, marketplace: "shopee", number: "SP1002", total: 10, status: "cancelado" } });
      expect((await c.get("/marketplaces/summary").expect(200)).body).toMatchObject({ newOrders: 1, toInvoice: 1, revenue: 320.5, connected: 0 });
      const inv = (await c.post(`/marketplaces/orders/${o.id}/invoice`).expect(201)).body;
      expect(inv).toMatchObject({ invoiced: true, status: "faturado" });
      await c.post(`/marketplaces/orders/${o.id}/invoice`).expect(409);
      await c.post(`/marketplaces/orders/${cancelled.id}/invoice`).expect(409);
      const sales = (await c.get("/sales").expect(200)).body;
      expect(sales.data[0]).toMatchObject({ total: 320.5, status: "concluida" });
      expect((await c.get("/finance/overview").expect(200)).body.balance).toBe(320.5);
      expect((await c.get("/marketplaces/orders?status=faturado").expect(200)).body.total).toBe(1);
      expect((await c.get("/marketplaces/orders?search=SP1001").expect(200)).body.total).toBe(1);
      const other = await signup();
      await other.post(`/marketplaces/orders/${o.id}/invoice`).expect(404);
      const viewer = await asRole(c, "visualizador");
      await viewer.get("/marketplaces").expect(200);
      await viewer.post("/marketplaces/shopee/connect").expect(403);
      await (await asRole(c, "estoque")).get("/marketplaces").expect(403);
    });
  });

  describe("Modo live sem provedores contratados", () => {
    it("emissão fiscal, PIX pago, conexões e gateway recusam com 503 e mensagem clara", async () => {
      const live = await boot({ integrations: "live" });
      try {
        const agent = request.agent(live.getHttpServer());
        const tag = uniq();
        const reg = await agent.post("/auth/register").send({ name: `U ${tag}`, email: `${tag}@teste.com`, password: PASSWORD }).expect(201);
        const org = reg.body.organization.id as string;
        const h = (r: request.Test) => r.set("X-Organization-Id", org);
        await h(agent.put("/pix/settings")).send({ key: "chave@loja.com", keyType: "email", merchantName: "Loja", city: "Sao Paulo" }).expect(200);
        const r1 = await h(agent.post("/fiscal/notes")).send({ saleNumber: "000001", type: "NF-e" }).expect(503);
        expect(r1.body.message).toMatch(/emissor de notas fiscais.*não está configurado/i);
        await h(agent.post("/subscription/checkout")).send({ planId: "business" }).expect(503);
        await h(agent.post("/marketplaces/shopee/connect")).expect(503);
        await h(agent.post("/marketplaces/shopee/sync")).expect(503);
        const conns = (await h(agent.get("/bank/connections")).expect(200)).body;
        await h(agent.post(`/bank/connections/${conns[0].id}/toggle`)).expect(503);
        const ch = (await h(agent.post("/pix/charges")).send({ description: "Cobrança", amount: 10, expiresInMinutes: 5 }).expect(201)).body;
        await h(agent.post(`/pix/charges/${ch.id}/simulate-payment`)).expect(503);
        expect((await h(agent.get("/pix/settings")).expect(200)).body.sandbox).toBe(false);
      } finally { await live.close(); }
    });
  });
});
