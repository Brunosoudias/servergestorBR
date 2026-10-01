import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { acquireLease } from "../src/common/jobs";
import { RedisThrottlerStorage } from "../src/common/redis-throttler.storage";
import { loadEnv } from "../src/config/env";
import { FiscalService } from "../src/fiscal/fiscal.service";
import { MailService } from "../src/mail/mail.service";
import { configureApp } from "../src/main";
import { PrismaService } from "../src/prisma/prisma.service";
import { StorageService } from "../src/uploads/storage.service";
import { mailMock } from "./helpers";

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

describe("Infraestrutura (várias instâncias)", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MailService).useValue(mailMock()).compile();
    app = mod.createNestApplication();
    configureApp(app as never, loadEnv());
    await app.init();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => { await app.close(); });

  it("concessão de job: só uma instância assume por vez, e de novo depois que vence", async () => {
    const name = `test.${uniq()}`;
    const results = await Promise.all(Array.from({ length: 5 }, () => acquireLease(prisma, name, 30_000)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await acquireLease(prisma, name, 30_000)).toBe(false);
    await prisma.jobLease.update({ where: { name }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect(await acquireLease(prisma, name, 30_000)).toBe(true);
  });

  it("health: liveness sem banco, readiness com banco, e todo retorno leva X-Request-Id", async () => {
    const live = await request(app.getHttpServer()).get("/health/live").expect(200);
    expect(live.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    await request(app.getHttpServer()).get("/health").set("X-Request-Id", "lb-req-12345").expect(200).expect("X-Request-Id", "lb-req-12345");
  });

  it("notas pendentes ficam no banco e são autorizadas por qualquer instância (sobrevive a restart)", async () => {
    const reg = await request(app.getHttpServer()).post("/auth/register").send({ name: "Fiscal Teste", email: `${uniq()}@teste.com`, password: "Senha@1234" }).expect(201);
    const orgId = reg.body.organization.id as string;
    const sale = await prisma.sale.create({ data: { organizationId: orgId, number: 1, status: "concluida", total: 10, subtotal: 10 } });
    const note = await prisma.fiscalNote.create({ data: { organizationId: orgId, saleId: sale.id, type: "nfce", number: 1, series: "1", total: 10, key: uniq(), issuedAt: new Date(Date.now() - 60_000) } });
    await app.get(FiscalService).authorizePending();
    expect((await prisma.fiscalNote.findUniqueOrThrow({ where: { id: note.id } })).status).toBe("autorizada");
  });

  it("cota de armazenamento do plano é aplicada e o uso fica no banco", async () => {
    const reg = await request(app.getHttpServer()).post("/auth/register").send({ name: "Cota Teste", email: `${uniq()}@teste.com`, password: "Senha@1234" }).expect(201);
    const orgId = reg.body.organization.id as string;
    const storage = app.get(StorageService);
    await storage.put(orgId, `${uniq()}.png`, Buffer.alloc(1024), "image/png");
    expect(await storage.usedBytes(orgId)).toBe(1024);
    await prisma.organization.update({ where: { id: orgId }, data: { storageBytes: BigInt(2 * 1024 ** 3) } });
    await expect(storage.put(orgId, `${uniq()}.png`, Buffer.alloc(10), "image/png")).rejects.toMatchObject({ status: 413 });
  });

  const redisUrl = process.env.TEST_REDIS_URL;
  (redisUrl ? it : it.skip)("limite de requisições compartilhado no Redis bloqueia depois do limite", async () => {
    const storage = new RedisThrottlerStorage(redisUrl!);
    try {
      const key = uniq();
      const hits = [];
      for (let i = 0; i < 4; i++) hits.push(await storage.increment(key, 60_000, 3, 60_000, "default"));
      expect(hits.map((h) => h.isBlocked)).toEqual([false, false, false, true]);
      expect(hits[0].timeToExpire).toBeGreaterThan(0);
      const other = new RedisThrottlerStorage(redisUrl!);
      expect((await other.increment(key, 60_000, 3, 60_000, "default")).isBlocked).toBe(true);
      await other.onModuleDestroy();
    } finally { await storage.onModuleDestroy(); }
  });
});
