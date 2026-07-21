import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { Redis } from "ioredis";
import { loadConfig, type Config } from "./config.ts";
import { applySchema, initDb } from "./storage/db.ts";
import { getRedisClient, initRedis } from "./storage/redis.ts";
import { initAudit } from "./storage/audit.ts";
import { initFilesStorage } from "./storage/files.ts";
import { registerGrantableRoles } from "./auth/grantable-roles.ts";
import { renderNotFoundPage } from "./views/NotFound.tsx";
import { registerMetaRoutes } from "./routes/meta.ts";
import { registerUploadRoutes } from "./routes/upload.ts";
import { registerDeliveryRoutes } from "./routes/delivery.ts";
import { registerPreviewRoutes } from "./routes/preview.ts";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// D-48: the SPA is built into the image (web/dist, alongside this built server at app/dist/server.js)
// and served by Fastify, not nginx - nginx has no path into a kind=container image's filesystem.
const SPA_ROOT = path.join(moduleDir, "..", "..", "web", "dist");

// Pure wiring - no business logic (technical-baseline.md §2: routes own no logic that belongs in `lib`).
// `redis`/`config` are passed in explicitly rather than reached for as global singletons, so this builds
// cleanly in a test without running the full non-fatal boot sequence below.
export async function buildServer(redis: Redis, config: Config): Promise<FastifyInstance> {
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
        // frame-src: auth's SDK does its silent-refresh in a hidden iframe pointing at
        // https://auth.mosni.dev/authorize. With no frame-src directive, helmet's CSP fell back to
        // default-src 'self' and silently blocked it - sessions would die at token expiry instead of
        // renewing (session 006 finding, Wave A5).
        frameSrc: ["'self'", "https://auth.mosni.dev"],
        // data:/blob: let the drop zone show a local thumbnail before the upload completes (F1).
        imgSrc: ["'self'", "https://dl.mosni.dev", "data:", "blob:"],
        mediaSrc: ["'self'", "https://dl.mosni.dev"],
        connectSrc: ["'self'", "https://auth.mosni.dev"],
      },
    },
  });

  // nameSpace is mandatory here, not cosmetic: @fastify/rate-limit's Redis key defaults to
  // `fastify-rate-limit-<ip>` regardless of which plugin registration created it. Without distinct
  // namespaces, this global limiter and upload.ts's dedicated 600/min one would silently share counters
  // over the same redis instance - heavy tus traffic would count against (and could trip) everything
  // else's 100/min budget too, exactly what D1 exists to prevent. Confirmed empirically: an early version
  // without this let upload.test.ts's own rate-limit test 429 unrelated tests elsewhere in the same run.
  await app.register(rateLimit, {
    redis,
    global: true,
    max: 100,
    timeWindow: "1 minute",
    nameSpace: "fastify-rate-limit-global-",
  });

  // Serve the SPA on the files host ONLY. The host constraint matters: dl.mosni.dev's delivery route is a
  // catch-all `/*`, and without constraining static to the files host its own `/*` SPA fallback would
  // collide with delivery's on dl. (and could leak app JS onto the containment origin, D-33). Missing
  // web/dist (before the SPA is built) only warns, which is what lets this build in a test that never
  // runs `vite build`.
  const filesHost = new URL(config.appOrigin).hostname;
  await app.register(fastifyStatic, { root: SPA_ROOT, constraints: { host: filesHost } });

  // E2/E5a. Each registers its own host constraint (files.mosni.dev vs dl.mosni.dev) so the origin split
  // (D-4) holds even though both hosts are proxied to this same process. Delivery is dl-only; preview,
  // upload and the SPA are files-only; /health is unconstrained (the deploy healthcheck uses Host:
  // 127.0.0.1).
  await registerMetaRoutes(app, config);
  await registerUploadRoutes(app, config, redis);
  await registerDeliveryRoutes(app, config);
  await registerPreviewRoutes(app, config);

  // Renders a real .tsx view through renderToString (technical-baseline.md §1: React SSR via JSX). This
  // is also what makes D-44 verifiable rather than assumed - JSX cannot be type-stripped, so a server
  // that renders this at all is a server that was genuinely built.
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).type("text/html; charset=utf-8").send(renderNotFoundPage());
  });

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
  initAudit(config.botApi);
  initFilesStorage(config.storageRoot);

  const app = await buildServer(getRedisClient(), config);

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
