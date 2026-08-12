// The management API (§1.5 of the E3 waves hand-off) - rename/delete for files and collections,
// protection-level changes, collection creation/listing. Host-constrained to files.mosni.dev (D-33: no
// app surface on dl.), registered alongside the other route modules in server.ts. Thin: schema validation
// plus handing off to controllers/manage.ts.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import {
  createCollectionHandler,
  deleteCollectionHandler,
  deleteFileHandler,
  listCollections,
  moveFilesHandler,
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

// Live-testing addition (2026-08-06): the batch move behind grouped-upload notifications. `collectionId`
// has no minLength - "" is the root and must be an allowed value, same note as updateCollectionSchema's
// parentId. maxItems bounds the work one request can ask for; it is comfortably above D-176's own
// 20,000-entry folder-walk ceiling being split across batches by the client rather than a limit a real
// grouped upload can hit.
const moveFilesSchema = {
  body: {
    type: "object",
    required: ["ids", "collectionId"],
    properties: {
      ids: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
        maxItems: 1000,
      },
      collectionId: { type: "string" },
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

// E6 A3 (D-180): the management API used to share the global 100/min limiter - a folder drop's own
// collection-creation calls (E6 Wave E) could exhaust it on their own before any actual upload even
// started. 300/min is budgeted against a folder drop: MAX_FOLDER_DEPTH-deep trees create tens of
// collections in practice, and grouping (Wave C) adds one PATCH /api/files/:id per file. Keyed on the
// bearer header so one user's big folder drop cannot exhaust another's budget.
//
// ⚠ This is a PER-ROUTE `config.rateLimit`, NOT a nested `register(rateLimit, …)` scope, and the
// difference is load-bearing - measured, not assumed (E6 review session 042). @fastify/rate-limit
// attaches its limiter through an `onRoute` hook, and an onRoute hook added on the ROOT instance fires
// for every route in the tree, encapsulated child scopes included. A nested registration therefore does
// not REPLACE the global limiter for its routes, it ADDS a second one - and the strictest wins, so the
// global 100/min still capped every management call (first 429 at request #101, against a server wired
// exactly like server.ts). A route that carries its own `config.rateLimit` is the one shape the plugin
// treats as an override: the root's onRoute sees it and attaches that limiter INSTEAD of the global one,
// with its own Redis key (`<nameSpace><METHOD><url>-`), so the budgets are genuinely separate.
export const writeRateLimit = {
  max: 300,
  timeWindow: "1 minute",
  keyGenerator: (request: FastifyRequest) => request.headers.authorization ?? request.ip,
};

export async function registerManageRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const filesHost = new URL(config.appOrigin).hostname;

  app.get(
    "/api/collections",
    { constraints: { host: filesHost }, config: { rateLimit: writeRateLimit } },
    async (request, reply) => {
      await listCollections(request, reply, config);
    },
  );

  app.post(
    "/api/collections",
    { constraints: { host: filesHost }, schema: createCollectionSchema, config: { rateLimit: writeRateLimit } },
    async (request, reply) => {
      await createCollectionHandler(request, reply, config);
    },
  );

  app.patch(
    "/api/collections/:id",
    { constraints: { host: filesHost }, schema: updateCollectionSchema, config: { rateLimit: writeRateLimit } },
    async (request, reply) => {
      await updateCollectionHandler(request, reply, config);
    },
  );

  app.delete(
    "/api/collections/:id",
    { constraints: { host: filesHost }, config: { rateLimit: writeRateLimit } },
    async (request, reply) => {
      await deleteCollectionHandler(request, reply, config);
    },
  );

  // Registered before the parametric `/api/files/:id` for readability only - find-my-way ranks a static
  // path above a parametric one regardless of registration order, so `/api/files` can never be swallowed
  // by `:id` (the same precedence this repo already relies on for `/t/:token` vs `/*` in routes/delivery).
  app.patch(
    "/api/files",
    { constraints: { host: filesHost }, schema: moveFilesSchema, config: { rateLimit: writeRateLimit } },
    async (request, reply) => {
      await moveFilesHandler(request, reply, config);
    },
  );

  app.patch(
    "/api/files/:id",
    { constraints: { host: filesHost }, schema: updateFileSchema, config: { rateLimit: writeRateLimit } },
    async (request, reply) => {
      await updateFileHandler(request, reply, config);
    },
  );

  app.delete(
    "/api/files/:id",
    { constraints: { host: filesHost }, config: { rateLimit: writeRateLimit } },
    async (request, reply) => {
      await deleteFileHandler(request, reply, config);
    },
  );
}
