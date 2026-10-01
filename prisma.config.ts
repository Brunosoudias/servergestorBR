import "dotenv/config";
import { defineConfig } from "prisma/config";

// `prisma generate` roda no build do Docker sem DATABASE_URL; só migrate/studio precisam da URL.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
