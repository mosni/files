// The management API (§1.5 of the E3 waves hand-off) - rename/delete for files and collections,
// protection-level changes, collection creation/listing. Host-constrained to files.mosni.dev (D-33: no
// app surface on dl.), registered alongside the other route modules in server.ts. Thin: schema validation
// plus handing off to controllers/manage.ts.

import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";
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
      protection: { type: "string", enum: PROTECTION_ENUM },
      defaultProtection: { type: "string", enum: PROTECTION_ENUM },
      // C3 (E4.1 live-testing findings, Wave C): move. Fastify's default AJV config sets
      // removeAdditional: true, so a field missing from `properties` is silently STRIPPED before the
      // handler ever sees it (not rejected) - "" (the root) must be an allowed value, so no minLength.
      parentId: { type: "string" },
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
      // C2 (E4.1 live-testing findings, Wave C): move - see updateCollectionSchema's parentId comment.
      collectionId: { type: "string" },
    },
    additionalProperties: false,
  },
};

export async function registerManageRoutes(app: FastifyInstance, config: Config, redis: Redis): Promise<void> {
  const filesHost = new URL(config.appOrigin).hostname;

  // E6 A3 (D-180): the management API used to share the global 100/min limiter - a folder drop's own
  // collection-creation calls (E6 Wave E) could exhaust it on their own before any actual upload even
  // started. A dedicated, encapsulated scope with its own rate limiter, mirroring routes/upload.ts's shape
  // exactly. 300/min is budgeted against a folder drop: MAX_FOLDER_DEPTH-deep trees create tens of
  // collections in practice, and grouping (Wave C) adds one PATCH /api/files/:id per file.
  await app.register(async (scoped) => {
    await scoped.register(rateLimit, {
      redis,
      global: true,
      max: 300,
      timeWindow: "1 minute",
      // The distinct nameSpace is load-bearing (same trap session 007 already fixed for upload) -
      // @fastify/rate-limit's default Redis key is IP-only with no per-registration isolation.
      nameSpace: "fastify-rate-limit-write-",
      // Keyed on the bearer header, like upload's - one user's big folder drop cannot exhaust another's
      // budget.
      keyGenerator: (request: FastifyRequest) => request.headers.authorization ?? request.ip,
    });

    scoped.get("/api/collections", { constraints: { host: filesHost } }, async (request, reply) => {
      await listCollections(request, reply, config);
    });

    scoped.post(
      "/api/collections",
      { constraints: { host: filesHost }, schema: createCollectionSchema },
      async (request, reply) => {
        await createCollectionHandler(request, reply, config);
      },
    );

    scoped.patch(
      "/api/collections/:id",
      { constraints: { host: filesHost }, schema: updateCollectionSchema },
      async (request, reply) => {
        await updateCollectionHandler(request, reply, config);
      },
    );

    scoped.delete("/api/collections/:id", { constraints: { host: filesHost } }, async (request, reply) => {
      await deleteCollectionHandler(request, reply, config);
    });

    scoped.patch(
      "/api/files/:id",
      { constraints: { host: filesHost }, schema: updateFileSchema },
      async (request, reply) => {
        await updateFileHandler(request, reply, config);
      },
    );

    scoped.delete("/api/files/:id", { constraints: { host: filesHost } }, async (request, reply) => {
      await deleteFileHandler(request, reply, config);
    });
  });
}
