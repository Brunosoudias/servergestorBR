import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcryptjs";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/config/env";
import { configureApp } from "../src/main";
import { MailService } from "../src/mail/mail.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { currentStep, totpAt } from "../src/common/totp";
import { mailMock, randomCnpjFormatted } from "./helpers";

const PASSWORD = "Senha@1234";
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

describe("API (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const mails: { to: string; token: string }[] = [];
  const changed: string[] = [];
  const devices: string[] = [];
  const recoveryUsed: string[] = [];
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailService)
      .useValue(mailMock({
        passwordReset: async (to: string, _n: string, token: string) => { mails.push({ to, token }); },
        passwordChanged: async (to: string) => { changed.push(to); },
        invite: async (to: string, _c: string, _i: string, token: string) => { mails.push({ to, token }); },
        newDeviceLogin: async (to: string) => { devices.push(to); },
        mfaRecoveryUsed: async (to: string) => { recoveryUsed.push(to); },
      }))
      .compile();
    app = mod.createNestApplication();
    configureApp(app as never, loadEnv());
    await app.init();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => { await app.close(); });

  async function signup(tag = uniq()) {
    const agent = request.agent(server());
    const email = `${tag}@teste.com`;
    const res = await agent.post("/auth/register").send({ name: `Usuário ${tag}`, email, password: PASSWORD }).expect(201);
    return { agent, email, session: res.body, orgId: res.body.organization.id as string, res };
  }
  const withOrg = (agent: request.Agent, orgId: string) => ({
    get: (u: string) => agent.get(u).set("X-Organization-Id", orgId),
    post: (u: string) => agent.post(u).set("X-Organization-Id", orgId),
    put: (u: string) => agent.put(u).set("X-Organization-Id", orgId),
    delete: (u: string) => agent.delete(u).set("X-Organization-Id", orgId),
  });
  const product = (o: Partial<Record<string, unknown>> = {}) => ({ name: "Mouse", sku: `SKU-${uniq()}`, price: 100, cost: 40, stock: 10, minStock: 2, ...o });

  it("GET /health responde ok e não exige login", async () => {
    const res = await request(server()).get("/health").expect(200);
    expect(res.body).toMatchObject({ status: "ok", database: { latencyMs: expect.any(Number) } });
  });

  describe("autenticação", () => {
    it("cadastro cria sessão em cookie httpOnly e não vaza hash/token no corpo", async () => {
      const { res } = await signup();
      const cookie = (res.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("session="))!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(res.body.user.mustChangePassword).toBe(false);
      expect(JSON.stringify({ ...res.body, user: { ...res.body.user, mustChangePassword: undefined } })).not.toMatch(/password|hash|token/i);
      expect(res.body.user.role).toBe("owner");
      expect(res.body.permissions).toContain("sales:create");
      expect(res.body.organization.id).toBeTruthy();
    });

    it("rejeita senha fraca e e-mail inválido (400) e e-mail repetido (409)", async () => {
      await request(server()).post("/auth/register").send({ name: "Ana", email: `${uniq()}@t.com`, password: "abc" }).expect(400);
      await request(server()).post("/auth/register").send({ name: "Ana", email: "nao-e-email", password: PASSWORD }).expect(400);
      const { email } = await signup();
      await request(server()).post("/auth/register").send({ name: "Ana", email: email.toUpperCase(), password: PASSWORD }).expect(409);
    });

    it("login: mesma resposta para senha errada e e-mail inexistente; /me exige cookie", async () => {
      const { email } = await signup();
      const a = await request(server()).post("/auth/login").send({ email, password: "Errada123" }).expect(401);
      const b = await request(server()).post("/auth/login").send({ email: `naoexiste${uniq()}@t.com`, password: "Errada123" }).expect(401);
      expect(a.body.message).toBe(b.body.message);
      await request(server()).get("/auth/me").expect(401);
      const agent = request.agent(server());
      await agent.post("/auth/login").send({ email, password: PASSWORD }).expect(200);
      const me = await agent.get("/auth/me").expect(200);
      expect(me.body.user.email).toBe(email);
    });

    it("bloqueia a conta após 5 senhas erradas (429), mesmo com a senha certa", async () => {
      const { email } = await signup();
      for (let i = 0; i < 5; i++) await request(server()).post("/auth/login").send({ email, password: "Errada123" }).expect(401);
      await request(server()).post("/auth/login").send({ email, password: PASSWORD }).expect(429);
    });

    it("logout encerra a sessão no servidor (o cookie antigo deixa de valer) e funciona sem sessão", async () => {
      const { agent, res } = await signup();
      const oldCookie = (res.headers["set-cookie"] as unknown as string[])[0].split(";")[0];
      await agent.post("/auth/logout").expect(204);
      await agent.get("/auth/me").expect(401);
      const stale = await request(server()).get("/auth/me").set("Cookie", oldCookie).expect(401);
      expect((stale.headers["set-cookie"] as unknown as string[]).join(";")).toMatch(/session=;.*Expires=Thu, 01 Jan 1970/);
      await request(server()).post("/auth/logout").expect(204);
    });

    it("recuperação de senha: resposta igual para conta inexistente; token de uso único; derruba sessões", async () => {
      const { agent, email } = await signup();
      await request(server()).post("/auth/forgot-password").send({ email: `fantasma${uniq()}@t.com` }).expect(200, { ok: true });
      await request(server()).post("/auth/forgot-password").send({ email }).expect(200, { ok: true });
      const token = mails.filter((m) => m.to === email).pop()!.token;
      await request(server()).post("/auth/reset-password").send({ token, password: "fraca" }).expect(400);
      await request(server()).post("/auth/reset-password").send({ token, password: "Nova@Senha99" }).expect(200);
      expect(changed.filter((to) => to === email)).toHaveLength(1);
      await request(server()).post("/auth/reset-password").send({ token, password: "Outra@Senha99" }).expect(400);
      await agent.get("/auth/me").expect(401);
      await request(server()).post("/auth/login").send({ email, password: "Nova@Senha99" }).expect(200);
    });

    const wrongCode = (c: string) => c.slice(0, 5) + String((Number(c[5]) + 1) % 10);
    async function enableMfa(agent: request.Agent) {
      const setup = (await agent.post("/auth/mfa/setup").expect(200)).body as { secret: string; otpauthUrl: string };
      const s0 = currentStep();
      await agent.post("/auth/mfa/enable").send({ code: wrongCode(totpAt(setup.secret, s0)) }).expect(400);
      const enabled = await agent.post("/auth/mfa/enable").send({ code: totpAt(setup.secret, s0) }).expect(200);
      return { ...setup, s0, recoveryCodes: enabled.body.recoveryCodes as string[] };
    }

    it("2FA: códigos de recuperação entram uma única vez, avisam por e-mail e podem ser regenerados", async () => {
      const { agent, email } = await signup();
      const { secret, s0, recoveryCodes } = await enableMfa(agent);
      expect(recoveryCodes).toHaveLength(10);
      expect(new Set(recoveryCodes).size).toBe(10);
      expect((await prisma.user.findUniqueOrThrow({ where: { email } })).mfaRecoveryCodes).not.toContain(recoveryCodes[0]);

      const loginWith = async (code: string) => {
        const { body } = await request(server()).post("/auth/login").send({ email, password: PASSWORD }).expect(200);
        return request(server()).post("/auth/mfa/verify").send({ challenge: body.challenge, code });
      };
      await loginWith(recoveryCodes[0].toUpperCase()).then((r) => expect(r.status).toBe(200));
      expect(recoveryUsed.filter((to) => to === email)).toHaveLength(1);
      await loginWith(recoveryCodes[0]).then((r) => expect(r.status).toBe(401));
      expect((await agent.get("/auth/mfa").expect(200)).body.recoveryCodesLeft).toBe(9);

      await agent.post("/auth/mfa/recovery-codes").send({ code: wrongCode(totpAt(secret, s0 + 1)) }).expect(400);
      const regen = await agent.post("/auth/mfa/recovery-codes").send({ code: totpAt(secret, s0 + 1) }).expect(200);
      expect(regen.body.recoveryCodes).toHaveLength(10);
      await loginWith(recoveryCodes[1]).then((r) => expect(r.status).toBe(401));
      await prisma.user.update({ where: { email }, data: { failedAttempts: 0 } });

      // Celular perdido: desativa com senha + código de recuperação.
      await agent.post("/auth/mfa/disable").send({ password: PASSWORD, code: regen.body.recoveryCodes[0] }).expect(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { email } })).mfaRecoveryCodes).toEqual([]);
    });

    it("avisa por e-mail quando a conta entra por um dispositivo novo (atualizar o navegador não conta)", async () => {
      const { email } = await signup();
      const login = (ua: string) => request(server()).post("/auth/login").set("User-Agent", ua).send({ email, password: PASSWORD }).expect(200);
      const sent = () => devices.filter((to) => to === email).length;
      await login("Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.1.2");
      expect(sent()).toBe(1);
      await login("Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.3.4");
      expect(sent()).toBe(1);
      await login("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/605.1");
      expect(sent()).toBe(2);
    });

    it("2FA: login passa a exigir o código do app, recusa código reutilizado e desativa só com senha + código", async () => {
      const { agent, email } = await signup();
      expect((await agent.get("/auth/mfa").expect(200)).body).toEqual({ enabled: false, required: false, recoveryCodesLeft: 0 });
      await agent.post("/auth/mfa/enable").send({ code: "123456" }).expect(400);
      const { secret, otpauthUrl, s0 } = await enableMfa(agent);
      expect(otpauthUrl).toContain(`secret=${secret}`);
      expect((await agent.get("/auth/me").expect(200)).body.user.mfaEnabled).toBe(true);

      const fresh = request.agent(server());
      const step1 = await fresh.post("/auth/login").send({ email, password: PASSWORD }).expect(200);
      expect(step1.body).toEqual({ mfaRequired: true, challenge: expect.any(String) });
      expect(step1.headers["set-cookie"]).toBeUndefined();
      await fresh.get("/auth/me").expect(401);
      const verify = (code: string) => fresh.post("/auth/mfa/verify").send({ challenge: step1.body.challenge, code });
      await verify(totpAt(secret, s0)).expect(401);
      await verify(totpAt(secret, s0 + 1)).expect(200);
      await fresh.get("/auth/me").expect(200);
      await verify(totpAt(secret, s0 + 1)).expect(401);

      await prisma.user.update({ where: { email }, data: { mfaLastStep: 0 } });
      await fresh.post("/auth/mfa/disable").send({ password: "Errada123", code: totpAt(secret, s0) }).expect(400);
      await fresh.post("/auth/mfa/disable").send({ password: PASSWORD, code: totpAt(secret, s0) }).expect(200);
      await request(server()).post("/auth/login").send({ email, password: PASSWORD }).expect(200);
    });

    it("2FA: 5 códigos errados bloqueiam a conta, e acertar a senha de novo não zera o contador", async () => {
      const { agent, email } = await signup();
      const { secret, s0 } = await enableMfa(agent);
      for (let i = 0; i < 5; i++) {
        const { body } = await request(server()).post("/auth/login").send({ email, password: PASSWORD }).expect(200);
        await request(server()).post("/auth/mfa/verify").send({ challenge: body.challenge, code: wrongCode(totpAt(secret, s0 + 1)) }).expect(401);
      }
      await request(server()).post("/auth/login").send({ email, password: PASSWORD }).expect(429);
    });

    it("bloqueia requisições que alteram dados vindas de origem não permitida (CSRF)", async () => {
      await request(server()).post("/auth/login").set("Origin", "https://evil.example").send({ email: "a@b.com", password: "x" }).expect(403);
      await request(server()).post("/auth/login").set("Origin", "http://localhost:3000").send({ email: "a@b.com", password: "x" }).expect(401);
    });
  });

  describe("empresa", () => {
    it("onboarding completa a empresa provisória (não cria outra) e valida CNPJ", async () => {
      const { agent, orgId } = await signup();
      const CNPJ = randomCnpjFormatted();
      const body = { name: "Minha Loja", cnpj: CNPJ, email: "loja@teste.com", phone: "(11) 3000-1000", city: "São Paulo", state: "sp" };
      await agent.post("/company").send({ ...body, cnpj: "11.222.333/0001-82" }).expect(400);
      const ok = await agent.post("/company").send(body).expect(201);
      expect(ok.body.id).toBe(orgId);
      expect(ok.body.cnpj).toBe(CNPJ);
      expect(ok.body.state).toBe("SP");
      const me = await agent.get("/auth/me").expect(200);
      expect(me.body.organizations).toHaveLength(1);
      const audit = await agent.get("/company/audit").expect(200);
      expect(audit.body.length).toBeGreaterThan(0);
    });

    it("depois do onboarding não abre outra empresa (sem novo período de teste) e o CNPJ é único", async () => {
      const a = await signup();
      const CNPJ = randomCnpjFormatted();
      const body = { name: "Loja A", cnpj: CNPJ, email: "a@teste.com", phone: "11999999999", city: "São Paulo", state: "SP" };
      await a.agent.post("/company").send(body).expect(201);
      await a.agent.post("/company").send({ ...body, cnpj: randomCnpjFormatted() }).expect(403);
      expect((await a.agent.get("/auth/me").expect(200)).body.organizations).toHaveLength(1);

      const b = await signup();
      await b.agent.post("/company").send({ ...body, name: "Loja B" }).expect(409);
      await b.agent.post("/company").send({ ...body, name: "Loja B", cnpj: randomCnpjFormatted() }).expect(201);
      await withOrg(b.agent, b.orgId).put("/company").send({ ...body, name: "Loja B" }).expect(409);
    });

    it("CNPJ é único também no banco: requisições simultâneas não duplicam", async () => {
      const [a, b] = await Promise.all([signup(), signup()]);
      const body = { name: "Loja", cnpj: randomCnpjFormatted(), email: "x@teste.com", phone: "11999999999", city: "São Paulo", state: "SP" };
      const statuses = (await Promise.all([a.agent.post("/company").send(body), b.agent.post("/company").send(body)])).map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409]);
      expect(await prisma.organization.count({ where: { cnpj: body.cnpj } })).toBe(1);
    });

    it("usuário de empresa suspensa não contorna a suspensão criando outra empresa", async () => {
      const a = await signup();
      await a.agent.post("/company").send({ name: "Loja", cnpj: randomCnpjFormatted(), email: "a@teste.com", phone: "11999999999", city: "São Paulo", state: "SP" }).expect(201);
      await prisma.organization.update({ where: { id: a.orgId }, data: { suspendedAt: new Date() } });
      await a.agent.post("/company").send({ name: "Outra", cnpj: randomCnpjFormatted(), email: "b@teste.com", phone: "11999999999", city: "São Paulo", state: "SP" }).expect(403);
      expect(await prisma.membership.count({ where: { user: { email: a.email } } })).toBe(1);
    });
  });

  describe("usuários e permissões", () => {
    it("convite cria vínculo 'convidado', aceite ativa e o papel limita o que o usuário faz", async () => {
      const owner = await signup();
      const o = withOrg(owner.agent, owner.orgId);
      const guest = `guest${uniq()}@teste.com`;
      await o.post("/users/invite").send({ email: guest, role: "owner" }).expect(400);
      const inv = await o.post("/users/invite").send({ email: guest, role: "visualizador" }).expect(201);
      expect(inv.body.status).toBe("convidado");
      await o.post("/users/invite").send({ email: guest, role: "vendedor" }).expect(409);

      const token = mails.filter((m) => m.to === guest).pop()!.token;
      await request(server()).post("/auth/login").send({ email: guest, password: PASSWORD }).expect(401);
      await request(server()).post("/auth/reset-password").send({ token, password: PASSWORD }).expect(200);

      const viewer = request.agent(server());
      await viewer.post("/auth/login").send({ email: guest, password: PASSWORD }).expect(200);
      const v = withOrg(viewer, owner.orgId);
      await v.get("/products").expect(200);
      await v.post("/products").send(product()).expect(403);
      await v.post("/users/invite").send({ email: `x${uniq()}@t.com`, role: "caixa" }).expect(403);

      const list = await o.get("/users").expect(200);
      expect(list.body.data.map((u: { email: string }) => u.email)).toContain(guest);
      const id = list.body.data.find((u: { email: string }) => u.email === guest).id;
      await o.put(`/users/${id}`).send({}).expect(404);
      await owner.agent.patch(`/users/${id}`).set("X-Organization-Id", owner.orgId).send({ status: "inativo" }).expect(200);
      await viewer.get("/auth/me").expect(401);
    });

    it("convidar a conta de outra empresa não permite trocar a senha/nome dela nem derrubar suas sessões (tomada de conta)", async () => {
      const victim = await signup();
      const attacker = await signup();
      const a = withOrg(attacker.agent, attacker.orgId);
      const inv = await a.post("/users/invite").send({ email: victim.email, role: "vendedor" }).expect(201);
      const patch = (body: object) => attacker.agent.patch(`/users/${inv.body.id}`).set("X-Organization-Id", attacker.orgId).send(body);
      await patch({ password: "Invadido@123" }).expect(403);
      await patch({ name: "Hacker" }).expect(403);
      await patch({ status: "inativo" }).expect(200);
      await victim.agent.get("/auth/me").expect(200);
      await request(server()).post("/auth/login").send({ email: victim.email, password: "Invadido@123" }).expect(401);
      await request(server()).post("/auth/login").send({ email: victim.email, password: PASSWORD }).expect(200);

      const rootEmail = `root${uniq()}@teste.com`;
      await prisma.user.create({ data: { name: "Root", email: rootEmail, passwordHash: await bcrypt.hash(PASSWORD, 4), isSuperAdmin: true } });
      await a.post("/users/invite").send({ email: rootEmail, role: "vendedor" }).expect(400);
    });

    it("a empresa dona exclusiva da conta continua podendo redefinir a senha do próprio funcionário", async () => {
      const owner = await signup();
      const email = `func${uniq()}@teste.com`;
      const created = await withOrg(owner.agent, owner.orgId).post("/users").send({ name: "Funcionário", email, password: PASSWORD, role: "caixa" }).expect(201);
      await owner.agent.patch(`/users/${created.body.id}`).set("X-Organization-Id", owner.orgId).send({ password: "Nova@Senha99" }).expect(200);
      await request(server()).post("/auth/login").send({ email, password: "Nova@Senha99" }).expect(200);
    });
  });

  describe("produtos", () => {
    it("CRUD, SKU único, busca e exclusão lógica", async () => {
      const { agent, orgId } = await signup();
      const o = withOrg(agent, orgId);
      const p = product({ name: "Teclado Gamer", barcode: "7890001" });
      const created = await o.post("/products").send(p).expect(201);
      expect(created.body).toMatchObject({ name: "Teclado Gamer", price: 100, stock: 10 });
      await o.post("/products").send(p).expect(409);
      await o.post("/products").send({ ...p, sku: `X${uniq()}`, price: -1 }).expect(400);
      await o.post("/products").send({ ...p, sku: `X${uniq()}`, hack: true }).expect(400);
      const found = await o.get("/products/search?q=gamer").expect(200);
      expect(found.body).toHaveLength(1);
      const upd = await o.put(`/products/${created.body.id}`).send({ price: 150.5, stock: 25 }).expect(200);
      expect(upd.body).toMatchObject({ price: 150.5, stock: 25 });
      const list = await o.get("/products?page=1&pageSize=5").expect(200);
      expect(list.body).toMatchObject({ total: 1, page: 1, pageSize: 5 });
      await o.delete(`/products/${created.body.id}`).expect(204);
      await o.get(`/products/${created.body.id}`).expect(404);
      await o.post("/products").send(p).expect(201);
    });

    it("isolamento entre empresas: B não enxerga nem altera dados de A", async () => {
      const a = await signup(); const b = await signup();
      const created = await withOrg(a.agent, a.orgId).post("/products").send(product()).expect(201);
      const ob = withOrg(b.agent, b.orgId);
      const list = await ob.get("/products").expect(200);
      expect(list.body.total).toBe(0);
      await ob.get(`/products/${created.body.id}`).expect(404);
      await ob.put(`/products/${created.body.id}`).send({ price: 1 }).expect(404);
      await ob.delete(`/products/${created.body.id}`).expect(404);
      await b.agent.get("/products").set("X-Organization-Id", a.orgId).expect(403);
      await ob.post("/sales").send({ product: created.body.id, qty: 1, payment: "pix" }).expect(400);
    });
  });

  describe("vendas", () => {
    it("cria venda numerada, baixa estoque, cancela devolvendo e não cancela duas vezes", async () => {
      const { agent, orgId } = await signup();
      const o = withOrg(agent, orgId);
      const p = (await o.post("/products").send(product({ price: 100, stock: 10 })).expect(201)).body;

      const s1 = (await o.post("/sales").send({ product: p.id, qty: 3, price: 100, discount: 10, shipping: 5, payment: "pix" }).expect(201)).body;
      expect(s1).toMatchObject({ number: "000001", status: "pendente", origin: "manual", customer: "Consumidor" });
      expect(s1.total).toBe(295);
      expect((await o.get(`/products/${p.id}`)).body.stock).toBe(7);

      const s2 = (await o.post("/sales").send({ items: [{ productId: p.id, qty: 2 }], payment: "dinheiro" }).expect(201)).body;
      expect(s2.number).toBe("000002");
      expect(s2.total).toBe(200);

      const cancelled = (await o.post(`/sales/${s1.id}/cancel`).expect(201)).body;
      expect(cancelled.status).toBe("cancelada");
      expect((await o.get(`/products/${p.id}`)).body.stock).toBe(8);
      await o.post(`/sales/${s1.id}/cancel`).expect(409);
      expect((await o.get(`/products/${p.id}`)).body.stock).toBe(8);

      const done = (await o.post(`/sales/${s2.id}/complete`).expect(201)).body;
      expect(done.status).toBe("concluida");
      const sum = (await o.get("/sales/summary").expect(200)).body;
      expect(sum).toMatchObject({ total: 200, orders: 2, average: 200 });
      const mov = await prisma.stockMovement.findMany({ where: { organizationId: orgId } });
      expect(mov.map((m) => m.type).sort()).toEqual(["entrada", "entrada", "saida", "saida"]);
    });

    it("estoque insuficiente: 409 e nada é alterado (transação inteira desfeita)", async () => {
      const { agent, orgId } = await signup();
      const o = withOrg(agent, orgId);
      const a = (await o.post("/products").send(product({ stock: 5 })).expect(201)).body;
      const b = (await o.post("/products").send(product({ stock: 1 })).expect(201)).body;
      const res = await o.post("/sales").send({ items: [{ productId: a.id, qty: 2 }, { productId: b.id, qty: 2 }], payment: "pix" }).expect(409);
      expect(res.body.message).toMatch(/Estoque insuficiente/);
      expect((await o.get(`/products/${a.id}`)).body.stock).toBe(5);
      expect((await o.get("/sales")).body.total).toBe(0);
    });

    it("vendas simultâneas do último item: só uma passa (sem estoque negativo)", async () => {
      const { agent, orgId } = await signup();
      const o = withOrg(agent, orgId);
      const p = (await o.post("/products").send(product({ stock: 1 })).expect(201)).body;
      const results = await Promise.all(Array.from({ length: 6 }, () => o.post("/sales").send({ product: p.id, qty: 1, payment: "pix" })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      expect((await o.get(`/products/${p.id}`)).body.stock).toBe(0);
      const numbers = (await o.get("/sales")).body.data.map((s: { number: string }) => s.number);
      expect(numbers).toEqual(["000001"]);
    });

    it("valida entradas: quantidade, desconto, cliente de outra empresa", async () => {
      const a = await signup(); const b = await signup();
      const oa = withOrg(a.agent, a.orgId); const ob = withOrg(b.agent, b.orgId);
      const p = (await oa.post("/products").send(product()).expect(201)).body;
      await oa.post("/sales").send({ product: p.id, qty: 0, payment: "pix" }).expect(400);
      await oa.post("/sales").send({ product: p.id, qty: 1, discount: 999, payment: "pix" }).expect(400);
      await oa.post("/sales").send({ product: p.id, qty: 1, payment: "cheque" }).expect(400);
      const custB = (await ob.post("/customers").send({ name: "Cliente da B" }).expect(201)).body;
      await oa.post("/sales").send({ product: p.id, qty: 1, customer: custB.id, payment: "pix" }).expect(400);
      const custA = (await oa.post("/customers").send({ name: "Cliente da A", email: "" }).expect(201)).body;
      const s = (await oa.post("/sales").send({ product: p.id, qty: 2, customer: custA.id, payment: "pix" }).expect(201)).body;
      await oa.post(`/sales/${s.id}/complete`).expect(201);
      const c = (await oa.get(`/customers/${custA.id}`).expect(200)).body;
      expect(c).toMatchObject({ totalSpent: 200, purchases: 1, open: 0 });
      expect((await oa.get(`/customers/${custA.id}/purchases`).expect(200)).body).toHaveLength(1);
      await ob.get(`/sales/${s.id}`).expect(404);
    });

    it("caixa não cancela venda; vendedor cria mas não exclui produto", async () => {
      const owner = await signup();
      const o = withOrg(owner.agent, owner.orgId);
      const p = (await o.post("/products").send(product()).expect(201)).body;
      const sale = (await o.post("/sales").send({ product: p.id, qty: 1, payment: "pix" }).expect(201)).body;
      const email = `vend${uniq()}@teste.com`;
      const user = await prisma.user.create({ data: { name: "Vendedor", email, passwordHash: await bcrypt.hash(PASSWORD, 4) } });
      await prisma.membership.create({ data: { userId: user.id, organizationId: owner.orgId, role: "vendedor", status: "ativo" } });
      const v = request.agent(server());
      await v.post("/auth/login").send({ email, password: PASSWORD }).expect(200);
      const vo = withOrg(v, owner.orgId);
      await vo.post("/sales").send({ product: p.id, qty: 1, payment: "pix" }).expect(201);
      await vo.post(`/sales/${sale.id}/cancel`).expect(403);
      await vo.delete(`/products/${p.id}`).expect(403);
    });
  });

  describe("mensagens de validação claras", () => {
    it("explica o problema em português, com o nome do campo como o usuário o conhece", async () => {
      const { agent, orgId } = await signup();
      const o = withOrg(agent, orgId);
      const msg = async (body: Record<string, unknown>) => (await o.post("/products").send(product(body)).expect(400)).body;
      expect((await msg({ name: "x".repeat(200) })).message).toBe("O nome é longo demais (máximo de 160 caracteres).");
      expect((await msg({ price: "abc" })).message).toBe("O preço de venda deve ser um número.");
      expect((await msg({ stock: -1 })).message).toBe("O estoque deve ser no mínimo 0.");
      expect((await msg({ price: -5 })).message).toBe("O preço de venda deve ser no mínimo 0.");
      const img = await msg({ image: "data:image/png;base64," + "A".repeat(600) });
      expect(img.message).toBe("A imagem enviada não é válida. Envie o arquivo novamente.");
      expect(JSON.stringify(img)).not.toMatch(/must be|should not|shorter than/);
      const extra = await msg({ hack: true });
      expect(extra.message).toBe('O campo "hack" não é permitido.');
    });

    it("JSON grande demais devolve 413 em português (não HTML nem inglês)", async () => {
      const { agent, orgId } = await signup();
      const res = await withOrg(agent, orgId).post("/products").send({ ...product(), image: "x".repeat(200_000) }).expect(413);
      expect(res.body.message).toMatch(/grande demais/);
    });
  });

  describe("envio de imagem de produto", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

    it("aceita PNG, devolve link público que carrega de outra origem e serve para o cadastro", async () => {
      const { agent, orgId } = await signup();
      const o = withOrg(agent, orgId);
      const up = await o.post("/uploads/image").attach("file", png, { filename: "foto.png", contentType: "image/png" }).expect(201);
      expect(up.body.url).toMatch(new RegExp(`/uploads/${orgId}/[a-f0-9]{32}\\.png$`));
      const path = new URL(up.body.url).pathname;
      const file = await request(server()).get(path).expect(200);
      expect(file.headers["content-type"]).toBe("image/png");
      expect(file.headers["cross-origin-resource-policy"]).toBe("cross-origin");
      expect(file.headers["x-content-type-options"]).toBe("nosniff");
      await request(server()).get(`/uploads/${orgId}/`).expect(404);
      const prod = await o.post("/products").send(product({ image: up.body.url })).expect(201);
      expect(prod.body.image).toBe(up.body.url);
    });

    it("recusa o que não é imagem, mesmo com tipo falsificado, e explica em português", async () => {
      const { agent, orgId } = await signup();
      const o = withOrg(agent, orgId);
      const fake = await o.post("/uploads/image").attach("file", Buffer.from("<script>alert(1)</script>"), { filename: "x.png", contentType: "image/png" }).expect(400);
      expect(fake.body.message).toBe("Formato de imagem não aceito. Envie um arquivo PNG, JPG ou WebP.");
      const none = await o.post("/uploads/image").expect(400);
      expect(none.body.message).toBe("Selecione uma imagem para enviar.");
    });

    it("recusa arquivo acima de 2 MB com mensagem clara (413)", async () => {
      const { agent, orgId } = await signup();
      const big = Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]);
      const res = await withOrg(agent, orgId).post("/uploads/image").attach("file", big, { filename: "grande.png", contentType: "image/png" }).expect(413);
      expect(res.body.message).toMatch(/2 MB/);
    });

    it("exige login e permissão de edição de produtos", async () => {
      await request(server()).post("/uploads/image").attach("file", png, { filename: "a.png", contentType: "image/png" }).expect(401);
      const owner = await signup();
      const email = `cx${uniq()}@teste.com`;
      const user = await prisma.user.create({ data: { name: "Caixa", email, passwordHash: await bcrypt.hash(PASSWORD, 4) } });
      await prisma.membership.create({ data: { userId: user.id, organizationId: owner.orgId, role: "caixa", status: "ativo" } });
      const cx = request.agent(server());
      await cx.post("/auth/login").send({ email, password: PASSWORD }).expect(200);
      await withOrg(cx, owner.orgId).post("/uploads/image").attach("file", png, { filename: "a.png", contentType: "image/png" }).expect(403);
    });
  });

  describe("rotas inexistentes", () => {
    it("rota inexistente responde 404 com mensagem clara e code 'unavailable' (não 'Cannot GET')", async () => {
      const { agent, orgId } = await signup();
      const res = await withOrg(agent, orgId).get("/rota-que-nao-existe").expect(404);
      expect(res.body).toMatchObject({ statusCode: 404, code: "unavailable", message: "Este recurso ainda não está disponível nesta versão." });
      const rec = await withOrg(agent, orgId).get("/products/nao-existe").expect(404);
      expect(rec.body.code).toBeUndefined();
      expect(rec.body.message).toBe("Registro não encontrado.");
    });
  });
});
