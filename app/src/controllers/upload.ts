// The upload logic (preliminary-review P2: controllers hold the logic, routes/upload.ts holds only the
// Fastify/tus plumbing). This builds the @tus/server whose hooks authorize every request and commit a
// finished upload to disk.
//
// D-85: the commit is insert-then-move, guarded by the `files.state` column. A `pending` row is claimed
// (fresh id, disk location decided) BEFORE anything touches the filesystem; only once the bytes are
// safely in their final place and stripped/probed does the row flip to `committed`. Any failure in
// between abandons the row and unlinks whatever bytes were moved - safe precisely because the id-prefixed
// disk name belongs to this upload alone (closes the old KNOWN RACE and session 010's orphan-on-
// insert-failure together).

import path from "node:path";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import type http from "node:http";
import { Server as TusServer } from "@tus/server";
import { FileStore } from "@tus/file-store";
import type { Config } from "../config.ts";
import { verify } from "../auth/verify.ts";
import { can, type VerifiedClaims } from "../lib/roles.ts";
import { isReservedRootName, resolveRelPath, safeSegment } from "../lib/paths.ts";
import { buildFileUrls } from "../lib/fileUrls.ts";
import { generateId } from "../lib/ids.ts";
import { actorLabel } from "../lib/audit.ts";
import type { Protection } from "../lib/protection.ts";
import { thumbnailApplies } from "../lib/thumbs.ts";
import { UPLOAD_EXPIRY_MS } from "../lib/uploadConfig.ts";
import {
  abandonFileRow,
  claimFileRow,
  commitFileRow,
  currentDiskDir,
  diskRelPath,
  resolveEffective,
} from "../storage/files.ts";
import { canUploadTo, collectionPath, resolveCollectionById } from "../storage/collections.ts";
import { stripInPlace } from "../storage/strip.ts";
import { probeMedia } from "../storage/probe.ts";
import { generateThumb } from "../storage/thumbs.ts";
import { emitAuditEvent } from "../storage/audit.ts";

interface RequestWithClaims extends http.IncomingMessage {
  filesClaims?: VerifiedClaims;
}

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

// D-126 (E4.1 live-testing findings, Wave A): the default upload destination, now the root - no per-user
// default collection is created, so there is no name left to derive and D-92's random-string fallback
// never fires again. `id: ""` is the same sentinel storage/collections.ts's parent_id has used since
// D-80; the root is not a `collections` row (no owner, no ACL, no link token, no protection of its own -
// a root file's effective protection is simply its own stored level).
type UploadDestination = { id: string; defaultProtection: Protection };
const ROOT_DESTINATION: UploadDestination = { id: "", defaultProtection: "unlisted" }; // D-105's root default

// A requested destination is honoured only when it resolves AND canUploadTo() passes; anything else falls
// through to the root, exactly as it used to fall through to the per-user default collection (D-1: a
// stale or unauthorized destination must never turn "drop a file" into an error dialog). This can no
// longer fail - there is always a valid destination.
async function resolveDestinationCollection(
  claims: VerifiedClaims,
  requestedCollectionId: unknown,
): Promise<UploadDestination> {
  if (typeof requestedCollectionId === "string" && requestedCollectionId.length > 0) {
    const requested = await resolveCollectionById(requestedCollectionId);
    if (requested !== null && (await canUploadTo(requested, claims))) {
      return { id: requested.id, defaultProtection: requested.defaultProtection };
    }
  }
  return ROOT_DESTINATION;
}

async function cleanupFailedClaim(
  claimId: string,
  tempPath: string,
  finalPath: string | null,
): Promise<void> {
  await abandonFileRow(claimId);
  await unlink(tempPath).catch(() => {});
  if (finalPath !== null) await unlink(finalPath).catch(() => {});
}

