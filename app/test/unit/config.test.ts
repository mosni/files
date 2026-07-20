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
});
