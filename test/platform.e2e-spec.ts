import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as bcrypt from "bcryptjs";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { loadEnv } from "../src/config/env";
import { configureApp } from "../src/main";
import { MailService } from "../src/mail/mail.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { encryptSecret } from "../src/common/secret";
import { currentStep, generateTotpSecret, totpAt } from "../src/common/totp";
import { mailMock, randomCnpj } from "./helpers";

const PASSWORD = "Senha@1234";
const NEW_PASSWORD = "Nova#Senha99";
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

describe("Plataforma: empresas do superadmin (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailService).useValue(mailMock())
      .compile();
    app = mod.createNestApplication();
    configureApp(app as never, loadEnv());
    await app.init();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => { await app.close(); });

  const login = async (email: string, password = PASSWORD) => {
    const agent = request.agent(server());
    const res = await agent.post("/auth/login").send({ email, password });
    return { agent, res };
  };
  /** Primeiro acesso de quem recebeu a senha do superadmin: troca a senha provisória. */
  const firstLogin = async (email: string) => {
    const r = await login(email);
    await r.agent.post("/auth/change-password").send({ currentPassword: PASSWORD, password: NEW_PASSWORD }).expect(200);
    return r;
  };
  const superAdmin = async () => {
    const email = `root${uniq()}@teste.com`;
    const secret = generateTotpSecret();
    await prisma.user.create({ data: { name: "Root", email, passwordHash: await bcrypt.hash(PASSWORD, 4), isSuperAdmin: true, mfaSecretEnc: encryptSecret(secret, loadEnv().secretsKey), mfaEnabledAt: new Date() } });
    const { agent, res } = await login(email);
    expect(res.body.mfaRequired).toBe(true);
    await agent.post("/auth/mfa/verify").send({ challenge: res.body.challenge, code: totpAt(secret, currentStep()) }).expect(200);
    return agent;
  };

  it("sem verificação em duas etapas o superadmin não gerencia empresas nem entra nas empresas dos outros", async () => {
    const root = await superAdmin();
    const company = (await root.post("/platform/companies").send(companyBody()).expect(201)).body;

    const email = `root${uniq()}@teste.com`;
    await prisma.user.create({ data: { name: "Root sem 2FA", email, passwordHash: await bcrypt.hash(PASSWORD, 4), isSuperAdmin: true } });
    const own = (await root.post("/platform/companies").send(companyBody({ adminEmail: `dono${uniq()}@teste.com` })).expect(201)).body;
    const ownerId = (await prisma.user.findUniqueOrThrow({ where: { email } })).id;
    await prisma.membership.create({ data: { userId: ownerId, organizationId: own.id, role: "owner" } });

    const { agent, res } = await login(email);
    expect(res.status).toBe(200);
    expect(res.body.organizations.map((o: { id: string }) => o.id)).toEqual([own.id]);
    const denied = await agent.get("/platform/companies").expect(403);
    expect(denied.body.code).toBe("mfa_required");
    await agent.get("/products").set("X-Organization-Id", company.id).expect(403);
  });
  const companyBody = (over: Record<string, unknown> = {}) => ({
    name: `Empresa ${uniq()}`, cnpj: randomCnpj(), email: `contato${uniq()}@teste.com`, phone: "11999999999", city: "São Paulo", state: "sp",
    plan: "starter", subscriptionStatus: "active", adminName: "Ana Admin", adminEmail: `admin${uniq()}@teste.com`, adminPassword: PASSWORD, ...over,
  });

  it("só o superadmin acessa a gestão de empresas", async () => {
    const agent = request.agent(server());
    const tag = uniq();
    await agent.post("/auth/register").send({ name: `Dono ${tag}`, email: `${tag}@teste.com`, password: PASSWORD }).expect(201);
    await agent.get("/platform/companies").expect(403);
    await agent.post("/platform/companies").send(companyBody()).expect(403);
  });

  it("superadmin cadastra a empresa; o admin só enxerga a própria empresa", async () => {
    const root = await superAdmin();
    const body = companyBody();
    const created = (await root.post("/platform/companies").send(body).expect(201)).body;
    expect(created).toMatchObject({ name: body.name, plan: "starter", status: "active", suspended: false, users: 1, userLimit: 2, admin: { email: body.adminEmail } });
    await root.post("/platform/companies").send(companyBody({ cnpj: body.cnpj })).expect(409);
    await root.post("/platform/companies").send(companyBody({ adminEmail: body.adminEmail })).expect(409);
    await root.post("/platform/companies").send(companyBody({ adminPassword: undefined })).expect(400);

    const other = (await root.post("/platform/companies").send(companyBody()).expect(201)).body;

    const { agent: admin, res } = await firstLogin(body.adminEmail);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ role: "admin", isSuperAdmin: false });
    expect(res.body.organizations.map((o: { id: string }) => o.id)).toEqual([created.id]);

    const product = (await admin.post("/products").set("X-Organization-Id", created.id).send({ name: "Mouse", sku: `SKU-${uniq()}`, price: 100, cost: 40, stock: 5, minStock: 1 }).expect(201)).body;
    await admin.get("/products").set("X-Organization-Id", other.id).expect(403);

    const rootView = (await root.get(`/products?search=${product.sku}`).set("X-Organization-Id", created.id).expect(200)).body;
    expect(rootView.data.map((p: { id: string }) => p.id)).toContain(product.id);
    const otherView = (await root.get(`/products?search=${product.sku}`).set("X-Organization-Id", other.id).expect(200)).body;
    expect(otherView.data).toHaveLength(0);
  });

  it("só o superadmin cria usuários e define senhas, até o limite do plano", async () => {
    const root = await superAdmin();
    const body = companyBody();
    const company = (await root.post("/platform/companies").send(body).expect(201)).body;
    const { agent: admin } = await firstLogin(body.adminEmail);
    const asAdmin = (u: string) => admin.post(u).set("X-Organization-Id", company.id);
    const asRoot = (u: string) => root.post(u).set("X-Organization-Id", company.id);

    await asAdmin("/users").send({ name: "Carlos Caixa", email: `caixa${uniq()}@teste.com`, password: PASSWORD, role: "caixa" }).expect(403);
    await asRoot("/users").send({ name: "Carlos Caixa", email: `caixa${uniq()}@teste.com`, password: "Senha1234", role: "caixa" }).expect(400);
    const caixa = (await asRoot("/users").send({ name: "Carlos Caixa", email: `caixa${uniq()}@teste.com`, password: PASSWORD, role: "caixa" }).expect(201)).body;
    const full = await asRoot("/users").send({ name: "Vera Vendas", email: `vend${uniq()}@teste.com`, password: PASSWORD, role: "vendedor" }).expect(400);
    expect(full.body.message).toMatch(/até 2 usuários/);

    await admin.patch(`/users/${caixa.id}`).set("X-Organization-Id", company.id).send({ password: "Outra@Senha1" }).expect(403);
    await admin.patch(`/users/${caixa.id}`).set("X-Organization-Id", company.id).send({ name: "Carlos C." }).expect(200);

    await root.patch(`/platform/companies/${company.id}`).send({ plan: "professional" }).expect(200);
    await asRoot("/users").send({ name: "Vera Vendas", email: `vend${uniq()}@teste.com`, password: PASSWORD, role: "vendedor" }).expect(201);
  });

  it("primeiro acesso: a senha do superadmin só libera a troca de senha, com as regras mínimas", async () => {
    const root = await superAdmin();
    const body = companyBody();
    const company = (await root.post("/platform/companies").send(body).expect(201)).body;
    const { agent, res } = await login(body.adminEmail);
    expect(res.body.user.mustChangePassword).toBe(true);
    expect((await agent.get("/auth/me").expect(200)).body.user.mustChangePassword).toBe(true);
    const blocked = await agent.get("/products").set("X-Organization-Id", company.id).expect(403);
    expect(blocked.body.code).toBe("password_change_required");

    const change = (currentPassword: string, password: string) => agent.post("/auth/change-password").send({ currentPassword, password });
    for (const weak of ["Ab1!", "senha@1234", "SENHA@1234", "Senha@abcd", "Senha12345"]) await change(PASSWORD, weak).expect(400);
    await change("Errada@123", NEW_PASSWORD).expect(400);
    await change(PASSWORD, PASSWORD).expect(400);
    const done = await change(PASSWORD, NEW_PASSWORD).expect(200);
    expect(done.body.user.mustChangePassword).toBe(false);
    await agent.get("/products").set("X-Organization-Id", company.id).expect(200);
    expect((await login(body.adminEmail)).res.status).toBe(401);
    expect((await login(body.adminEmail, NEW_PASSWORD)).res.status).toBe(200);

    const members = (await root.get("/users").set("X-Organization-Id", company.id).expect(200)).body.data as { id: string; email: string }[];
    const adminId = members.find((m) => m.email === body.adminEmail)!.id;
    await root.patch(`/users/${adminId}`).set("X-Organization-Id", company.id).send({ password: PASSWORD }).expect(200);
    await agent.get("/auth/me").expect(401);
    const again = await login(body.adminEmail);
    expect(again.res.body.user.mustChangePassword).toBe(true);
  });

  it("empresa suspensa bloqueia os usuários, mas o superadmin continua acessando", async () => {
    const root = await superAdmin();
    const body = companyBody({ subscriptionStatus: "trial" });
    const company = (await root.post("/platform/companies").send(body).expect(201)).body;
    expect(company.status).toBe("trial");
    const { agent: admin } = await firstLogin(body.adminEmail);
    await admin.get("/auth/me").expect(200);

    const suspended = (await root.patch(`/platform/companies/${company.id}`).send({ suspended: true }).expect(200)).body;
    expect(suspended.suspended).toBe(true);
    await admin.get("/auth/me").expect(403);
    expect((await login(body.adminEmail, NEW_PASSWORD)).res.status).toBe(403);
    await root.get("/products").set("X-Organization-Id", company.id).expect(200);

    const listed = (await root.get("/platform/companies?status=suspensa&pageSize=100").expect(200)).body;
    expect(listed.data.map((c: { id: string }) => c.id)).toContain(company.id);

    await root.patch(`/platform/companies/${company.id}`).send({ suspended: false }).expect(200);
    expect((await login(body.adminEmail, NEW_PASSWORD)).res.status).toBe(200);
  });
});