export function buildTusServer(config: Config): TusServer {
  return new TusServer({
    path: "/api/upload",
    // D-174: makes @tus/server send Upload-Expires on create/PATCH and 410 an expired HEAD/PATCH
    // (dist/handlers/HeadHandler.js, PatchHandler.js) - the actual disk sweep is routes/upload.ts's
    // cleanUpExpiredUploads() interval (A2); this alone only governs what @tus/server considers expired.
    datastore: new FileStore({
      directory: config.tusTempDir,
      expirationPeriodInMilliseconds: UPLOAD_EXPIRY_MS,
    }),

    // Without this, @tus/server builds the Location header it hands the client from the raw request and
    // assumes http://, so behind nginx the browser is told to PATCH `http://files.mosni.dev/api/upload/<id>`
    // from an https:// page - which the CSP blocks (and which is mixed content regardless). It was hidden
    // until now because helmet's default `upgrade-insecure-requests` silently rewrote the scheme; D-76
    // removed that directive, having judged it "inert in production", and this is the case that proves it
    // was not. Honouring X-Forwarded-Proto/Host is the actual fix - the scheme should never have depended
    // on a CSP directive to be correct.
    respectForwardedHeaders: true,

    // Runs on every tus request (create, each PATCH chunk, head, delete) - there is no anonymous upload.
    onIncomingRequest: async (req) => {
      const token = bearerToken(req);
      if (token === null) tusError(401, "missing bearer token");

      let claims: VerifiedClaims;
      try {
        claims = (await verify(token, config.appOrigin)) as unknown as VerifiedClaims;
      } catch (err) {
        // Log the REAL reason server-side (never to the client - the 401 body stays generic so it leaks
        // nothing to an attacker). "invalid token" alone is undiagnosable: a JWKS-fetch failure (the
        // container cannot reach auth.mosni.dev), a rotated/absent signing key, an expired token, and a
        // wrong audience all look identical to the caller. jose attaches a `.code` and, for claim failures,
        // `.claim`/`.reason`; a fetch failure surfaces as its message. This is what turns the next auth
        // problem into a one-line `docker logs` read instead of a token-decoding session.
        const e = err as { code?: string; claim?: string; reason?: string; message?: string };
        console.error(
          "upload: token verification failed -",
          e.code ?? e.message ?? "unknown",
          e.claim ? `(claim=${e.claim} reason=${e.reason})` : "",
        );
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

      const destination = await resolveDestinationCollection(claims, upload.metadata?.destinationCollectionId);

      // A root-level file named "t" would shadow the static /t/:token route on dl.mosni.dev, the same
      // collision lib/paths.ts's isReservedRootName already guards for a root COLLECTION name (A6, Wave A
      // of the E4.1 live-testing findings hand-off) - suffix rather than reject (D-1).
      const name = destination.id === "" && isReservedRootName(safeName) ? `${safeName}-file` : safeName;

      // Display-name collision suffixing is now purely cosmetic (D-81: the disk name can never collide,
      // since it is prefixed with a fresh id) - but siblings still cannot share a `name` in the DB
      // (uniq_name_in_collection). Resolving it is claimFileRow's job, not this one's: reading the sibling
      // names here and suffixing against that snapshot is a read-then-write race, and two same-named
      // uploads in flight at once both read the same snapshot (AC11). claimFileRow retries against a fresh
      // list on the INSERT that actually detects the clash, and returns the name it really took.
      const id = generateId();
      const diskDir = currentDiskDir();
      const diskName = `${id}-${safeName}`; // the ORIGINAL uploaded name, pinned forever (D-82) - never
      // the (possibly suffixed) display name, since two different original uploads may legitimately
      // share an original filename once suffixing separates their display names.

      // D-136: the display name from the token's `name` claim, captured now since it never changes after
      // this point. D-168: when absent, `buildPreviewContext` falls back to the sub itself -
      // UNCONDITIONALLY, with no provider or owner exception ("name -> sub as fallback", Hannah, round 4).
      // An earlier draft of that round shipped a provider-based carve-out for EVE subs; it was corrected
      // the same day (5039229) and must not be reintroduced here or in previewContext.ts.
      const uploaderName =
        typeof claims.name === "string" && claims.name.trim().length > 0 ? claims.name : null;

      const claimed = await claimFileRow({
        id,
        collectionId: destination.id,
        name,
        diskDir,
        diskName,
        ownerSub: claims.sub,
        uploaderSub: claims.sub,
        protection: destination.defaultProtection,
        uploaderName,
      });

      let finalPath: string | null = null;
      try {
        finalPath = resolveRelPath(config.storageRoot, diskRelPath(claimed));
        if (finalPath === null) {
          await cleanupFailedClaim(claimed.id, tempPath, null);
          tusError(400, "unsafe destination path");
        }

        await mkdir(path.dirname(finalPath), { recursive: true });
        // Same filesystem (tusTempDir lives inside storageRoot, config.ts) - atomic.
        await rename(tempPath, finalPath);

        try {
          // Strip metadata on upload (preliminary-review P8). D-60: an unstripped original is never
          // stored, including not leaving one lying around after a failed strip.
          await stripInPlace(finalPath);
        } catch (err) {
          console.error(`upload: stripInPlace failed for ${finalPath} - upload rejected`, err);
          await cleanupFailedClaim(claimed.id, tempPath, finalPath);
          tusError(422, "could not verify the upload is safe to store");
        }

        const { size } = await stat(finalPath);
        // Probing after stripping is deliberate (D-74): the stripped file is the one that will be served,
        // so its dimensions are the true ones. A probe failure never fails the upload - probeMedia() never
        // throws.
        const probe = await probeMedia(finalPath);
        // D-137: thumbnail generation piggybacks on the same post-strip pass. generateThumb() never
        // throws - a thumbnail failure must never fail an upload (same contract as probeMedia()).
        const thumbName = thumbnailApplies(claimed.name) ? await generateThumb(finalPath, claimed.id) : null;
        const record = await commitFileRow(claimed.id, {
          bytes: size,
          width: probe.width,
          height: probe.height,
          durationSeconds: probe.durationSeconds,
          textPreview: probe.textPreview,
          thumbName,
          // Live-testing 2026-08-06: from the file's BYTES (storage/probe.ts -> lib/textDetect.ts), never
          // its extension - this is what makes a text file preview as text whatever it is called.
          isText: probe.isText,
        });

        const collectionSegments = await collectionPath(destination.id);
        // Fire-and-forget (D-43) - never awaited, a dead bot must not break or delay the upload response.
        emitAuditEvent({
          action: "upload",
          actor: actorLabel(claims),
          target: record.name,
          protection: record.protection,
          bytes: size,
          collection: collectionSegments.join("/"),
        });

        // D-96/D-100: the collection may be more restrictive than the upload's own inherited level
        // (D-86's default_protection is a different thing from the collection's OWN protection, D-95) -
        // the URLs handed back right after upload must reflect the EFFECTIVE level, or a file gated only
        // by its collection would be offered a dead /f/ link on its very first response.
        const resolved = await resolveEffective(record);
        const urls = buildFileUrls(
          config,
          resolved.effectiveProtection,
          [...collectionSegments, record.name],
          record.linkToken,
        );
        return {
          res,
          // The tus PATCH response is 204, and Node's http.ServerResponse drops any body on a 204 at the
          // runtime level - returning the result URLs requires overriding to 200 (which @tus/server's own
          // onUploadFinish doc comment anticipates).
          status_code: 200,
          headers: { "content-type": "application/json" },
          // E6 Wave C (D-175): `id` alongside the URLs - grouping needs to PATCH /api/files/:id for each
          // completed upload, and a display-name-shaped previewUrl/directUrl carries no way back to it.
          body: JSON.stringify({ ...urls, id: record.id }),
        };
      } catch (err) {
        // Anything unexpected between the claim and the commit (mkdir/rename/probe/commit failures the
        // branches above don't already handle) - D-85's guarantee is that a failed upload leaves NEITHER
        // a row NOR bytes, so the same cleanup applies here too.
        if (
          typeof err === "object" &&
          err !== null &&
          "status_code" in err &&
          "body" in err
        ) {
          throw err; // already a tusError() - cleanup already ran in the branch that threw it
        }
        console.error("upload: unexpected failure committing upload", err);
        await cleanupFailedClaim(claimed.id, tempPath, finalPath);
        tusError(500, "internal error committing upload");
      }
    },
  });
}
