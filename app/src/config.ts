// Env loading and validation. Deliberately the ONE place in this app that fails fast and loudly on a
// missing required var, in contrast to D-32 (role registration) and D-43 (the audit emitter), which are
// both non-fatal by design - a misconfigured deploy should crash at boot, not limp along silently.

import path from "node:path";

export type Config = {
  db: { host: string; port: number; user: string; pass: string; name: string };
  redisUrl: string;
  botApi: string;
  authIssuer: string;
  appOrigin: string;
  dlOrigin: string;
  storageRoot: string;
  tusTempDir: string;
  port: number;
};

const REQUIRED = [
  "DB_HOST",
  "DB_PORT",
  "DB_USER",
  "DB_PASS",
  "DB_NAME",
  "REDIS_URL",
  "BOT_API",
  "AUTH_ISSUER",
  "APP_ORIGIN",
  "DL_ORIGIN",
  "STORAGE_ROOT",
  "PORT",
] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  return {
    db: {
      host: env.DB_HOST!,
      port: Number(env.DB_PORT),
      user: env.DB_USER!,
      pass: env.DB_PASS!,
      name: env.DB_NAME!,
    },
    // BOT_API is a configurable URL, never a hardcoded `bot-core` host (D-43): the 2026-06-30 amendment
    // retires bot-core into a host-side runtime that still exposes /say, so this must keep pointing at
    // whichever host owns the endpoint.
    botApi: env.BOT_API!,
    redisUrl: env.REDIS_URL!,
    authIssuer: env.AUTH_ISSUER!,
    appOrigin: env.APP_ORIGIN!,
    dlOrigin: env.DL_ORIGIN!,
    storageRoot: env.STORAGE_ROOT!,
    // Derived, not a separate env var. Must live inside STORAGE_ROOT so the tus-finish -> final-path
    // rename() is same-filesystem (atomic), and dot-prefixed so isIgnoredEntry() skips it during
    // reconciliation (D-57).
    tusTempDir: path.join(env.STORAGE_ROOT!, ".tus"),
    port: Number(env.PORT),
  };
}
