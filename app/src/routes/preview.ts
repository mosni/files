// D-9: server-rendered preview pages, on files.mosni.dev only (Fastify host constraint - the same
// containment reasoning as routes/delivery.ts, just the other side of the origin split).

import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import { buildFileUrls } from "../lib/fileUrls.ts";
import { readablePathResolves } from "../lib/protection.ts";
import { NON_RESERVED_COLLECTION_PARAM } from "../lib/paths.ts";
import { resolveByPath, resolveByToken } from "../storage/files.ts";
import { renderPreviewPage } from "../views/Preview.tsx";

export async function registerPreviewRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const filesHost = new URL(config.appOrigin).hostname;

  app.get("/f/:token", { constraints: { host: filesHost } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const record = await resolveByToken(token);
    if (record === null) {
      reply.code(404).send();
      return;
    }
    const urls = buildFileUrls(config, record.protection, record.collection, record.name, record.linkToken);
    reply.type("text/html; charset=utf-8").send(renderPreviewPage(record, urls));
  });

  app.get(
    `/${NON_RESERVED_COLLECTION_PARAM}/:name`,
    { constraints: { host: filesHost } },
    async (request, reply) => {
      const { collection, name } = request.params as { collection: string; name: string };
      const record = await resolveByPath(collection, name);
      // `secret` must 404 at its readable path, not 403 - same rule as delivery (D-59).
      if (record === null || !readablePathResolves(record.protection)) {
        reply.code(404).send();
        return;
      }
      const urls = buildFileUrls(config, record.protection, record.collection, record.name, record.linkToken);
      reply.type("text/html; charset=utf-8").send(renderPreviewPage(record, urls));
    },
  );
}
