// dl.mosni.dev routes (preliminary-review P2/P6). Thin: registers the host-constrained routes and hands
// off to controllers/delivery.ts. The host constraint means only these delivery shapes are reachable on
// dl. even though it is the same process as files. (D-33 containment).
//   /t/:token   token delivery (the only way to reach a `secret` file's bytes)
//   /*          plain path delivery, the URL mirroring the on-disk relative path

import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import { deliverByPath, deliverByToken } from "../controllers/delivery.ts";

export async function registerDeliveryRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const dlHost = new URL(config.dlOrigin).hostname;

  app.get("/t/:token", { constraints: { host: dlHost } }, async (request, reply) => {
    const { token } = request.params as { token: string };
    await deliverByToken(request, reply, config, token);
  });

  app.get("/*", { constraints: { host: dlHost } }, async (request, reply) => {
    const relPath = (request.params as Record<string, string>)["*"];
    await deliverByPath(request, reply, config, relPath);
  });
}
