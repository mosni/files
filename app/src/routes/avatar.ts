// files.mosni.dev's avatar proxy route (D-136). Thin: host-constrained registration handing off to
// controllers/avatar.ts.

import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import { avatarHandler } from "../controllers/avatar.ts";

export async function registerAvatarRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const filesHost = new URL(config.appOrigin).hostname;

  app.get("/api/avatar/:fileId", { constraints: { host: filesHost } }, async (request, reply) => {
    const { fileId } = request.params as { fileId: string };
    await avatarHandler(request, reply, config, fileId, request.query as { exp?: string; sig?: string });
  });
}
