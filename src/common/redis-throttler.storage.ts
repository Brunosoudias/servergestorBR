import { Logger, type OnModuleDestroy } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import type { ThrottlerStorageRecord } from "@nestjs/throttler/dist/throttler-storage-record.interface";
import Redis from "ioredis";

// Janela fixa: conta acertos com TTL e, ao estourar o limite, grava uma chave de bloqueio por blockDuration.
const SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
local blocked = redis.call('PTTL', KEYS[2])
if blocked > 0 then return {hits, ttl, 1, blocked} end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return {hits, ttl, 1, tonumber(ARGV[3])}
end
return {hits, ttl, 0, 0}`;

const seconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

/** Limite de requisições compartilhado por todas as instâncias da API. */
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly log = new Logger("Throttler");
  readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 1, commandTimeout: 500, connectTimeout: 2000 });
    this.redis.on("error", (e) => this.log.warn(`Redis indisponível: ${e.message}`));
  }

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    const base = `throttle:${throttlerName}:${key}`;
    try {
      const [hits, ttlMs, blocked, blockMs] = (await this.redis.eval(SCRIPT, 2, `${base}:hits`, `${base}:block`, ttl, limit, blockDuration || ttl)) as number[];
      return { totalHits: hits, timeToExpire: seconds(ttlMs), isBlocked: blocked === 1, timeToBlockExpire: seconds(blockMs) };
    } catch (e) {
      // Sem Redis, a API continua no ar; o bloqueio de conta por tentativas segue valendo no banco.
      this.log.warn(`Limite de requisições ignorado (Redis): ${(e as Error).message}`);
      return { totalHits: 0, timeToExpire: seconds(ttl), isBlocked: false, timeToBlockExpire: 0 };
    }
  }

  async onModuleDestroy() { await this.redis.quit().catch(() => undefined); }
}
