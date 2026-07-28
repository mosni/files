// dl.mosni.dev routes (preliminary-review P2/P6, D-84). Thin: registers the host-constrained routes and
// hands off to controllers/delivery.ts. The host constraint means only these delivery shapes are
// reachable on dl. even though it is the same process as files. (D-33 containment).
//   /s/:id      D-84 signed delivery (the only way a `private` file's bytes reach its own preview)
//   /t/:token   token delivery (the only way to reach a `secret` file's bytes)
//   /*          plain path delivery, resolved through the database by display name

import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import { deliverByPath, deliverByToken, deliverSigned } from "../controllers/delivery.ts";

export async function registerDeliveryRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const dlHost = new URL(config.dlOrigin).hostname;

  app.get("/s/:id", { constraints: { host: dlHost } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await deliverSigned(request, reply, config, id, request.query as { exp?: string; sig?: string });
  });

  app.get("/t/:token", { constraints: { host: dlHost } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    await deliverByToken(request, reply, config, token);
  });

  app.get("/*", { constraints: { host: dlHost } }, async (request, reply) => {
    const relPath = (request.params as Record<string, string>)["*"];
    await deliverByPath(request, reply, config, relPath);
  });
}
