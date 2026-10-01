import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadDotenv } from "dotenv";

/** Desde o Prisma 7 o client não lê `.env` nem a URL do schema: a conexão vem deste adapter. */
export function createPrismaAdapter() {
  loadDotenv({ quiet: true });
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL não definida.");
  return new PrismaPg({ connectionString });
}
