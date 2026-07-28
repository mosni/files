// The management API (§1.5 of the E3 waves hand-off) - rename/delete for files and collections,
// protection-level changes, collection creation/listing. Host-constrained to files.mosni.dev (D-33: no
// app surface on dl.), registered alongside the other route modules in server.ts. Thin: schema validation
// plus handing off to controllers/manage.ts.

import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import {
  createCollectionHandler,
  deleteCollectionHandler,
  deleteFileHandler,
  listCollections,
  updateCollectionHandler,
  updateFileHandler,
} from "../controllers/manage.ts";

const PROTECTION_ENUM = ["public", "unlisted", "secret", "private"] as const;

const createCollectionSchema = {
  body: {
    type: "object",
    required: ["name"],
    properties: {
      parentId: { type: "string" },
      name: { type: "string", minLength: 1, maxLength: 255 },
    },
    additionalProperties: false,
  },
};

const updateCollectionSchema = {
  body: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 255 },
      defaultProtection: { type: "string", enum: PROTECTION_ENUM },
    },
    additionalProperties: false,
  },
};

const updateFileSchema = {
  body: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 255 },
      protection: { type: "string", enum: PROTECTION_ENUM },
    },
    additionalProperties: false,
  },
};

export async function registerManageRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const filesHost = new URL(config.appOrigin).hostname;

  app.get("/api/collections", { constraints: { host: filesHost } }, async (request, reply) => {
    await listCollections(request, reply, config);
  });

  app.post(
    "/api/collections",
    { constraints: { host: filesHost }, schema: createCollectionSchema },
    async (request, reply) => {
      await createCollectionHandler(request, reply, config);
    },
  );

  app.patch(
    "/api/collections/:id",
    { constraints: { host: filesHost }, schema: updateCollectionSchema },
    async (request, reply) => {
      await updateCollectionHandler(request, reply, config);
    },
  );

  app.delete("/api/collections/:id", { constraints: { host: filesHost } }, async (request, reply) => {
    await deleteCollectionHandler(request, reply, config);
  });

  app.patch(
    "/api/files/:id",
    { constraints: { host: filesHost }, schema: updateFileSchema },
    async (request, reply) => {
      await updateFileHandler(request, reply, config);
    },
  );

  app.delete("/api/files/:id", { constraints: { host: filesHost } }, async (request, reply) => {
    await deleteFileHandler(request, reply, config);
  });
}
