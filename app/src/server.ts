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
import { initSpaShell } from "./storage/spaShell.ts";
import { registerGrantableRoles } from "./auth/grantable-roles.ts";
import { initVerify } from "./auth/verify.ts";
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
  // trustProxy: every request arrives via nginx (D-33's vhosts proxy_pass to this container), so without
  // it `request.protocol` is always http and `request.ip` is always nginx's address - which meant the
  // global 100/min rate limit was keyed on ONE address for every user on the box, i.e. a shared budget
  // rather than a per-client one. nginx already sets X-Forwarded-For/Proto/Host on both vhosts.
  const app = Fastify({ logger: true, trustProxy: true });

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
        // renewing (session 006 finding, Wave A5). dl.mosni.dev is here too (D-70/Wave C5 bug fix): the
        // preview page embeds a pdf/txt in an <iframe src="https://dl.mosni.dev/...">, which this
        // directive was blocking under our own CSP until now. Never add dl. to scriptSrc - that would
        // undo D-4's containment.
        frameSrc: ["'self'", "https://auth.mosni.dev", "https://dl.mosni.dev"],
        // The reciprocal half of the frame-src fix above, found only by actually executing a preview page
        // with a real browser (D-70 Wave D e2e run): frame-src on the PARENT document controls what it may
        // point an <iframe> at, but whether the framing succeeds ALSO depends on the CHILD response's own
        // frame-ancestors header - and helmet is registered once, globally, so dl.'s delivery responses
        // carry the exact same directives as files.'s pages, including the default-merged
        // `frame-ancestors 'self'`. That silently blocked every dl. iframe in production too, not just
        // here - Wave C5's frame-src fix alone was never sufficient. Explicitly allowing files.mosni.dev is
        // the minimal permission this app ever needs (files. embeds dl. content; nothing else must).
        frameAncestors: ["'self'", "https://files.mosni.dev"],
        // data:/blob: let the drop zone show a local thumbnail before the upload completes (F1).
        // ui.mosni.dev is here because <mosni-logo> (shipped inside <mosni-header>) loads
        // `${assetBase}mosni.svg` from wherever mosnicat.js was served - i.e. the design system's own
        // origin. Without it the site logo is a broken image on EVERY page, in production too. Found by
        // D-79's visual check; session 009 had seen the console warning and written it off as "unrelated
        // pre-existing noise", which it was not - it is the same shape as D-77's frame-ancestors bug:
        // our own CSP blocking our own chrome.
        imgSrc: ["'self'", "https://ui.mosni.dev", "https://dl.mosni.dev", "data:", "blob:"],
        mediaSrc: ["'self'", "https://dl.mosni.dev"],
        connectSrc: ["'self'", "https://auth.mosni.dev"],
        // helmet's `useDefaults` (on by default, never explicitly chosen here) merges in
        // `upgrade-insecure-requests`, which silently rewrites every same-origin http: subresource URL
        // (the SPA's own relative /assets/*.js script tag included) to https: before the browser even
        // attempts the connection. D-70 Wave D found this: it makes a real-browser e2e test of the SPA
        // mounting impossible on any plain-HTTP box, sandboxed or not - not just this one. Explicitly
        // nulling it out removes it from helmet's merged defaults. Safe to drop: it is not one of
        // technical-baseline.md §1's named invariants, and it is a no-op in production regardless, since
        // D-33's committed nginx vhosts are TLS-only - nothing ever serves this app over plain HTTP for it
        // to "upgrade" away from. Flagged for Hannah's sign-off (a security header, even though inert here).
        upgradeInsecureRequests: null,
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

  // Serve the SPA. Deliberately UNconstrained by host: the SPA must be reachable both at files.mosni.dev
  // (via nginx's Host: files.mosni.dev) and at the container's own host (the deploy healthcheck / e2e hit
  // app-e2e:3000 directly). D-33 (no SPA/app-JS on dl.) is still upheld: delivery registers a host-
  // constrained `/*` on the dl host, and find-my-way prefers that host match over this unconstrained
  // wildcard, so every dl. request goes to delivery (a file or a 404) and static content never serves
  // there. Missing web/dist (before the SPA is built) only warns, which lets this build in a test that
  // never runs `vite build`.
  await app.register(fastifyStatic, { root: SPA_ROOT });
  // D-70: reads web/dist/index.html once at boot - controllers/preview.ts splices the server-rendered
  // <head> into it. Same missing-web/dist tolerance as fastifyStatic above (falls back to a minimal shell).
  initSpaShell(SPA_ROOT);

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
  initVerify(config.authIssuer);

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
