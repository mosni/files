import { afterEach, describe, expect, it } from "vitest";
import { closeRedis, getRedisClient, initRedis } from "../../src/storage/redis.ts";

describe("storage/redis.ts", () => {
  afterEach(async () => {
    await closeRedis();
  });

  it("getRedisClient() throws before initRedis() is called", () => {
    expect(() => getRedisClient()).toThrow("redis: initRedis() must be called before use");
  });

  it("initRedis() then getRedisClient() returns the same client instance", () => {
    initRedis(process.env.REDIS_URL ?? "redis://redis:6379");
    const client = getRedisClient();
    expect(getRedisClient()).toBe(client);
  });

  it("closeRedis() before any init is a no-op, not a throw", async () => {
    await expect(closeRedis()).resolves.toBeUndefined();
  });

  it("closeRedis() after init resets state so getRedisClient() throws again", async () => {
    initRedis(process.env.REDIS_URL ?? "redis://redis:6379");
    await closeRedis();
    expect(() => getRedisClient()).toThrow("redis: initRedis() must be called before use");
  });
});
