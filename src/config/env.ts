import { config as loadDotenv } from "dotenv";

const bool = (v: string | undefined, d = false) => (v === undefined || v === "" ? d : ["1", "true", "yes"].includes(v.toLowerCase()));

let dotenvLoaded = false;

/** O Prisma CLI lê `.env` sozinho; o processo do Nest não. Carrega uma vez, sem sobrescrever variáveis já definidas. */
function ensureDotenv(src: NodeJS.ProcessEnv) {
  if (dotenvLoaded || src !== process.env) return;
  dotenvLoaded = true;
  loadDotenv();
}

export function loadEnv(src: NodeJS.ProcessEnv = process.env) {
  ensureDotenv(src);
  const prod = src.NODE_ENV === "production";
  const cfg = {
    prod,
    port: Number(src.PORT ?? 4000),
    webOrigins: (src.WEB_ORIGINS ?? "http://localhost:3000").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
    webUrl: (src.WEB_URL ?? "http://localhost:3000").replace(/\/$/, ""),
    apiUrl: (src.API_PUBLIC_URL ?? `http://localhost:${src.PORT ?? 4000}`).replace(/\/$/, ""),
    uploadDir: src.UPLOAD_DIR ?? "uploads",
    cookie: {
      name: src.SESSION_COOKIE_NAME ?? "session",
      secure: bool(src.COOKIE_SECURE, prod),
      domain: src.COOKIE_DOMAIN || undefined,
      ttlDays: Number(src.SESSION_TTL_DAYS ?? 7),
    },
    mailEnabled: bool(src.MAIL_ENABLED),
    sendgridApiKey: src.SENDGRID_API_KEY || undefined,
    redisUrl: src.REDIS_URL || undefined,
    storage: src.S3_BUCKET
      ? { driver: "s3" as const, bucket: src.S3_BUCKET, region: src.S3_REGION ?? "us-east-1", endpoint: src.S3_ENDPOINT || undefined, publicUrl: (src.S3_PUBLIC_URL ?? "").replace(/\/$/, "") || undefined, forcePathStyle: bool(src.S3_FORCE_PATH_STYLE) }
      : { driver: "local" as const },
    logFormat: (src.LOG_FORMAT ?? (prod ? "json" : "text")) as "json" | "text",
    smtp: src.SMTP_HOST ? { host: src.SMTP_HOST, port: Number(src.SMTP_PORT ?? 587), user: src.SMTP_USER, pass: src.SMTP_PASS } : null,
    mailFrom: src.MAIL_FROM ?? "Gestor Br <nao-responder@localhost>",
    trustProxy: bool(src.TRUST_PROXY, prod),
    integrations: (src.INTEGRATIONS_MODE ?? (prod ? "live" : "sandbox")) as "sandbox" | "live",
    secretsKey: src.SECRETS_KEY ?? "",
  };
  if (prod) {
    if (!/^[0-9a-f]{64}$/i.test(cfg.secretsKey)) throw new Error("SECRETS_KEY deve ter 64 caracteres hexadecimais em produção (openssl rand -hex 32).");
    if (!cfg.cookie.secure) throw new Error("COOKIE_SECURE deve ser true em produção.");
    if (cfg.webOrigins.some((o) => o.startsWith("http://"))) throw new Error("WEB_ORIGINS deve usar https em produção.");
    if (cfg.mailEnabled && !cfg.sendgridApiKey && !cfg.smtp) throw new Error("Com MAIL_ENABLED=true, SENDGRID_API_KEY (ou SMTP_HOST) é obrigatório em produção: sem ele os links de redefinição de senha e convite não chegam ao usuário.");
    if (cfg.mailEnabled && /@localhost>?$/.test(cfg.mailFrom)) throw new Error("MAIL_FROM deve ser um remetente real em produção (no SendGrid, um Sender verificado).");
  }
  return cfg;
}
export type Env = ReturnType<typeof loadEnv>;
export const ENV = "APP_ENV";
