import path from "node:path";
import type { Config } from "../../src/config.ts";

// A minimal, valid Config for tests that build a server/route set directly rather than going through
// loadConfig() + real env vars. storageRoot defaults to a throwaway path - tests that actually touch the
// filesystem should override it with a real mkdtemp() directory via the `overrides` param.
export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  const storageRoot = overrides.storageRoot ?? "/tmp/unused-storage-root";
  return {
    db: { host: "mariadb", port: 3306, user: "files", pass: "filespass", name: "files" },
    redisUrl: "redis://redis:6379",
    botApi: "http://bot-core:8080",
    authIssuer: "https://auth.mosni.dev",
    appOrigin: "https://files.mosni.dev",
    dlOrigin: "https://dl.mosni.dev",
    storageRoot,
    tusTempDir: path.join(storageRoot, ".tus"),
    port: 0,
    ...overrides,
  };
}
