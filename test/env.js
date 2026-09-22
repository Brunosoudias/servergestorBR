const base = process.env.TEST_DATABASE_URL ?? (process.env.DATABASE_URL ?? "postgresql://gestao:gestao_dev@localhost:5440/gestao?schema=public").replace("/gestao?", "/gestao_test?");
if (!base.includes("gestao_test")) throw new Error("Os testes só rodam no banco gestao_test. Verifique TEST_DATABASE_URL.");
process.env.DATABASE_URL = base;
process.env.NODE_ENV = "test";
process.env.WEB_ORIGINS = "http://localhost:3000";
process.env.DISABLE_THROTTLE = "1";
process.env.FISCAL_SANDBOX_DELAY_MS = "0";
process.env.UPLOAD_DIR = require("path").join(require("os").tmpdir(), "gestao-test-uploads");
