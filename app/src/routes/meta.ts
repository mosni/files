// Small infra endpoints (preliminary-review P2). No real logic, so no controller.
//   /health      liveness for the deploy healthcheck (any host - the healthcheck uses Host: 127.0.0.1)
//   /api/config  server-authoritative client config (preliminary-review P10) - the upload chunk size the
//                SPA must use, so the client and the server's rate-limit budget cannot drift apart.

import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import { UPLOAD_CHUNK_SIZE } from "../lib/uploadConfig.ts";

export async function registerMetaRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const filesHost = new URL(config.appOrigin).hostname;

  // Not host-constrained: lib/deploy's healthy() hits it with Host: 127.0.0.1, not files.mosni.dev.
  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/config", { constraints: { host: filesHost } }, async () => ({
    uploadChunkSize: UPLOAD_CHUNK_SIZE,
  }));
}
