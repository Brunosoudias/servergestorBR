import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcryptjs";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/config/env";
import { configureApp } from "../src/main";
import { MailService } from "../src/mail/mail.service";
import { PrismaService } from "../src/prisma/prisma.service";

const PASSWORD = "Senha1234";
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

describe("PDV e caixa (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailService).useValue({ passwordReset: async () => undefined, invite: async () => undefined, send: async () => undefined })
      .compile();
    app = mod.createNestApplication();
    configureApp(app as never, loadEnv());
    await app.init();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => { await app.close(); });

  async function signup() {
    const agent = request.agent(server());
    const tag = uniq();
    const res = await agent.post("/auth/register").send({ name: `Usuário ${tag}`, email: `${tag}@teste.com`, password: PASSWORD }).expect(201);
    return { agent, orgId: res.body.organization.id as string };
  }
  const withOrg = (agent: request.Agent, orgId: string) => ({
    get: (u: string) => agent.get(u).set("X-Organization-Id", orgId),
    post: (u: string) => agent.post(u).set("X-Organization-Id", orgId),
  });
  const asRole = async (orgId: string, role: string) => {
    const email = `${role}${uniq()}@teste.com`;
    const user = await prisma.user.create({ data: { name: "Maria Operadora", email, passwordHash: await bcrypt.hash(PASSWORD, 4) } });
    await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role: role as never, status: "ativo" } });
    const agent = request.agent(server());
    await agent.post("/auth/login").send({ email, password: PASSWORD }).expect(200);
    return withOrg(agent, orgId);
  };
  const product = (o: Record<string, unknown> = {}) => ({ name: "Mouse", sku: `SKU-${uniq()}`, price: 100, cost: 40, stock: 10, minStock: 2, ...o });
  const saleBody = (productId: string, over: Record<string, unknown> = {}) => ({
    items: [{ productId, qty: 3, discount: 0 }], customerId: null, discount: 20, total: 280,
    payments: [{ method: "dinheiro", amount: 200 }, { method: "pix", amount: 80 }], ...over,
  });

  it("fluxo completo: abrir, vender (dinheiro + PIX), sangria, suprimento e fechar com diferença", async () => {
    const { agent, orgId } = await signup();
    const o = withOrg(agent, orgId);
    const p = (await o.post("/products").send(product({ price: 100, stock: 20 })).expect(201)).body;

    expect((await o.get("/pos/register").expect(200)).body).toMatchObject({ open: false, register: "Caixa #01", operator: "Usuário", initial: 0, cash: 0 });
    const noRegister = await o.post("/pos/sales").send(saleBody(p.id)).expect(409);
    expect(noRegister.body.message).toBe("Abra o caixa antes de vender.");

    const open = (await o.post("/pos/register/open").send({ initial: 100 }).expect(201)).body;
    expect(open).toMatchObject({ open: true, register: "Caixa #01", initial: 100, cash: 0 });
    expect((await o.post("/pos/register/open").send({ initial: 50 }).expect(409)).body.message).toBe("Você já tem um caixa aberto.");

    const sale = (await o.post("/pos/sales").send(saleBody(p.id)).expect(201)).body;
    expect(sale).toMatchObject({ status: "concluida", origin: "pdv", total: 280, register: "Caixa #01", number: "000001" });
    expect((await o.get(`/products/${p.id}`)).body.stock).toBe(17);
    expect((await o.get("/pos/register")).body).toMatchObject({ cash: 200, pix: 80, card: 0, withdrawals: 0, deposits: 0 });

    const tooMuch = await o.post("/pos/register/withdrawal").send({ amount: 400, reason: "Pagamento" }).expect(400);
    expect(tooMuch.body.message).toMatch(/maior que o dinheiro disponível/);
    expect((await o.post("/pos/register/withdrawal").send({ amount: 50, reason: "Fornecedor" }).expect(201)).body.withdrawals).toBe(50);
    expect((await o.post("/pos/register/deposit").send({ amount: 30, reason: "Troco" }).expect(201)).body.deposits).toBe(30);

    const closed = (await o.post("/pos/register/close").send({ counted: 270, notes: "troco errado" }).expect(200)).body;
    expect(closed).toMatchObject({ open: false, expected: 280, counted: 270, difference: -10 });
    expect((await o.get("/pos/register")).body.open).toBe(false);
    await o.post("/pos/sales").send(saleBody(p.id)).expect(409);
    await o.post("/pos/register/close").send({ counted: 0 }).expect(409);

    await o.post("/sales").send({ product: p.id, qty: 1, payment: "pix" }).expect(201);
    const hist = (await o.get("/pos/sales").expect(200)).body;
    expect(hist.total).toBe(1);
    expect(hist.data[0]).toMatchObject({ origin: "pdv", operator: "Usuário" });
    const session = await prisma.cashSession.findFirstOrThrow({ where: { organizationId: orgId } });
    expect(session.status).toBe("fechado");
    expect(Number(session.expected)).toBe(280);
    expect(Number(session.counted)).toBe(270);
  });

  it("confere o total: preço divergente e pagamentos que não fecham a conta são recusados", async () => {
    const { agent, orgId } = await signup();
    const o = withOrg(agent, orgId);
    const p = (await o.post("/products").send(product({ price: 100, stock: 10 })).expect(201)).body;
    await o.post("/pos/register/open").send({ initial: 0 }).expect(201);
    const mismatch = await o.post("/pos/sales").send(saleBody(p.id, { total: 250 })).expect(409);
    expect(mismatch.body.message).toMatch(/valores da venda mudaram/);
    const pay = await o.post("/pos/sales").send(saleBody(p.id, { payments: [{ method: "dinheiro", amount: 100 }] })).expect(400);
    expect(pay.body.message).toBe("O total dos pagamentos não confere com o valor da venda.");
    await o.post("/pos/sales").send(saleBody(p.id, { items: [] })).expect(400);
    expect((await o.get(`/products/${p.id}`)).body.stock).toBe(10);
    expect((await o.get("/pos/register")).body).toMatchObject({ cash: 0, pix: 0 });
    const big = await o.post("/pos/sales").send(saleBody(p.id, { items: [{ productId: p.id, qty: 50 }], discount: 0, total: 5000, payments: [{ method: "dinheiro", amount: 5000 }] })).expect(409);
    expect(big.body.message).toMatch(/Estoque insuficiente/);
  });

  it("descontos por linha e geral: o servidor recalcula (itens + geral) sem contar duas vezes", async () => {
    const { agent, orgId } = await signup();
    const o = withOrg(agent, orgId);
    const p = (await o.post("/products").send(product({ price: 100, stock: 10 })).expect(201)).body;
    await o.post("/pos/register/open").send({ initial: 0 }).expect(201);
    const s = (await o.post("/pos/sales").send({ items: [{ productId: p.id, qty: 4, discount: 40 }], customerId: null, discount: 50, total: 350, payments: [{ method: "credito", amount: 350, installments: 3 }] }).expect(201)).body;
    expect(s.total).toBe(350);
    expect(s).toMatchObject({ subtotal: 360, discount: 10, installments: 3, payment: "credito" });
    expect((await o.get("/pos/register")).body).toMatchObject({ cash: 0, card: 350 });
  });

  it("permissões: caixa opera o PDV mas não dá desconto; cada operador tem o seu caixa", async () => {
    const owner = await signup();
    const o = withOrg(owner.agent, owner.orgId);
    const p = (await o.post("/products").send(product({ price: 100, stock: 30 })).expect(201)).body;
    await o.post("/pos/register/open").send({ initial: 0 }).expect(201);

    const cx = await asRole(owner.orgId, "caixa");
    expect((await cx.get("/pos/register").expect(200)).body).toMatchObject({ open: false, register: "Caixa #02", operator: "Maria" });
    const open = (await cx.post("/pos/register/open").send({ initial: 20 }).expect(201)).body;
    expect(open.register).toBe("Caixa #02");
    const noDiscount = await cx.post("/pos/sales").send(saleBody(p.id)).expect(403);
    expect(noDiscount.body.message).toMatch(/permissão para dar desconto/);
    await cx.post("/pos/sales").send(saleBody(p.id, { discount: 0, total: 300, payments: [{ method: "pix", amount: 300 }] })).expect(201);
    await cx.get("/sales").expect(403);
    expect((await o.get("/pos/register")).body).toMatchObject({ register: "Caixa #01", pix: 0 });
    const vz = await asRole(owner.orgId, "visualizador");
    await vz.post("/pos/register/open").send({ initial: 0 }).expect(403);
  });

  it("isolamento: o caixa e as vendas de uma empresa não aparecem em outra", async () => {
    const a = await signup(); const b = await signup();
    const oa = withOrg(a.agent, a.orgId); const ob = withOrg(b.agent, b.orgId);
    const p = (await oa.post("/products").send(product({ stock: 5 })).expect(201)).body;
    await oa.post("/pos/register/open").send({ initial: 10 }).expect(201);
    await oa.post("/pos/sales").send(saleBody(p.id, { items: [{ productId: p.id, qty: 1 }], discount: 0, total: 100, payments: [{ method: "dinheiro", amount: 100 }] })).expect(201);
    expect((await ob.get("/pos/register")).body).toMatchObject({ open: false, cash: 0 });
    expect((await ob.get("/pos/sales")).body.total).toBe(0);
    expect((await ob.post("/pos/register/open").send({ initial: 0, register: "Caixa #01" }).expect(201)).body.register).toBe("Caixa #01");
    await ob.post("/pos/sales").send(saleBody(p.id, { discount: 0, total: 300, payments: [{ method: "dinheiro", amount: 300 }] })).expect(400);
  });

  it("cancelar uma venda do PDV registra o estorno no caixa e devolve o estoque", async () => {
    const { agent, orgId } = await signup();
    const o = withOrg(agent, orgId);
    const p = (await o.post("/products").send(product({ price: 100, stock: 10 })).expect(201)).body;
    await o.post("/pos/register/open").send({ initial: 0 }).expect(201);
    const sale = (await o.post("/pos/sales").send(saleBody(p.id, { discount: 0, total: 300, payments: [{ method: "dinheiro", amount: 300 }] })).expect(201)).body;
    expect((await o.get("/pos/register")).body.cash).toBe(300);
    expect((await o.post(`/sales/${sale.id}/cancel`).expect(409)).body.message).toMatch(/Histórico do PDV/);
    expect((await o.post(`/pos/sales/${sale.id}/cancel`).send({}).expect(400)).body.message).toBe("Informe o motivo do cancelamento.");
    await o.post(`/pos/sales/${sale.id}/cancel`).send({ reason: "Cliente desistiu" }).expect(200);
    expect((await o.get("/pos/register")).body).toMatchObject({ cash: 300, refunds: 300, expected: 0 });
    expect((await o.get(`/products/${p.id}`)).body.stock).toBe(10);
    expect((await o.get(`/sales/${sale.id}`)).body).toMatchObject({ status: "cancelada", cancelReason: "Cliente desistiu" });
  });

  it("corrida: aberturas simultâneas só criam UM caixa; sangrias simultâneas não passam do saldo", async () => {
    const { agent, orgId } = await signup();
    const o = withOrg(agent, orgId);
    const opens = await Promise.all(Array.from({ length: 5 }, () => o.post("/pos/register/open").send({ initial: 100 })));
    expect(opens.filter((r) => r.status === 201)).toHaveLength(1);
    expect(opens.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await prisma.cashSession.count({ where: { organizationId: orgId, status: "aberto" } })).toBe(1);

    const draws = await Promise.all(Array.from({ length: 5 }, () => o.post("/pos/register/withdrawal").send({ amount: 30, reason: "teste" })));
    expect(draws.filter((r) => r.status === 201)).toHaveLength(3);
    expect(draws.filter((r) => r.status === 400)).toHaveLength(2);
    expect((await o.get("/pos/register")).body.withdrawals).toBe(90);
  });
});
