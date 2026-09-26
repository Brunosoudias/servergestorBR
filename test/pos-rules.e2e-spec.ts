import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcryptjs";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/config/env";
import { configureApp } from "../src/main";
import { MailService } from "../src/mail/mail.service";
import { PosService } from "../src/pos/pos.service";
import { PrismaService } from "../src/prisma/prisma.service";

const PASSWORD = "Senha1234";
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
type Client = { get: (u: string) => request.Test; post: (u: string) => request.Test; put: (u: string) => request.Test };

describe("PDV: regras de caixa e de venda (e2e)", () => {
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

  const withOrg = (agent: request.Agent, orgId: string): Client => ({
    get: (u) => agent.get(u).set("X-Organization-Id", orgId),
    post: (u) => agent.post(u).set("X-Organization-Id", orgId),
    put: (u) => agent.put(u).set("X-Organization-Id", orgId),
  });
  async function signup() {
    const agent = request.agent(server());
    const email = `${uniq()}@teste.com`;
    const res = await agent.post("/auth/register").send({ name: `Dono ${uniq()}`, email, password: PASSWORD }).expect(201);
    const orgId = res.body.organization.id as string;
    return { o: withOrg(agent, orgId), orgId, email };
  }
  const asRole = async (orgId: string, role: string) => {
    const email = `${role}${uniq()}@teste.com`;
    const user = await prisma.user.create({ data: { name: `Pessoa ${role}`, email, passwordHash: await bcrypt.hash(PASSWORD, 4) } });
    await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role: role as never, status: "ativo" } });
    const agent = request.agent(server());
    await agent.post("/auth/login").send({ email, password: PASSWORD }).expect(200);
    return { c: withOrg(agent, orgId), email, userId: user.id };
  };
  const newProduct = async (o: Client, over: Record<string, unknown> = {}) =>
    (await o.post("/products").send({ name: "Caneca", sku: `SKU-${uniq()}`, price: 100, cost: 40, stock: 20, minStock: 0, ...over }).expect(201)).body as { id: string };
  const sell = (o: Client, productId: string, payments: Record<string, unknown>[], over: Record<string, unknown> = {}) => {
    const { qty = 1, ...rest } = over as { qty?: number };
    const total = payments.reduce((a, p) => a + (p.amount as number), 0);
    return o.post("/pos/sales").send({ items: [{ productId, qty, discount: 0 }], customerId: null, discount: 0, total, payments, ...rest });
  };

  it("cancelamento de venda de caixa já fechado: estorno cai no caixa aberto de quem cancela e o fechamento antigo não muda", async () => {
    const { o, orgId, email } = await signup();
    const p = await newProduct(o);
    await o.post("/pos/register/open").send({ initial: 0 }).expect(201);
    const sale = (await sell(o, p.id, [{ method: "dinheiro", amount: 100 }]).expect(201)).body;
    const closedA = (await o.post("/pos/register/close").send({ counted: 100 }).expect(200)).body;
    expect(closedA).toMatchObject({ expected: 100, difference: 0 });

    const cx = await asRole(orgId, "caixa");
    const cxCancel = await cx.c.post(`/pos/sales/${sale.id}/cancel`).send({ reason: "Produto com defeito" }).expect(403);
    expect(cxCancel.body.code).toBe("supervisor_required");

    await cx.c.post("/pos/register/open").send({ initial: 20 }).expect(201);
    const auth = (await cx.c.post("/pos/authorize").send({ email, password: PASSWORD, action: "cancel" }).expect(201)).body;
    const noCash = await cx.c.post(`/pos/sales/${sale.id}/cancel`).send({ reason: "Produto com defeito", authorizationId: auth.authorizationId }).expect(409);
    expect(noCash.body.message).toMatch(/dinheiro suficiente/);
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe("concluida");

    await cx.c.post("/pos/register/deposit").send({ amount: 100, reason: "Troco" }).expect(201);
    const reused = await cx.c.post(`/pos/sales/${sale.id}/cancel`).send({ reason: "Produto com defeito", authorizationId: auth.authorizationId }).expect(403);
    expect(reused.body.message).toMatch(/inválida ou expirada/);
    const auth2 = (await cx.c.post("/pos/authorize").send({ email, password: PASSWORD, action: "cancel" }).expect(201)).body;
    await cx.c.post(`/pos/sales/${sale.id}/cancel`).send({ reason: "Produto com defeito", authorizationId: auth2.authorizationId }).expect(200);
    expect((await cx.c.get("/pos/register")).body).toMatchObject({ refunds: 100, expected: 20 });

    const sessionA = await prisma.cashSession.findFirstOrThrow({ where: { organizationId: orgId, status: "fechado" } });
    const reportA = (await o.get(`/pos/sessions/${sessionA.id}`).expect(200)).body;
    expect(reportA).toMatchObject({ expected: 100, counted: 100, difference: 0 });
    await cx.c.post(`/pos/sales/${sale.id}/cancel`).send({ reason: "de novo" }).expect(409);
  });

  it("financeiro por forma de pagamento: dinheiro na gaveta, cartão a receber líquido de taxa, taxa do PIX lançada; cancelamento estorna tudo", async () => {
    const { o, orgId } = await signup();
    const bank = await prisma.account.create({ data: { organizationId: orgId, name: "Banco X", type: "banco" } });
    await o.put("/pos/payment-methods/credito").send({ feePercent: 3, installmentFeePercent: 5, settlementDays: 30 }).expect(200);
    await o.put("/pos/payment-methods/pix").send({ feePercent: 1, accountId: bank.id }).expect(200);
    expect((await o.put("/pos/payment-methods/dinheiro").send({ settlementDays: 2 }).expect(400)).body.message).toMatch(/prazo de repasse deve ser zero/);
    const p = await newProduct(o, { price: 100 });
    await o.post("/pos/register/open").send({ initial: 0 }).expect(201);
    const sale = (await sell(o, p.id, [{ method: "dinheiro", amount: 100 }, { method: "credito", amount: 200, installments: 2 }, { method: "pix", amount: 100 }], { qty: 4 }).expect(201)).body;

    const txs = await prisma.transaction.findMany({ where: { saleId: sale.id }, include: { account: true } });
    const cash = txs.find((t) => t.account.type === "caixa" && t.type === "entrada");
    expect(Number(cash?.amount)).toBe(100);
    expect(txs.filter((t) => t.accountId === bank.id).map((t) => [t.type, Number(t.amount)]).sort()).toEqual([["entrada", 100], ["saida", 1]]);
    const entries = await prisma.financeEntry.findMany({ where: { saleId: sale.id }, orderBy: { dueDate: "asc" } });
    expect(entries.map((e) => Number(e.amount))).toEqual([95, 95]);
    expect(entries[1].dueDate.getTime() - entries[0].dueDate.getTime()).toBe(30 * 86_400_000);

    await o.post(`/pos/sales/${sale.id}/cancel`).send({ reason: "Erro de digitação" }).expect(200);
    expect((await prisma.financeEntry.findMany({ where: { saleId: sale.id } })).every((e) => e.status === "cancelado")).toBe(true);
    const after = await prisma.transaction.findMany({ where: { saleId: sale.id } });
    const net = (accountId: string) => after.filter((t) => t.accountId === accountId).reduce((a, t) => a + (t.type === "entrada" ? 1 : -1) * Number(t.amount), 0);
    expect(net(bank.id)).toBe(0);
    expect(net(cash!.accountId)).toBe(0);
    expect((await o.get("/pos/register")).body).toMatchObject({ cash: 100, refunds: 100, expected: 0, pix: 0, card: 0 });
  });

  it("troco gravado, sangria para o banco, fechamento com fundo de troco, recolhimento e quebra no financeiro", async () => {
    const { o, orgId } = await signup();
    const bank = await prisma.account.create({ data: { organizationId: orgId, name: "Banco Y", type: "banco" } });
    const p = await newProduct(o, { price: 100 });
    await o.post("/pos/register/open").send({ initial: 50 }).expect(201);
    const sale = (await sell(o, p.id, [{ method: "dinheiro", amount: 100, received: 150 }]).expect(201)).body;
    expect(sale.payments[0]).toMatchObject({ amount: 100, received: 150, change: 50 });
    expect((await sell(o, p.id, [{ method: "dinheiro", amount: 100, received: 80 }]).expect(400)).body.message).toMatch(/recebido em dinheiro menor/);

    await o.post("/pos/register/withdrawal").send({ amount: 60, reason: "Depósito", accountId: bank.id }).expect(201);
    const cashAcc = await prisma.account.findFirstOrThrow({ where: { organizationId: orgId, type: "caixa" } });
    const moves = await prisma.transaction.findMany({ where: { organizationId: orgId, category: "Transferência" } });
    expect(moves.map((m) => [m.accountId === bank.id ? "banco" : m.accountId === cashAcc.id ? "caixa" : "?", m.type, Number(m.amount)]).sort()).toEqual([["banco", "entrada", 60], ["caixa", "saida", 60]]);

    expect((await o.post("/pos/register/close").send({ counted: 85 }).expect(400)).body.message).toMatch(/informe uma observação/);
    expect((await o.post("/pos/register/close").send({ counted: 85, notes: "faltou", float: 90 }).expect(400)).body.message).toMatch(/fundo de troco/);
    const closed = (await o.post("/pos/register/close").send({ counted: 85, notes: "faltou troco", float: 30, destinationAccountId: bank.id, counts: [{ method: "pix", counted: 0 }] }).expect(200)).body;
    expect(closed).toMatchObject({ expected: 90, counted: 85, difference: -5, float: 30, collected: 55 });
    const quebra = await prisma.transaction.findFirstOrThrow({ where: { organizationId: orgId, category: "Quebra de caixa" } });
    expect([quebra.type, Number(quebra.amount), quebra.accountId]).toEqual(["saida", 5, cashAcc.id]);
    const recolhido = await prisma.transaction.findFirstOrThrow({ where: { organizationId: orgId, description: { startsWith: "Recolhimento" }, accountId: bank.id } });
    expect(Number(recolhido.amount)).toBe(55);
    const session = await prisma.cashSession.findFirstOrThrow({ where: { organizationId: orgId }, include: { counts: true } });
    expect(session.counts.map((c) => c.method).sort()).toEqual(["dinheiro", "pix"]);
    expect((await o.get("/pos/register")).body.lastFloat).toBe(30);
  });

  it("gerente vê todos os caixas, operador só o seu; fechamento administrativo e relatório Z", async () => {
    const { o, orgId } = await signup();
    const p = await newProduct(o);
    const cx = await asRole(orgId, "caixa");
    await cx.c.post("/pos/register/open").send({ initial: 10 }).expect(201);
    await sell(cx.c, p.id, [{ method: "dinheiro", amount: 100 }]).expect(201);
    await sell(cx.c, p.id, [{ method: "pix", amount: 100 }]).expect(201);
    await o.post("/pos/register/open").send({ initial: 0 }).expect(201);

    const all = (await o.get("/pos/sessions?status=aberto").expect(200)).body;
    expect(all.total).toBe(2);
    const cxRow = all.data.find((s: { userId: string }) => s.userId === cx.userId);
    expect(cxRow).toMatchObject({ status: "aberto", expected: 110, salesCount: 2, salesTotal: 200 });
    expect((await cx.c.get("/pos/sessions").expect(200)).body.total).toBe(1);
    const mine = await prisma.cashSession.findFirstOrThrow({ where: { organizationId: orgId, userId: { not: cx.userId } } });
    await cx.c.get(`/pos/sessions/${mine.id}`).expect(403);
    await cx.c.post(`/pos/sessions/${cxRow.id}/close`).send({ counted: 110, notes: "teste" }).expect(403);

    expect((await o.post(`/pos/sessions/${cxRow.id}/close`).send({ counted: 110 }).expect(400)).body.message).toBe("Informe o motivo do fechamento administrativo.");
    await o.post(`/pos/sessions/${cxRow.id}/close`).send({ counted: 110, notes: "Operador esqueceu aberto" }).expect(200);
    expect((await cx.c.get("/pos/register")).body.open).toBe(false);
    const z = (await o.get(`/pos/sessions/${cxRow.id}`).expect(200)).body;
    expect(z).toMatchObject({ status: "fechado", forced: true, expected: 110, counted: 110, difference: 0, sales: { count: 2, total: 200, average: 100 } });
    expect(z.byMethod.map((m: { method: string; net: number }) => [m.method, m.net])).toEqual([["dinheiro", 100], ["pix", 100]]);
    expect(z.closedBy).toMatch(/^Dono/);
  });

  it("fechamento cego: o operador não vê o esperado nem a diferença; o gerente vê", async () => {
    const { o, orgId } = await signup();
    await o.put("/pos/settings").send({ blindClose: true }).expect(200);
    const p = await newProduct(o);
    const cx = await asRole(orgId, "caixa");
    await cx.c.post("/pos/register/open").send({ initial: 0 }).expect(201);
    await sell(cx.c, p.id, [{ method: "dinheiro", amount: 100 }]).expect(201);
    expect((await cx.c.get("/pos/register")).body).toMatchObject({ blind: true, cash: 0, expected: 0 });
    const closed = (await cx.c.post("/pos/register/close").send({ counted: 100 }).expect(200)).body;
    expect(closed).toMatchObject({ expected: null, difference: null, blind: true });
    const s = await prisma.cashSession.findFirstOrThrow({ where: { organizationId: orgId } });
    expect((await o.get(`/pos/sessions/${s.id}`)).body).toMatchObject({ expected: 100, difference: 0 });
    await cx.c.put("/pos/settings").send({ blindClose: false }).expect(403);
  });

  it("configurações aplicadas no servidor: cliente obrigatório, forma desabilitada, estoque negativo", async () => {
    const { o } = await signup();
    const p = await newProduct(o, { stock: 0 });
    await o.post("/pos/register/open").send({ initial: 0 }).expect(201);
    expect((await sell(o, p.id, [{ method: "pix", amount: 100 }]).expect(409)).body.message).toMatch(/Estoque insuficiente/);
    await o.put("/pos/settings").send({ allowNegativeStock: true, requireCustomer: true }).expect(200);
    expect((await sell(o, p.id, [{ method: "pix", amount: 100 }]).expect(400)).body.message).toBe("Selecione o cliente para finalizar a venda.");
    const customer = (await o.post("/customers").send({ name: "Ana Cliente" }).expect(201)).body;
    await sell(o, p.id, [{ method: "pix", amount: 100 }], { customerId: customer.id }).expect(201);
    expect((await o.get(`/products/${p.id}`)).body.stock).toBe(-1);
    await o.put("/pos/payment-methods/boleto").send({ enabledInPos: false }).expect(200);
    expect((await sell(o, p.id, [{ method: "boleto", amount: 100 }], { customerId: customer.id }).expect(400)).body.message).toMatch(/não está habilitada/);
    const cfg = (await o.get("/pos/settings").expect(200)).body;
    expect(cfg.enabledMethods).not.toContain("boleto");
  });

  it("limite de desconto por função com autorização do supervisor (uso único)", async () => {
    const { o, orgId, email } = await signup();
    await o.put("/pos/settings").send({ discountLimits: { caixa: 5 } }).expect(200);
    expect((await o.put("/pos/settings").send({ discountLimits: { caixa: 150 } }).expect(400)).body.message).toMatch(/0 a 100/);
    const p = await newProduct(o, { price: 100 });
    const cx = await asRole(orgId, "caixa");
    await cx.c.post("/pos/register/open").send({ initial: 0 }).expect(201);
    await sell(cx.c, p.id, [{ method: "pix", amount: 95 }], { discount: 5 }).expect(201);
    const over = await sell(cx.c, p.id, [{ method: "pix", amount: 90 }], { discount: 10 }).expect(403);
    expect(over.body).toMatchObject({ code: "supervisor_required" });
    expect(over.body.message).toMatch(/acima do seu limite de 5,00%/);
    await cx.c.post("/pos/authorize").send({ email, password: "errada", action: "discount" }).expect(403);
    const other = await asRole(orgId, "caixa");
    await cx.c.post("/pos/authorize").send({ email: other.email, password: PASSWORD, action: "discount" }).expect(403);
    const a = (await cx.c.post("/pos/authorize").send({ email, password: PASSWORD, action: "discount" }).expect(201)).body;
    const ok = (await sell(cx.c, p.id, [{ method: "pix", amount: 90 }], { discount: 10, authorizationId: a.authorizationId }).expect(201)).body;
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: ok.id } })).approvedById).toBeTruthy();
    await sell(cx.c, p.id, [{ method: "pix", amount: 90 }], { discount: 10, authorizationId: a.authorizationId }).expect(403);
  });

  it("idempotência: repetir a mesma venda (clique duplo) não duplica nem baixa estoque duas vezes", async () => {
    const { o } = await signup();
    const p = await newProduct(o, { stock: 5 });
    await o.post("/pos/register/open").send({ initial: 0 }).expect(201);
    const requestId = `req_${uniq()}`;
    const [a, b] = await Promise.all([sell(o, p.id, [{ method: "pix", amount: 100 }], { requestId }), sell(o, p.id, [{ method: "pix", amount: 100 }], { requestId })]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect((await o.get(`/products/${p.id}`)).body.stock).toBe(4);
  });

  it("terminais cadastrados: abrir exige escolher um terminal ativo; nome duplicado é recusado", async () => {
    const { o } = await signup();
    const t = (await o.post("/pos/terminals").send({ name: "Balcão", defaultFloat: 100 }).expect(201)).body;
    await o.post("/pos/terminals").send({ name: "Balcão" }).expect(409);
    const st = (await o.get("/pos/register").expect(200)).body;
    expect(st.terminals).toEqual([expect.objectContaining({ id: t.id, name: "Balcão", defaultFloat: 100, busy: false })]);
    expect((await o.post("/pos/register/open").send({ initial: 100 }).expect(400)).body.message).toMatch(/Selecione o caixa/);
    expect((await o.post("/pos/register/open").send({ initial: 100, terminalId: t.id }).expect(201)).body).toMatchObject({ register: "Balcão", terminalId: t.id });
    expect((await o.put(`/pos/terminals/${t.id}`).send({ active: false }).expect(409)).body.message).toMatch(/Feche o caixa/);
  });

  it("devolução parcial: dinheiro sai do caixa, crédito do cliente vira forma de pagamento, não devolve além do vendido", async () => {
    const { o } = await signup();
    const p = await newProduct(o, { price: 50, stock: 10 });
    const customer = (await o.post("/customers").send({ name: "Bia" }).expect(201)).body;
    await o.post("/pos/register/open").send({ initial: 0 }).expect(201);
    const sale = (await sell(o, p.id, [{ method: "dinheiro", amount: 180 }], { qty: 4, discount: 20, customerId: customer.id }).expect(201)).body;
    const itemId = sale.items[0].id;

    const r1 = (await o.post(`/pos/sales/${sale.id}/returns`).send({ items: [{ saleItemId: itemId, qty: 1 }], reason: "Tamanho errado", refundMethod: "dinheiro" }).expect(201)).body;
    expect(r1.total).toBe(45);
    expect((await o.get("/pos/register")).body).toMatchObject({ cash: 180, refunds: 45, expected: 135 });
    expect((await o.get(`/products/${p.id}`)).body.stock).toBe(7);

    const r2 = (await o.post(`/pos/sales/${sale.id}/returns`).send({ items: [{ saleItemId: itemId, qty: 2, restock: false }], reason: "Avariado", refundMethod: "credito_cliente" }).expect(201)).body;
    expect(r2.total).toBe(90);
    expect((await o.get(`/products/${p.id}`)).body.stock).toBe(7);
    expect((await o.get(`/pos/customers/${customer.id}/credit`).expect(200)).body.balance).toBe(90);

    expect((await o.post(`/pos/sales/${sale.id}/returns`).send({ items: [{ saleItemId: itemId, qty: 2 }], reason: "mais", refundMethod: "dinheiro" }).expect(400)).body.message).toMatch(/Só restam 1/);
    expect((await o.post(`/pos/sales/${sale.id}/cancel`).send({ reason: "teste" }).expect(409)).body.message).toMatch(/devolução registrada/);
    expect((await o.get(`/pos/sales/${sale.id}/returns`).expect(200)).body).toHaveLength(2);

    await sell(o, p.id, [{ method: "credito_cliente", amount: 50 }]).expect(400);
    await sell(o, p.id, [{ method: "credito_cliente", amount: 50 }], { customerId: customer.id }).expect(201);
    expect((await o.get(`/pos/customers/${customer.id}/credit`)).body.balance).toBe(40);
    expect((await sell(o, p.id, [{ method: "credito_cliente", amount: 50 }], { customerId: customer.id }).expect(409)).body.message).toMatch(/crédito suficiente/);

    const cx = await asRole((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).organizationId, "caixa");
    await cx.c.post(`/pos/sales/${sale.id}/returns`).send({ items: [{ saleItemId: itemId, qty: 1 }], reason: "x", refundMethod: "dinheiro" }).expect(403);
  });

  it("sangria acima do limite pede supervisor; caixa esquecido aberto gera alerta uma única vez", async () => {
    const { o, orgId, email } = await signup();
    await o.put("/pos/settings").send({ withdrawalApprovalAbove: 50, maxOpenHours: 2 }).expect(200);
    const cx = await asRole(orgId, "caixa");
    await cx.c.post("/pos/register/open").send({ initial: 200 }).expect(201);
    await cx.c.post("/pos/register/withdrawal").send({ amount: 40, reason: "Lanche" }).expect(201);
    expect((await cx.c.post("/pos/register/withdrawal").send({ amount: 80, reason: "Cofre" }).expect(403)).body.code).toBe("supervisor_required");
    const a = (await cx.c.post("/pos/authorize").send({ email, password: PASSWORD, action: "withdrawal" }).expect(201)).body;
    await cx.c.post("/pos/register/withdrawal").send({ amount: 80, reason: "Cofre", authorizationId: a.authorizationId }).expect(201);

    const svc = app.get(PosService);
    const future = new Date(Date.now() + 3 * 3_600_000);
    expect(await svc.checkStale(new Date())).toBe(0);
    expect(await svc.checkStale(future)).toBeGreaterThanOrEqual(1);
    await svc.checkStale(future);
    const notes = await prisma.notification.findMany({ where: { organizationId: orgId, title: { contains: "aberto há mais de 2 h" } } });
    expect(notes).toHaveLength(1);
  });
});
