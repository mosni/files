// The upload logic (preliminary-review P2: controllers hold the logic, routes/upload.ts holds only the
// Fastify/tus plumbing). This builds the @tus/server whose hooks authorize every request and commit a
// finished upload to disk.

import path from "node:path";
import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import type http from "node:http";
import { Server as TusServer } from "@tus/server";
import { FileStore } from "@tus/file-store";
import type { Config } from "../config.ts";
import { verify } from "../auth/verify.ts";
import { can, type Claims } from "../lib/roles.ts";
import { isIgnoredEntry, resolveRelPath, safeSegment, suffixForCollision } from "../lib/paths.ts";
import { buildFileUrls } from "../lib/fileUrls.ts";
import { insertUploadedFile } from "../storage/files.ts";
import { stripInPlace } from "../storage/strip.ts";
import { emitAuditEvent } from "../storage/audit.ts";

// auth's token carries an optional `name` claim, used as the upload folder name - not part of
// lib/roles.ts's Claims (which models only what can() needs).
type VerifiedClaims = Claims & { name?: unknown };

interface RequestWithClaims extends http.IncomingMessage {
  filesClaims?: VerifiedClaims;
}

// dl.mosni.dev/t/<token> is the token delivery route, so a top-level folder literally named "t" would
// shadow single-file token URLs. It is the one reserved top-level name (preliminary-review P6 collapsed
// the old five-name reserved set to this).
const RESERVED_ROOTS = new Set(["t"]);

// tus errors: throwing an object shaped like this from a hook makes @tus/server's own error handler send
// exactly this status/body (confirmed by reading its Server.handle() onError, which reads
// `error.status_code`/`error.body`).
function tusError(status_code: number, body: string): never {
  // eslint-disable-next-line @typescript-eslint/no-throw-literal
  throw { status_code, body: `${body}\n` };
}

function bearerToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  return typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

// The uploader's folder: their `name` claim if safe, else a segment derived from their `sub`. NOTE
// (session 007, flagged for E4): two users sharing a `name` share a folder, and `unlisted` files resolve
// at their readable path for anyone - so co-mingled unlisted files are mutually reachable by path-guess.
// Acceptable for the current small trusted user base; folder-level ownership returns with E4 browsing.
function deriveFolder(claims: VerifiedClaims): string | null {
  const fromName = typeof claims.name === "string" ? safeSegment(claims.name) : null;
  const folder = fromName ?? safeSegment(claims.sub);
  if (folder === null) return null;
  return RESERVED_ROOTS.has(folder) ? `${folder}-files` : folder;
}

export function buildTusServer(config: Config): TusServer {
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

    // The commit path, run on the request that completes the upload.
    onUploadFinish: async (req, res, upload) => {
      const claims = (req as RequestWithClaims).filesClaims;
      // Defensive only - onIncomingRequest always runs first for this same request.
      if (claims === undefined) tusError(401, "missing verified claims");

      const clientFilename = upload.metadata?.filename ?? upload.id;
      const safeName = safeSegment(clientFilename);
      const tempPath = upload.storage?.path ?? path.join(config.tusTempDir, upload.id);
      if (safeName === null) {
        await unlink(tempPath).catch(() => {});
        tusError(400, "unsafe filename");
      }

      const folder = deriveFolder(claims);
      if (folder === null) {
        await unlink(tempPath).catch(() => {});
        tusError(400, "could not derive a safe upload folder");
      }

      const folderDir = path.join(config.storageRoot, folder);
      await mkdir(folderDir, { recursive: true });
      const existingEntries = await readdir(folderDir).catch(() => []);
      const taken = existingEntries.filter((entry) => !isIgnoredEntry(entry));
      const finalName = suffixForCollision(safeName, taken);
      const relPath = `${folder}/${finalName}`;
      const finalPath = resolveRelPath(config.storageRoot, relPath);
      if (finalPath === null) {
        await unlink(tempPath).catch(() => {});
        tusError(400, "unsafe destination path");
      }

      // Same filesystem (tusTempDir lives inside storageRoot, config.ts) - atomic.
      await rename(tempPath, finalPath);

      try {
        // Strip metadata on upload (preliminary-review P8). D-60: an unstripped original is never stored,
        // including not leaving one lying around after a failed strip.
        await stripInPlace(finalPath);
      } catch (err) {
        await unlink(finalPath).catch(() => {});
        console.error(`upload: stripInPlace failed for ${finalPath} - upload rejected`, err);
        tusError(422, "could not verify the upload is safe to store");
      }

      const { size } = await stat(finalPath);
      const record = await insertUploadedFile({
        path: relPath,
        bytes: size,
        protection: "unlisted", // D-59 default
        ownerSub: claims.sub,
        uploaderSub: claims.sub,
      });

      // Fire-and-forget (D-43) - never awaited, a dead bot must not break or delay the upload response.
      emitAuditEvent({
        action: "upload",
        actor: claims.sub,
        target: finalName,
        protection: record.protection,
        bytes: size,
        collection: folder,
      });

      const urls = buildFileUrls(config, record.protection, relPath, record.linkToken);
      return {
        res,
        // The tus PATCH response is 204, and Node's http.ServerResponse drops any body on a 204 at the
        // runtime level - returning the result URLs requires overriding to 200 (which @tus/server's own
        // onUploadFinish doc comment anticipates).
        status_code: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(urls),
      };
    },
  });
}
