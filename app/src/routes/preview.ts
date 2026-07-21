// files.mosni.dev preview routes (preliminary-review P2/P6). Thin: host-constrained registration handing
// off to controllers/preview.ts.
//   /f/*        preview by plain path (the URL mirroring the on-disk relative path)
//   /t/:token   preview by token (the only way to reach a `secret` file's preview)

import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import { previewByPath, previewByToken } from "../controllers/preview.ts";

export async function registerPreviewRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const filesHost = new URL(config.appOrigin).hostname;

  app.get("/t/:token", { constraints: { host: filesHost } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    await previewByToken(request, reply, config, token);
  });

  app.get("/f/*", { constraints: { host: filesHost } }, async (request, reply) => {
    const relPath = (request.params as Record<string, string>)["*"];
    await previewByPath(request, reply, config, relPath);
  });
}
