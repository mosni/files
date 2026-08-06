// tus resumable uploads (D-19). Thin: the upload logic is in controllers/upload.ts; this file is only the
// Fastify/tus plumbing. Mounted at /api/upload in its own encapsulated scope so the catch-all
// content-type parser below cannot leak onto any other route.
//
// @tus/server speaks raw node:http, not Fastify's request/reply - the bridge is reply.hijack() plus
// handing the raw req/res to tusServer.handle(). A catch-all content-type parser bypass is required too,
// or Fastify's default JSON parser consumes the body stream before tus can read it.

import type { FastifyInstance, FastifyRequest, RouteHandlerMethod } from "fastify";
import type { Config } from "../config.ts";
import { buildTusServer } from "../controllers/upload.ts";
import { UPLOAD_CHUNK_SIZE } from "../lib/uploadConfig.ts";

// Dedicated rate limit: a 5 GB upload at UPLOAD_CHUNK_SIZE (lib/uploadConfig.ts) chunks is ~1000 PATCH
// requests, which the global 100/min limit would break. Keyed on the raw bearer header (cheap) rather
// than the verified sub, so this hook never runs JWT verification - the tus onIncomingRequest hook is the
// one place that happens. The `max` is budgeted against UPLOAD_CHUNK_SIZE: a smaller chunk size means more
// PATCHes, so that constant and this number move together (preliminary-review P10).
//
// ⚠ Per-route `config.rateLimit`, NOT a nested `register(rateLimit, …)` scope. Until the E6 review
// (session 042) this was a nested registration, which does NOT replace the global limiter for these
// routes - it adds a second one, and the stricter global 100/min still won. Measured: an upload larger
// than ~500 MB (>100 chunks in a minute) was 429'd mid-flight in production, and `onShouldRetry` treats a
// 429 as a settled 4xx, so it hard-failed. See the long note in routes/manage.ts for the mechanism.
const uploadRateLimit = {
  max: 600,
  timeWindow: "1 minute",
  keyGenerator: (request: FastifyRequest) => {
    const auth = request.headers.authorization;
    return typeof auth === "string" ? auth : request.ip;
  },
};

export async function registerUploadRoutes(app: FastifyInstance, config: Config): Promise<void> {
  void UPLOAD_CHUNK_SIZE; // the budget above is derived from it - keep the import live as that reminder
  const tusServer = buildTusServer(config);
  // Host-constrained to the files host (D-4/D-33). This is NOT decorative: /api/upload is a *static*
  // route, and find-my-way ranks a static path above delivery's host-constrained wildcard, so an
  // unconstrained registration answers on dl.mosni.dev too - and nginx proxies `location /` on that vhost
  // straight to this container, so it was reachable from the internet. The containment origin must carry
  // no app surface beyond X-Accel-Redirect delivery; an authenticated write API on it erodes exactly what
  // the origin split buys. Guarded by server-routing.test.ts.
  const filesHost = new URL(config.appOrigin).hostname;

  await app.register(async (scoped) => {
    // tus needs the raw, unconsumed request body stream - bypass Fastify's default body parsers.
    scoped.addContentTypeParser("*", (_request, _payload, done) => done(null));

    const handleTus: RouteHandlerMethod = async (request, reply) => {
      reply.hijack();
      await tusServer.handle(request.raw, reply.raw);
    };
    scoped.all("/api/upload", { constraints: { host: filesHost }, config: { rateLimit: uploadRateLimit } }, handleTus);
    scoped.all("/api/upload/*", { constraints: { host: filesHost }, config: { rateLimit: uploadRateLimit } }, handleTus);

    // E6 (D-174/A2): a partial upload past UPLOAD_EXPIRY_MS is already 410'd by @tus/server (A1's
    // `expirationPeriodInMilliseconds`), but the bytes and the config sidecar in STORAGE_ROOT/.tus stay on
    // disk until something calls cleanUpExpiredUploads() - @tus/server never schedules this itself. Once
    // per hour: a 7-day window does not need finer granularity, and the box is a 2011 Atom (D-78) - an
    // hourly readdir of .tus is the right cost.
    const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
    const sweepTimer = setInterval(() => {
      // A sweep failure must never take the server down - swallow and log, try again next hour.
      tusServer.cleanUpExpiredUploads().catch((err: unknown) => {
        console.error("upload: expired-upload sweep failed", err);
      });
    }, SWEEP_INTERVAL_MS);
    scoped.addHook("onClose", (_instance, done) => {
      clearInterval(sweepTimer);
      done();
    });
  });
}
