import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.ts";

const VALID_ENV = {
  DB_HOST: "mariadb",
  DB_PORT: "3306",
  DB_USER: "files",
  DB_PASS: "filespass",
  DB_NAME: "files",
  REDIS_URL: "redis://redis:6379",
  BOT_API: "http://bot-core:8080",
  AUTH_ISSUER: "https://auth.mosni.dev",
  APP_ORIGIN: "https://files.mosni.dev",
  DL_ORIGIN: "https://dl.mosni.dev",
  STORAGE_ROOT: "/data/storage",
  PORT: "3000",
  DELIVERY_SIGNING_SECRET: "test-signing-secret",
};

describe("loadConfig()", () => {
  it("loads a complete, valid environment", () => {
    const config = loadConfig(VALID_ENV);
    expect(config).toEqual({
      db: { host: "mariadb", port: 3306, user: "files", pass: "filespass", name: "files" },
      redisUrl: "redis://redis:6379",
      botApi: "http://bot-core:8080",
      authIssuer: "https://auth.mosni.dev",
      appOrigin: "https://files.mosni.dev",
      dlOrigin: "https://dl.mosni.dev",
      storageRoot: "/data/storage",
      tusTempDir: "/data/storage/.tus",
      port: 3000,
      deliverySigningSecret: "test-signing-secret",
      deliveryUrlTtlSeconds: 300,
      rateLimitDisabled: false,
    });
  });

  it("parses DB_PORT and PORT as numbers", () => {
    const config = loadConfig(VALID_ENV);
    expect(config.db.port).toBe(3306);
    expect(config.port).toBe(3000);
  });

  it.each(Object.keys(VALID_ENV))("fails fast and loudly when %s is missing", (missingKey) => {
    const env = { ...VALID_ENV };
    delete (env as Record<string, string>)[missingKey];
    expect(() => loadConfig(env)).toThrow(missingKey);
  });

  it("reports every missing var, not just the first", () => {
    const env = { ...VALID_ENV };
    delete (env as Record<string, string>).DB_HOST;
    delete (env as Record<string, string>).REDIS_URL;
    expect(() => loadConfig(env)).toThrow(/DB_HOST/);
    expect(() => loadConfig(env)).toThrow(/REDIS_URL/);
  });

  it("treats an empty string as missing", () => {
    expect(() => loadConfig({ ...VALID_ENV, PORT: "" })).toThrow("PORT");
  });

  it("DELIVERY_URL_TTL_SECONDS defaults to 300 when unset", () => {
    expect(loadConfig(VALID_ENV).deliveryUrlTtlSeconds).toBe(300);
  });

  it("DELIVERY_URL_TTL_SECONDS is honoured when set", () => {
    const config = loadConfig({ ...VALID_ENV, DELIVERY_URL_TTL_SECONDS: "60" });
    expect(config.deliveryUrlTtlSeconds).toBe(60);
  });

  // Review 060: RATE_LIMIT_DISABLED turns off every limiter in the app (server.ts skips registering
  // @fastify/rate-limit at all), so the interesting cases are the ones where it must NOT take effect.
  describe("RATE_LIMIT_DISABLED", () => {
    it("defaults to off when the variable is absent", () => {
      expect(loadConfig(VALID_ENV).rateLimitDisabled).toBe(false);
    });

    it("is on only for the EXACT string \"true\", on a non-production origin", () => {
      const env = { ...VALID_ENV, APP_ORIGIN: "https://files-e2e.test" };
      expect(loadConfig({ ...env, RATE_LIMIT_DISABLED: "true" }).rateLimitDisabled).toBe(true);
      for (const value of ["TRUE", "1", "yes", "", "false"]) {
        expect(loadConfig({ ...env, RATE_LIMIT_DISABLED: value }).rateLimitDisabled).toBe(false);
      }
    });

    // The guard that matters: a stray env var in a deploy manifest must not be able to remove a real
    // defence. APP_ORIGIN is the discriminator because it is already required and already validated.
    it("is REFUSED on the production origin, however it is set", () => {
      const config = loadConfig({ ...VALID_ENV, RATE_LIMIT_DISABLED: "true" });
      expect(config.appOrigin).toBe("https://files.mosni.dev");
      expect(config.rateLimitDisabled).toBe(false);
    });
  });
});
