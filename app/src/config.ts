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
  // D-84: signs dl.mosni.dev/s/<id>?exp=&sig= URLs. A box provisioning prerequisite of the same class as
  // DB_PASS - required (never defaulted), so an unset secret fails boot loudly instead of silently
  // signing every URL with the empty string.
  deliverySigningSecret: string;
  deliveryUrlTtlSeconds: number;
  // Review 060: the e2e tier's rate-limit escape hatch. See RATE_LIMIT_DISABLED below - this is `true`
  // ONLY for a non-production origin that explicitly asked for it, and server.ts then skips registering
  // @fastify/rate-limit at all.
  rateLimitDisabled: boolean;
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
  "DELIVERY_SIGNING_SECRET",
] as const;

const DEFAULT_DELIVERY_URL_TTL_SECONDS = 300;

// The real deployment's origin. Named here, as a literal, for exactly one purpose: to make
// RATE_LIMIT_DISABLED structurally unable to take effect on it.
const PRODUCTION_APP_ORIGIN = "https://files.mosni.dev";

/**
 * RATE_LIMIT_DISABLED - turns off EVERY rate limiter in the app. Optional, off unless the value is the
 * exact string "true".
 *
 * Why it exists: the e2e tier drives a real browser through real nginx into the real production image, and
 * every request in the whole suite arrives from ONE address - so all of it shares the single 100/min
 * per-IP global budget (server.ts). Playwright's own parallel workers then push it over that budget, and
 * the 429s land on whichever spec happened to be running: browser specs failed in shuffling, irreproducible
 * sets, and running any one of them alone passed. Measured at 34 rate-limit rejections in a single baseline
 * run before this flag existed. A test tier that fails differently every time teaches nothing, and the
 * limiter is not what any of those specs is testing - upload.test.ts and rate-limit-namespaces.test.ts
 * cover the limiter itself, deliberately, with the flag off.
 *
 * ⚠ It is REFUSED on the production origin, whatever the environment says. A rate limiter is a real
 * defence (D-1's own abuse ceiling, and the only thing between an unauthenticated caller and the delivery
 * path), so a stray env var in a deploy manifest must not be able to remove it - the check is on
 * APP_ORIGIN rather than on a NODE_ENV-style hint because APP_ORIGIN is already required, already
 * validated, and cannot be wrong without the app being visibly broken in other ways first.
 */
function readRateLimitDisabled(env: NodeJS.ProcessEnv): boolean {
  if (env.RATE_LIMIT_DISABLED !== "true") return false;
  if (env.APP_ORIGIN === PRODUCTION_APP_ORIGIN) {
    console.error(
      `config: RATE_LIMIT_DISABLED=true was IGNORED - it is refused on the production origin (${PRODUCTION_APP_ORIGIN}). ` +
        "Rate limiting stays on. If this is not the production deploy, APP_ORIGIN is wrong.",
    );
    return false;
  }
  return true;
}

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
    // rename() is same-filesystem (atomic), and dot-prefixed so isIgnoredEntry() skips it when the
    // upload commit scans the destination directory for name collisions.
    tusTempDir: path.join(env.STORAGE_ROOT!, ".tus"),
    port: Number(env.PORT),
    deliverySigningSecret: env.DELIVERY_SIGNING_SECRET!,
    deliveryUrlTtlSeconds: env.DELIVERY_URL_TTL_SECONDS
      ? Number(env.DELIVERY_URL_TTL_SECONDS)
      : DEFAULT_DELIVERY_URL_TTL_SECONDS,
    rateLimitDisabled: readRateLimitDisabled(env),
  };
}
