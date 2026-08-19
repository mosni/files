// E8 (D-217 … D-221): the admin API - GET /api/admin/grants, POST /api/admin/grants/revoke,
// GET /api/admin/usage. Modelled on routes/share.ts: files.mosni.dev-only (D-33: no app surface on dl.),
// thin schema validation handing off to controllers/admin.ts. Every mutating route carries
// `config: { rateLimit: writeRateLimit }` ON THE ROUTE, never a nested `register(rateLimit, …)` scope
// (review session 042's landmine - a nested registration ADDS a second limiter instead of replacing the
// global one, and the stricter wins).

import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import { writeRateLimit } from "./manage.ts";
import { getSpaShell } from "../storage/spaShell.ts";
import { adminGate, listGrantsHandler, revokeGrantHandler, usageHandler } from "../controllers/admin.ts";

const revokeGrantSchema = {
  body: {
    type: "object",
    required: ["targetType", "targetId", "sub"],
    properties: {
      targetType: { type: "string", enum: ["file", "collection"] },
      targetId: { type: "string", minLength: 1 },
      sub: { type: "string", minLength: 1 },
    },
    additionalProperties: false,
  },
};

export async function registerAdminRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const filesHost = new URL(config.appOrigin).hostname;
  // D-217's gate, as an onRequest hook so it answers before Fastify parses or validates the body - see
  // controllers/admin.ts for the measurement that made this a hook rather than a call inside each handler.
  // Attached per route: registerAdminRoutes is handed the ROOT instance (no encapsulating scope), so
  // app.addHook here would gate the whole application.
  const gate = adminGate(config);

  // D3.1's route is a client-only React Router entry with no matching physical file, unlike "/" (served
  // by @fastify/static's index.html) and "/f/*"/"/t/:token" (registerPreviewRoutes' real server routes) -
  // without a server-side route to serve the SPA shell, a hard navigation/reload at /admin never reaches
  // the SPA at all and falls straight through to server.ts's setNotFoundHandler (the real 404 page).
  // Unguarded, exactly like "/" itself: the gate is client-side rendering plus the API's 404 above, never
  // this shell (D-217's reveal-nothing is about the DATA, not the empty page frame every visitor gets).
  app.get("/admin", { constraints: { host: filesHost } }, async (_request, reply) => {
    reply.type("text/html; charset=utf-8").send(getSpaShell());
  });

  // The two GETs take the global limiter (no config.rateLimit override) - only the mutating POST below
  // needs the stricter write budget.
  app.get(
    "/api/admin/grants",
    { constraints: { host: filesHost }, onRequest: gate },
    async (request, reply) => {
      await listGrantsHandler(request, reply);
    },
  );

  app.post(
    "/api/admin/grants/revoke",
    { constraints: { host: filesHost }, schema: revokeGrantSchema, config: { rateLimit: writeRateLimit }, onRequest: gate },
    async (request, reply) => {
      await revokeGrantHandler(request, reply);
    },
  );

  app.get(
    "/api/admin/usage",
    { constraints: { host: filesHost }, onRequest: gate },
    async (request, reply) => {
      await usageHandler(request, reply, config);
    },
  );
}
