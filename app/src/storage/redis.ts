import { Redis } from "ioredis";

let client: Redis | undefined;

export function initRedis(redisUrl: string): void {
  client = new Redis(redisUrl);
}

export async function closeRedis(): Promise<void> {
  if (client === undefined) return;
  await client.quit();
  client = undefined;
}

export function getRedisClient(): Redis {
  if (client === undefined) {
    throw new Error("redis: initRedis() must be called before use");
  }
  return client;
}
