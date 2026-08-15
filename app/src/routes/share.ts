// E7 (§1.4 of the waves hand-off): the share API - files.mosni.dev-only (D-33: no app surface on dl.),
// registered alongside the other route modules in server.ts. Thin: schema validation plus handing off to
// controllers/share.ts. Every route carries `config: { rateLimit: writeRateLimit }` ON THE ROUTE, never a
// nested `register(rateLimit, …)` scope (review session 042's landmine - a nested registration ADDS a
// second limiter instead of replacing the global one, and the stricter wins).

import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import { writeRateLimit } from "./manage.ts";
import {
  createInviteHandler,
  getAccountsHandler,
  getSharesHandler,
  grantShareHandler,
  revokeShareHandler,
} from "../controllers/share.ts";

const SHARE_TYPE_ENUM = ["file", "collection"] as const;

const getSharesSchema = {
  querystring: {
    type: "object",
    required: ["type", "id"],
    properties: {
      type: { type: "string", enum: SHARE_TYPE_ENUM },
      id: { type: "string", minLength: 1 },
    },
    additionalProperties: false,
  },
};

const grantShareSchema = {
  body: {
    type: "object",
    required: ["type", "id", "sub"],
    properties: {
      type: { type: "string", enum: SHARE_TYPE_ENUM },
      id: { type: "string", minLength: 1 },
      sub: { type: "string", minLength: 1 },
      canUpload: { type: "boolean" },
    },
    additionalProperties: false,
  },
};

const revokeShareSchema = {
  body: {
    type: "object",
    required: ["type", "id", "sub"],
    properties: {
      type: { type: "string", enum: SHARE_TYPE_ENUM },
      id: { type: "string", minLength: 1 },
      sub: { type: "string", minLength: 1 },
    },
    additionalProperties: false,
  },
};

const createInviteSchema = {
  body: {
    type: "object",
    required: ["type", "id"],
    properties: {
      type: { type: "string", enum: SHARE_TYPE_ENUM },
      id: { type: "string", minLength: 1 },
      canUpload: { type: "boolean" },
      // E7-QA1 §B1.7/D-198: the upgradeable switch. Optional - the controller defaults to true, matching
      // the dialog's own default-on state.
      allow_register: { type: "boolean" },
      // E7-QA2 §A2: optional - absent means the controller's default (1h, D-205). Fastify's AJV runs with
      // removeAdditional: true, so without this line the field is silently STRIPPED, not rejected, and
      // the whole round appears to no-op.
      ttl_seconds: { type: "integer" },
    },
    additionalProperties: false,
  },
};

export async function registerShareRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const filesHost = new URL(config.appOrigin).hostname;

  app.get(
    "/api/accounts",
    { constraints: { host: filesHost }, config: { rateLimit: writeRateLimit } },
    async (request, reply) => {
      await getAccountsHandler(request, reply, config);
    },
  );

  app.get(
    "/api/shares",
    { constraints: { host: filesHost }, schema: getSharesSchema, config: { rateLimit: writeRateLimit } },
    async (request, reply) => {
      await getSharesHandler(request, reply, config);
    },
  );

  app.post(
    "/api/shares",
    { constraints: { host: filesHost }, schema: grantShareSchema, config: { rateLimit: writeRateLimit } },
    async (request, reply) => {
      await grantShareHandler(request, reply, config);
    },
  );

  // A JSON body on DELETE is a Fastify trap nobody needs here, and a sub contains a `:` (invariant 6,
  // opaque) - putting it in a path segment invites encoding bugs and tempts a future reader into parsing
  // it. POST + a body keeps it a single opaque string end to end.
  app.post(
    "/api/shares/revoke",
    { constraints: { host: filesHost }, schema: revokeShareSchema, config: { rateLimit: writeRateLimit } },
    async (request, reply) => {
      await revokeShareHandler(request, reply, config);
    },
  );

  app.post(
    "/api/invites",
    { constraints: { host: filesHost }, schema: createInviteSchema, config: { rateLimit: writeRateLimit } },
    async (request, reply) => {
      await createInviteHandler(request, reply, config);
    },
  );
}
