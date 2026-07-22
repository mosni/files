// files.mosni.dev preview routes (preliminary-review P2/P6, D-70). Thin: host-constrained registration
// handing off to controllers/preview.ts.
//   /f/*                 preview document by plain path (the URL mirroring the on-disk relative path)
//   /t/:token             preview document by token (the only way to reach a `secret` file's preview)
//   /api/preview/f/*      preview context JSON by plain path, for client-side navigation and `private`
//   /api/preview/t/:token preview context JSON by token
//   /api/oembed           oEmbed 1.0 discovery (D-74)

import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import {
  oembedForUrl,
  previewByPath,
  previewByToken,
  previewContextByPath,
  previewContextByToken,
} from "../controllers/preview.ts";

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

  app.get("/api/preview/t/:token", { constraints: { host: filesHost } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    await previewContextByToken(request, reply, config, token);
  });

  app.get("/api/preview/f/*", { constraints: { host: filesHost } }, async (request, reply) => {
    const relPath = (request.params as Record<string, string>)["*"];
    await previewContextByPath(request, reply, config, relPath);
  });

  app.get("/api/oembed", { constraints: { host: filesHost } }, async (request, reply) => {
    await oembedForUrl(request, reply, config);
  });
}
