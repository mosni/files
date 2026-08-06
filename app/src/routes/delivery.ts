// dl.mosni.dev routes (preliminary-review P2/P6, D-84, D-137). Thin: registers the host-constrained routes
// and hands off to controllers/delivery.ts. The host constraint means only these delivery shapes are
// reachable on dl. even though it is the same process as files. (D-33 containment).
//   /s/:id       D-84 signed delivery (the only way a `private` file's bytes reach its own preview)
//   /t/:token    token delivery (the only way to reach a `secret` file's bytes)
//   /thumb/s/:id D-137 signed thumbnail delivery (a `private` file's thumbnail, same signature as /s/:id)
//   /thumb/t/:token  thumbnail token delivery
//   /thumb/*     plain-path thumbnail delivery, resolved through the database by display name
//   /*           plain path delivery, resolved through the database by display name
//
// The /thumb/* routes must be registered so find-my-way ranks their static "thumb" prefix above the bare
// `/*` wildcard - confirmed by the existing `/s/:id` and `/t/:token` static routes already doing exactly
// this (session 010's find-my-way ranking note in technical-baseline.md §5 applies here too).

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import {
  deliverByPath,
  deliverByToken,
  deliverSigned,
  deliverThumbByPath,
  deliverThumbByToken,
  deliverThumbSigned,
} from "../controllers/delivery.ts";

// E6 A3b (D-180): delivery used to inherit the global 100/min limiter, which is why a listing page with
// >100 thumbnail rows and a >100-file "Download all" each rate-limited themselves (E5-DELIVERY-RATE-LIMIT).
//
// ⚠ Keyed on the IP, NOT the bearer header (unlike upload/manage) - delivery is largely anonymous (an
// anonymous holder of a `secret` collection link downloading it is exactly the case that must not be
// throttled into a broken archive), so there is often no bearer to key on at all. Copying upload's
// bearer-keyed generator here would collapse every anonymous visitor onto ONE shared budget - the same
// defect session 010 found when trustProxy was off. trustProxy is on now (server.ts), so request.ip is
// the real client.
//
// ⚠ Per-route `config.rateLimit`, never a nested `register(rateLimit, …)` scope - see the long note in
// routes/manage.ts for why a nested registration silently leaves the global 100/min cap in force.
const deliveryRateLimit = {
  max: 600,
  timeWindow: "1 minute",
  keyGenerator: (request: FastifyRequest) => request.ip,
};

export async function registerDeliveryRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const dlHost = new URL(config.dlOrigin).hostname;
  const routeOpts = { constraints: { host: dlHost }, config: { rateLimit: deliveryRateLimit } };

  app.get("/s/:id", routeOpts, async (request, reply) => {
    const { id } = request.params as { id: string };
    await deliverSigned(request, reply, config, id, request.query as { exp?: string; sig?: string });
  });

  app.get("/t/:token", routeOpts, async (request, reply) => {
    const { token } = request.params as { token: string };
    await deliverByToken(request, reply, config, token);
  });

  app.get("/thumb/s/:id", routeOpts, async (request, reply) => {
    const { id } = request.params as { id: string };
    await deliverThumbSigned(request, reply, config, id, request.query as { exp?: string; sig?: string });
  });

  app.get("/thumb/t/:token", routeOpts, async (request, reply) => {
    const { token } = request.params as { token: string };
    await deliverThumbByToken(request, reply, config, token);
  });

  app.get("/thumb/*", routeOpts, async (request, reply) => {
    const relPath = (request.params as Record<string, string>)["*"];
    await deliverThumbByPath(request, reply, config, relPath);
  });

  app.get("/*", routeOpts, async (request, reply) => {
    const relPath = (request.params as Record<string, string>)["*"];
    await deliverByPath(request, reply, config, relPath);
  });
}
