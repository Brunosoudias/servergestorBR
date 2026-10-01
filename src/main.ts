import "reflect-metadata";
import { ConsoleLogger, Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import { resolve } from "path";
import { AppModule } from "./app.module";
import { requestContext } from "./common/request-context";
import { validationExceptionFactory } from "./common/validation";
import { type Env, loadEnv } from "./config/env";

export function configureApp(app: NestExpressApplication, env: Env) {
  if (env.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(requestContext);
  const bigJson = express.json({ limit: "3mb" });
  app.use("/bank/import", (req: Request, res: Response, next: NextFunction) => bigJson(req, res, next));
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cookieParser());

  app.enableCors({ origin: env.webOrigins, credentials: true, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], allowedHeaders: ["Content-Type", "X-Organization-Id"], exposedHeaders: ["X-Request-Id"], maxAge: 600 });

  app.use((req: Request, res: Response, next: NextFunction) => {
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    const origin = req.header("origin");
    if (unsafe && origin && !env.webOrigins.includes(origin.replace(/\/$/, ""))) return res.status(403).json({ statusCode: 403, message: "Origem não permitida." });
    next();
  });

  app.use("/uploads", express.static(resolve(env.uploadDir), {
    index: false, dotfiles: "deny", maxAge: "30d", immutable: true,
    setHeaders: (res) => { res.setHeader("Cross-Origin-Resource-Policy", "cross-origin"); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Content-Security-Policy", "default-src 'none'"); },
  }));

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false }, exceptionFactory: validationExceptionFactory }));
  app.enableShutdownHooks();
}

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: new ConsoleLogger({ json: env.logFormat === "json", prefix: "gestor-api" }) });
  configureApp(app, env);
  await app.listen(env.port);
  const log = new Logger("Bootstrap");
  log.log(`API em http://localhost:${env.port} (${env.prod ? "produção" : "desenvolvimento"})`);
  log.log(`Armazenamento: ${env.storage.driver} · limite de requisições: ${env.redisUrl ? "Redis (compartilhado)" : "memória (uma instância)"} · e-mail: ${!env.mailEnabled ? "desativado (MAIL_ENABLED=false)" : env.sendgridApiKey ? "SendGrid" : env.smtp ? "SMTP" : "apenas log"}`);
  if (env.prod && (!env.redisUrl || env.storage.driver === "local")) log.warn("Rodando com estado local (sem REDIS_URL e/ou S3_BUCKET): use uma única instância da API.");
}

if (require.main === module) void bootstrap();
