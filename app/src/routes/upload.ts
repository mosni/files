// D-19: tus resumable uploads. Mounted at /api/upload in its own encapsulated Fastify scope so the
// dedicated 600/min rate limit (D1) never touches the global 100/min limit that protects everything else.
//
// @tus/server speaks raw node:http (http.IncomingMessage/ServerResponse), not Fastify's request/reply
// abstraction - the bridge is reply.hijack() (tell Fastify not to touch the response itself) plus handing
// the raw req/res straight to tusServer.handle(). A catch-all content-type parser bypass is required too,
// since Fastify's default JSON parser would otherwise consume the request body stream before tus can
// read it itself.

import path from "node:path";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest, RouteHandlerMethod } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { Server as TusServer } from "@tus/server";
import { FileStore } from "@tus/file-store";
import type { Redis } from "ioredis";
import type http from "node:http";
import type { Config } from "../config.ts";
import { verify } from "../auth/verify.ts";
import { can, type Claims } from "../lib/roles.ts";
import { isIgnoredEntry, safeSegment, suffixForCollision } from "../lib/paths.ts";
import { readablePathResolves, type Protection } from "../lib/protection.ts";
import { getOrCreateDefaultCollection } from "../storage/collections.ts";
import { insertUploadedFile } from "../storage/files.ts";
import { stripInPlace } from "../storage/strip.ts";
import { emitAuditEvent } from "../storage/audit.ts";

// tus's hook signatures don't thread custom state between onIncomingRequest and onUploadFinish, but both
// are called with the *same* underlying http.IncomingMessage for a given HTTP request, so stashing the
// claims verified in onIncomingRequest here avoids re-verifying (and re-hitting auth's JWKS endpoint) in
// onUploadFinish for the same request.
// D-58: auth's token carries an optional `name` claim, used as the preferred default-collection name -
// not part of lib/roles.ts's Claims (which only models what can() needs for role checks).
type VerifiedClaims = Claims & { name?: unknown };

interface RequestWithClaims extends http.IncomingMessage {
  filesClaims?: VerifiedClaims;
}

// tus errors: throwing an object shaped like this from a hook makes @tus/server's own error handler send
// exactly this status/body to the client (confirmed by reading @tus/server's Server.handle() - its
// onError reads `error.status_code`/`error.body`, matching @tus/utils' own ERRORS sentinels).
function tusError(status_code: number, body: string): never {
  // eslint-disable-next-line @typescript-eslint/no-throw-literal
  throw { status_code, body: `${body}\n` };
}

function bearerToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  return typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

function buildResultUrls(
  config: Config,
  protection: Protection,
  collectionName: string,
  fileName: string,
  linkToken: string,
): { previewUrl: string; directUrl: string } {
  const readable = readablePathResolves(protection);
  const previewPath = readable
    ? `/${encodeURIComponent(collectionName)}/${encodeURIComponent(fileName)}`
    : `/f/${linkToken}`;
  const directPath = readable
    ? `/${encodeURIComponent(collectionName)}/${encodeURIComponent(fileName)}`
    : `/${linkToken}`;
  return {
    previewUrl: `${config.appOrigin}${previewPath}`,
    directUrl: `${config.dlOrigin}${directPath}`,
  };
}

