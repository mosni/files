// files.mosni.dev's browse route (§1.4 of the E4 waves hand-off). Thin: host-constrained registration
// handing off to controllers/browse.ts. scope=public is this app's first and only anonymous listing
// endpoint (D-94) - it takes no schema requiring a Bearer.

import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import { browseHandler } from "../controllers/browse.ts";

export async function registerBrowseRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const filesHost = new URL(config.appOrigin).hostname;

  app.get("/api/browse", { constraints: { host: filesHost } }, async (request, reply) => {
    await browseHandler(request, reply, config);
  });
}
