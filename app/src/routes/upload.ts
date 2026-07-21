// tus resumable uploads (D-19). Thin: the upload logic is in controllers/upload.ts; this file is only the
// Fastify/tus plumbing. Mounted at /api/upload in its own encapsulated scope so the dedicated rate limit
// never touches the global one.
//
// @tus/server speaks raw node:http, not Fastify's request/reply - the bridge is reply.hijack() plus
// handing the raw req/res to tusServer.handle(). A catch-all content-type parser bypass is required too,
// or Fastify's default JSON parser consumes the body stream before tus can read it.

import type { FastifyInstance, FastifyRequest, RouteHandlerMethod } from "fastify";
import rateLimit from "@fastify/rate-limit";
import type { Redis } from "ioredis";
import type { Config } from "../config.ts";
import { buildTusServer } from "../controllers/upload.ts";
import { UPLOAD_CHUNK_SIZE } from "../lib/uploadConfig.ts";

export async function registerUploadRoutes(app: FastifyInstance, config: Config, redis: Redis): Promise<void> {
  const tusServer = buildTusServer(config);

  await app.register(async (scoped) => {
    // Dedicated rate limiter: a 5 GB upload at UPLOAD_CHUNK_SIZE (lib/uploadConfig.ts) chunks is ~1000
    // PATCH requests, which the global 100/min limit would break. Keyed on the raw bearer header (cheap)
    // rather than the verified sub, so this hook never runs JWT verification - the tus onIncomingRequest
    // hook is the one place that happens. The `max` is budgeted against UPLOAD_CHUNK_SIZE: a smaller chunk
    // size means more PATCHes, so that constant and this number move together (preliminary-review P10).
    void UPLOAD_CHUNK_SIZE;
    await scoped.register(rateLimit, {
      redis,
      global: true,
      max: 600,
      timeWindow: "1 minute",
      // Distinct nameSpace so this never shares a Redis key with the global limiter (server.ts) -
      // @fastify/rate-limit's default key is IP-only with no per-registration isolation otherwise.
      nameSpace: "fastify-rate-limit-upload-",
      keyGenerator: (request: FastifyRequest) => {
        const auth = request.headers.authorization;
        return typeof auth === "string" ? auth : request.ip;
      },
    });

    // tus needs the raw, unconsumed request body stream - bypass Fastify's default body parsers.
    scoped.addContentTypeParser("*", (_request, _payload, done) => done(null));

    const handleTus: RouteHandlerMethod = async (request, reply) => {
      reply.hijack();
      await tusServer.handle(request.raw, reply.raw);
    };
    scoped.all("/api/upload", handleTus);
    scoped.all("/api/upload/*", handleTus);
  });
}
