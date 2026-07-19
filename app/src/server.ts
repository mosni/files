import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { Redis } from "ioredis";
import { loadConfig } from "./config.ts";
import { applySchema, initDb } from "./storage/db.ts";
import { getRedisClient, initRedis } from "./storage/redis.ts";
import { registerGrantableRoles } from "./auth/grantable-roles.ts";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// D-48: the SPA is built into the image (web/dist, alongside this built server at app/dist/server.js)
// and served by Fastify, not nginx - nginx has no path into a kind=container image's filesystem.
const SPA_ROOT = path.join(moduleDir, "..", "..", "web", "dist");

// Pure wiring - no business logic (technical-baseline.md §2: routes own no logic that belongs in `lib`;
// E1 ships none yet). `redis` is passed in explicitly rather than reached for as a global singleton, so
// this builds cleanly in a test without running the full non-fatal boot sequence below.
export async function buildServer(redis: Redis): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // Security invariants 3/4 (technical-baseline.md §1): `X-Content-Type-Options: nosniff` and
  // `Referrer-Policy: no-referrer` on every response. CSP allows the design system (ui.mosni.dev) and the
  // auth SDK (auth.mosni.dev) as scripts, and dl.mosni.dev as a media/image source ONLY - dl. must never
  // be a script source (D-4: that origin exists precisely to keep attacker-controlled bytes
  // non-executable; allowing scripts from it would undo the containment the origin split buys).
  await app.register(helmet, {
    referrerPolicy: { policy: "no-referrer" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://ui.mosni.dev", "https://auth.mosni.dev"],
        styleSrc: ["'self'", "https://ui.mosni.dev", "'unsafe-inline'"],
        imgSrc: ["'self'", "https://dl.mosni.dev"],
        mediaSrc: ["'self'", "https://dl.mosni.dev"],
        connectSrc: ["'self'", "https://auth.mosni.dev"],
      },
    },
  });

  await app.register(rateLimit, { redis, global: true, max: 100, timeWindow: "1 minute" });

  // Missing web/dist (e.g. before the SPA has been built) only warns, per @fastify/static - it does not
  // fail registration, which is what lets this build cleanly in a test that never runs `vite build`.
  await app.register(fastifyStatic, { root: SPA_ROOT });

  // lib/deploy's healthy() accepts any response < 500; `dl.mosni.dev` is never health-checked (only the
  // apps.list domain is), so a broken `dl.` vhost will not fail a deploy - check it by hand.
  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

// The real boot sequence (production entrypoint only). Schema application and role registration are both
// non-fatal (D-32): a failure here degrades rather than blocks boot - a dead auth or a schema hiccup must
// never take the whole app down.
export async function start(): Promise<FastifyInstance> {
  const config = loadConfig();

  initDb({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.pass,
    database: config.db.name,
  });
  initRedis(config.redisUrl);

  const app = await buildServer(getRedisClient());

  try {
    await applySchema();
  } catch (err) {
    app.log.error(err, "applySchema failed on boot - continuing; a newly-added table/column may be missing");
  }
  await registerGrantableRoles();

  await app.listen({ port: config.port, host: "0.0.0.0" });
  return app;
}

// Only runs the boot sequence when executed directly (node app/dist/server.js) - never when imported by
// tests or by the SSR view-rendering path.
if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
