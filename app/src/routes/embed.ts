// files.mosni.dev embed route (E5 Wave H, D-140). Thin: host-constrained registration handing off to
// controllers/embed.ts.
//   /embed/f/*   the embeddable video-player document by plain path (no /embed/t/:token - see embed.ts's
//                header comment for why a token shape has no legitimate case here)

import type { FastifyInstance } from "fastify";
import type { Config } from "../config.ts";
import { embedByPath } from "../controllers/embed.ts";

export async function registerEmbedRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const filesHost = new URL(config.appOrigin).hostname;

  app.get("/embed/f/*", { constraints: { host: filesHost } }, async (request, reply) => {
    const relPath = (request.params as Record<string, string>)["*"];
    await embedByPath(request, reply, config, relPath);
  });
}
