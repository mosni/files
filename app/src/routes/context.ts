// D-63: the client-side island probe. The preview page renders identically for everyone (anonymous-
// shaped), so crawlers always unfurl and the output stays cacheable; a small inline script in the
// rendered page then calls this endpoint with the viewer's Bearer token to learn their rights.
// E5a ships the mechanism only - no island hydrates on the answer yet (that is E5's).

import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import { claimsFromBearer } from "../auth/bearer.ts";
import { can } from "../lib/roles.ts";
import { resolveByToken } from "../storage/files.ts";

export async function registerContextRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const filesHost = new URL(config.appOrigin).hostname;

  app.get("/api/f/:token/context", { constraints: { host: filesHost } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const record = await resolveByToken(token);
    if (record === null) {
      reply.code(404).send();
      return;
    }

    const claims = await claimsFromBearer(request, config.appOrigin);
    const isOwner = claims !== null && record.ownerSub !== null && claims.sub === record.ownerSub;
    const isAdmin = claims !== null && can(claims, "files:admin");
    // files:write only grants managing one's OWN files (D-22) - a non-owner needs files:admin, not just
    // files:write, to edit someone else's file.
    const canEdit = isOwner || isAdmin;
    const canDelete = isOwner || isAdmin || (claims !== null && can(claims, "files:delete"));

    reply.send({ canEdit, canDelete });
  });
}
