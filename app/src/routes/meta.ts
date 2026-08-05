// Small infra endpoints (preliminary-review P2). No real logic, so no controller.
//   /health      liveness for the deploy healthcheck (any host - the healthcheck uses Host: 127.0.0.1)
//   /api/config  server-authoritative client config (preliminary-review P10) - the upload chunk size the
//                SPA must use, so the client and the server's rate-limit budget cannot drift apart.

import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import { UPLOAD_CHUNK_SIZE, UPLOAD_EXPIRY_MS } from "../lib/uploadConfig.ts";

export async function registerMetaRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const filesHost = new URL(config.appOrigin).hostname;

  // Not host-constrained: lib/deploy's healthy() hits it with Host: 127.0.0.1, not files.mosni.dev.
  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/config", { constraints: { host: filesHost } }, async () => ({
    uploadChunkSize: UPLOAD_CHUNK_SIZE,
    // E6 A4: so the paused-upload UI can state the resumable window honestly instead of hardcoding "7
    // days" a second time client-side (§0.5).
    uploadExpiryMs: UPLOAD_EXPIRY_MS,
  }));

  // E6 G7: a defensive fallback for POST /share-target. The share target is only ever offered by Android
  // for an INSTALLED PWA (which implies an active service worker, web/src/sw.ts's own fetch handler for
  // this exact path) - the worker should always win, but without this a POST that somehow reaches the
  // origin directly (worker not yet controlling the page, or unregistered) 404s instead of degrading.
  app.all("/share-target", { constraints: { host: filesHost } }, async (_request, reply) => {
    reply.redirect("/", 303);
  });
}