function buildTusServer(config: Config): TusServer {
  return new TusServer({
    path: "/api/upload",
    datastore: new FileStore({ directory: config.tusTempDir }),

    // Runs on every tus request (create, each PATCH chunk, head, delete) - there is no anonymous upload.
    onIncomingRequest: async (req) => {
      const token = bearerToken(req);
      if (token === null) tusError(401, "missing bearer token");

      let claims: VerifiedClaims;
      try {
        claims = (await verify(token, config.appOrigin)) as unknown as VerifiedClaims;
      } catch {
        tusError(401, "invalid token");
      }
      if (!can(claims, "files:write")) tusError(403, "files:write required");
      (req as RequestWithClaims).filesClaims = claims;
    },

    // The commit path (D2), run on the request that completes the upload.
    onUploadFinish: async (req, res, upload) => {
      const claims = (req as RequestWithClaims).filesClaims;
      // Defensive only - onIncomingRequest always runs first for this same request per @tus/server's
      // handler chain, so this should be unreachable in practice.
      if (claims === undefined) tusError(401, "missing verified claims");

      const clientFilename = upload.metadata?.filename ?? upload.id;
      const safeName = safeSegment(clientFilename);
      const tempPath = upload.storage?.path ?? path.join(config.tusTempDir, upload.id);
      if (safeName === null) {
        await unlink(tempPath).catch(() => {});
        tusError(400, "unsafe filename");
      }

      const preferredName = typeof claims.name === "string" ? claims.name : undefined;
      const collection = await getOrCreateDefaultCollection(claims.sub, preferredName);

      const collectionDir = path.join(config.storageRoot, collection.name);
      await mkdir(collectionDir, { recursive: true });
      const existingEntries = await readdir(collectionDir).catch(() => []);
      const taken = existingEntries.filter((entry) => !isIgnoredEntry(entry));
      const finalName = suffixForCollision(safeName, taken);
      const finalPath = path.join(collectionDir, finalName);

      // Same filesystem (tusTempDir lives inside storageRoot, config.ts) - atomic.
      await rename(tempPath, finalPath);

      try {
        await stripInPlace(finalPath);
      } catch (err) {
        // D-60: an unstripped original is never stored, including not leaving one lying around after a
        // failed strip attempt.
        await unlink(finalPath).catch(() => {});
        console.error(`upload: stripInPlace failed for ${finalPath} - upload rejected`, err);
        tusError(422, "could not verify the upload is safe to store");
      }

      const { size } = await stat(finalPath);
      const record = await insertUploadedFile(collection, finalName, size, claims.sub);

      // Fire-and-forget (D-43) - never awaited, a dead bot must not break or delay the upload response.
      emitAuditEvent({
        action: "upload",
        actor: claims.sub,
        target: finalName,
        protection: record.protection,
        bytes: size,
        collection: collection.name,
      });

      const urls = buildResultUrls(config, record.protection, collection.name, finalName, record.linkToken);
      return {
        res,
        // The tus spec's PATCH response is 204, and 204 responses MUST NOT carry a body - Node's
        // http.ServerResponse enforces this at the runtime level (confirmed empirically: it silently
        // drops any body written alongside a 204, regardless of what @tus/server passes to res.write()).
        // Returning the two result URLs therefore requires overriding the status code, exactly as
        // @tus/server's own onUploadFinish doc comment anticipates ("most clients support" a body on a
        // non-204 completion response).
        status_code: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(urls),
      };
    },
  });
}

export async function registerUploadRoutes(app: FastifyInstance, config: Config, redis: Redis): Promise<void> {
  const tusServer = buildTusServer(config);

  await app.register(async (scoped) => {
    // Dedicated rate limiter (D1): a 5 GB upload at 5 MB chunks is ~1000 PATCH requests, which the
    // global 100/min limit would break. Keyed on the raw bearer header (cheap) rather than the verified
    // sub, so this hook never has to run JWT verification itself - onIncomingRequest is the one and only
    // place that happens, since it runs on every tus request anyway.
    await scoped.register(rateLimit, {
      redis,
      global: true,
      max: 600,
      timeWindow: "1 minute",
      keyGenerator: (request: FastifyRequest) => {
        const auth = request.headers.authorization;
        return typeof auth === "string" ? auth : request.ip;
      },
    });

    // tus needs the raw, unconsumed request body stream - bypass Fastify's default body parsers entirely
    // for this scope.
    scoped.addContentTypeParser("*", (_request, _payload, done) => done(null));

    const handleTus: RouteHandlerMethod = async (request, reply) => {
      reply.hijack();
      await tusServer.handle(request.raw, reply.raw);
    };
    scoped.all("/api/upload", handleTus);
    scoped.all("/api/upload/*", handleTus);
  });
}
