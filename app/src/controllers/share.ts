// E7 (§1.4 of the waves hand-off): the share API - GET /api/accounts, GET/POST /api/shares,
// POST /api/shares/revoke, POST /api/invites. Preliminary-review P2 convention: logic here,
// routes/share.ts is thin plumbing + schema validation.
//
// D-187: only the object's owner or `mosni_owner` may grant, revoke or invite - resolveShareTarget is the
// ONE place that authorization is checked, and every handler below goes through it. It returns null for
// "not found OR not yours" so every handler sends the same 404 for both, never confirming an object exists
// to someone who may not share it (matching controllers/manage.ts's existing rule).
//
// E7-QA1 D-195: D-186's "refused unless effectively private" is REVERSED - sharing succeeds at EVERY
// protection level now. D-182/D-183: a share is the ACL row alone; `files:read` gates nothing and is
// never consulted here.

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";
import { claimsFromBearer } from "../auth/bearer.ts";
import { listAccounts, mintInviteLink, setAccountRole } from "../auth/internalApi.ts";
import { can, isSuperuser, type VerifiedClaims } from "../lib/roles.ts";
import { actorLabel } from "../lib/audit.ts";
import { buildCollectionPreviewUrl, buildFileUrls } from "../lib/fileUrls.ts";
import { DEFAULT_INVITE_TTL_SECONDS, isValidInviteTtl } from "../lib/inviteDuration.ts";
import type { ShareGrant, ShareObjectType, ShareState } from "../lib/shareContext.ts";
import { emitAuditEvent } from "../storage/audit.ts";
import {
  collectionPath,
  grantCollectionAcl,
  listCollectionGrants,
  resolveCollectionById,
  resolveCollectionEffective,
  revokeCollectionAcl,
  type ResolvedCollection,
} from "../storage/collections.ts";
import { grantFileAcl, listFileGrants, resolveById, resolveEffective, revokeFileAcl, type ResolvedFile } from "../storage/files.ts";

async function requireClaims(request: FastifyRequest, reply: FastifyReply, config: Config): Promise<VerifiedClaims | null> {
  const claims = await claimsFromBearer(request, config.appOrigin);
  if (claims === null) {
    reply.code(401).send();
    return null;
  }
  return claims;
}

function isShareObjectType(value: unknown): value is ShareObjectType {
  return value === "file" || value === "collection";
}

export type ResolvedShareTarget =
  | { type: "file"; file: ResolvedFile }
  | { type: "collection"; collection: ResolvedCollection };

function targetMeta(target: ResolvedShareTarget): { id: string; name: string; effectiveProtection: ResolvedFile["effectiveProtection"] } {
  return target.type === "file"
    ? { id: target.file.id, name: target.file.name, effectiveProtection: target.file.effectiveProtection }
    : { id: target.collection.id, name: target.collection.name, effectiveProtection: target.collection.effectiveProtection };
}

// D-187: only the owner or mosni_owner. A grantee never grants - a can_upload grant is upload authority,
// not sharing authority. Returns null for "not found OR not yours", so the caller sends the same 404 for
// both and never confirms an object exists to someone who may not share it.
async function resolveShareTarget(
  type: ShareObjectType,
  id: string,
  claims: VerifiedClaims,
): Promise<ResolvedShareTarget | null> {
  if (type === "file") {
    const record = await resolveById(id);
    if (record === null) return null;
    const isOwner = record.ownerSub !== null && record.ownerSub === claims.sub;
    if (!isOwner && !isSuperuser(claims)) return null;
    return { type: "file", file: await resolveEffective(record) };
  }
  const record = await resolveCollectionById(id);
  if (record === null) return null;
  if (record.ownerSub !== claims.sub && !isSuperuser(claims)) return null;
  return { type: "collection", collection: await resolveCollectionEffective(record) };
}

async function grantsFor(target: ResolvedShareTarget): Promise<{ sub: string; canUpload: boolean }[]> {
  if (target.type === "file") {
    return (await listFileGrants(target.file.id)).map((sub) => ({ sub, canUpload: false }));
  }
  return listCollectionGrants(target.collection.id);
}

// Protection is read EFFECTIVE, resolved through resolveEffective/resolveCollectionEffective above - never
// `record.protection` directly (D-96), even though D-195 no longer gates sharing on the result. destinationUrlFor
// below follows the SAME rule for the exact same reason: a file stored `unlisted` inside a `private`
// collection must mint an invite that matches what the object actually resolves to for everyone else, not
// what its own row says.
async function destinationUrlFor(config: Config, target: ResolvedShareTarget): Promise<string> {
  if (target.type === "file") {
    const segments = [...(await collectionPath(target.file.collectionId)), target.file.name];
    return buildFileUrls(config, target.file.effectiveProtection, segments, target.file.linkToken).previewUrl;
  }
  const segments = await collectionPath(target.collection.id);
  return buildCollectionPreviewUrl(config, target.collection.effectiveProtection, segments, target.collection.linkToken);
}

async function buildShareState(target: ResolvedShareTarget): Promise<ShareState> {
  const meta = targetMeta(target);
  const rawGrants = await grantsFor(target);
  // B3: if listAccounts() fails, the list of who has access must not depend on auth being up - every
  // grant still returns, just with name/picture null (the same shape an invited/link-bound sub always
  // renders as, since auth's directory excludes those too).
  const directoryResult = await listAccounts();
  const directory = new Map(directoryResult.ok ? directoryResult.value.map((account) => [account.sub, account]) : []);
  const grants: ShareGrant[] = rawGrants.map((grant) => {
    const account = directory.get(grant.sub);
    return { sub: grant.sub, name: account?.name ?? null, picture: account?.picture ?? null, canUpload: grant.canUpload };
  });
  return {
    type: target.type,
    id: meta.id,
    name: meta.name,
    effectiveProtection: meta.effectiveProtection,
    grants,
  };
}

// B2: requires a bearer and files:write - NOT ownership of anything (D-188's amended invariant 8: one
// generic directory for any writer). Passes auth's projection through completely unchanged - no filter,
// sort, cache or re-shape; the client filters out the caller and already-granted subs itself.
export async function getAccountsHandler(request: FastifyRequest, reply: FastifyReply, config: Config): Promise<void> {
  const claims = await requireClaims(request, reply, config);
  if (claims === null) return;
  if (!can(claims, "files:write")) {
    reply.code(403).send();
    return;
  }
  const result = await listAccounts();
  if (!result.ok) {
    reply.code(502).send({ error: "auth_unavailable" });
    return;
  }
  reply.send(result.value);
}

export async function getSharesHandler(request: FastifyRequest, reply: FastifyReply, config: Config): Promise<void> {
  const claims = await requireClaims(request, reply, config);
  if (claims === null) return;
  const query = request.query as { type?: string; id?: string };
  if (!isShareObjectType(query.type) || typeof query.id !== "string" || query.id.length === 0) {
    reply.code(400).send({ error: "bad_request" });
    return;
  }
  const target = await resolveShareTarget(query.type, query.id, claims);
  if (target === null) {
    reply.code(404).send();
    return;
  }
  reply.send(await buildShareState(target));
}

export async function grantShareHandler(request: FastifyRequest, reply: FastifyReply, config: Config): Promise<void> {
  const claims = await requireClaims(request, reply, config);
  if (claims === null) return;
  const body = request.body as { type?: string; id?: string; sub?: string; canUpload?: boolean };
  if (!isShareObjectType(body.type) || typeof body.id !== "string" || typeof body.sub !== "string" || body.sub.length === 0) {
    reply.code(400).send({ error: "bad_request" });
    return;
  }
  // canUpload is accepted for a collection only - rejected on a file with 400 rather than ignored
  // silently (E4.1's removeAdditional landmine: a silently-dropped field is how a request 200s and
  // changes nothing).
  if (body.canUpload !== undefined && body.type === "file") {
    reply.code(400).send({ error: "bad_request" });
    return;
  }
  const target = await resolveShareTarget(body.type, body.id, claims);
  if (target === null) {
    reply.code(404).send();
    return;
  }
  const meta = targetMeta(target);
  // E7-QA1 D-195: D-186's "refused unless effectively private" is REVERSED - sharing now succeeds at
  // every protection level. Grants are always writable; on a non-private object the VIEW half is simply
  // redundant (the object is already readable by anyone holding the link), which is exactly what makes
  // the upload half meaningful on an unlisted/public collection - the point of this decision.
  if (body.sub === claims.sub) {
    reply.code(400).send({ error: "cannot_share_with_self" });
    return;
  }
  // D-182: this app does NOT call POST /internal/roles when granting to an ordinary account - the row IS
  // the grant, there is no role to add. auth is only involved for invites (createInviteHandler) and for
  // the files:read cleanup on revoke (D-192, below).
  // E8/D-220: an ordinary account share has no duration control and does not expire (expiresAt stays the
  // default null) - only an invite grant (createInviteHandler, below) ever passes a value.
  if (target.type === "file") {
    await grantFileAcl(target.file.id, body.sub);
  } else {
    await grantCollectionAcl(target.collection.id, body.sub, body.canUpload === true);
  }
  emitAuditEvent({ action: "share-change", actor: actorLabel(claims), target: meta.name });
  reply.send(await buildShareState(target));
}

export async function revokeShareHandler(request: FastifyRequest, reply: FastifyReply, config: Config): Promise<void> {
  const claims = await requireClaims(request, reply, config);
  if (claims === null) return;
  const body = request.body as { type?: string; id?: string; sub?: string };
  if (!isShareObjectType(body.type) || typeof body.id !== "string" || typeof body.sub !== "string" || body.sub.length === 0) {
    reply.code(400).send({ error: "bad_request" });
    return;
  }
  const target = await resolveShareTarget(body.type, body.id, claims);
  if (target === null) {
    reply.code(404).send();
    return;
  }
  if (target.type === "file") {
    await revokeFileAcl(target.file.id, body.sub);
  } else {
    await revokeCollectionAcl(target.collection.id, body.sub);
  }
  // D-192: best-effort, silent, and its result is ignored entirely - the ACL row is what actually ends
  // access, and auth being unreachable must not block a revoke. Never surfaces anything about the invite
  // link's remaining life (Hannah's explicit call).
  await setAccountRole(body.sub, "files:read", "remove");
  emitAuditEvent({ action: "share-change", actor: actorLabel(claims), target: targetMeta(target).name });
  reply.send(await buildShareState(target));
}

const MINT_ERROR_PASSTHROUGH = new Set(["ttl_too_long", "not_grantable", "bad_destination", "namespace_mismatch", "bad_request"]);

export async function createInviteHandler(request: FastifyRequest, reply: FastifyReply, config: Config): Promise<void> {
  const claims = await requireClaims(request, reply, config);
  if (claims === null) return;
  const body = request.body as {
    type?: string;
    id?: string;
    canUpload?: boolean;
    allow_register?: boolean;
    ttl_seconds?: number;
  };
  if (!isShareObjectType(body.type) || typeof body.id !== "string") {
    reply.code(400).send({ error: "bad_request" });
    return;
  }
  if (body.canUpload !== undefined && body.type === "file") {
    reply.code(400).send({ error: "bad_request" });
    return;
  }
  // E7-QA2 §A3/A4: absent is a valid request (an older client, a direct API call) and defaults to 1h
  // (D-205). A present value that is not one of the ten D-204 stops is rejected HERE, not clamped and not
  // left for auth to reject - a value off the list did not come from this app's UI, and substituting one
  // silently would hide that. This also means the top stop's cap is enforced twice on purpose: here
  // against the list, and again by auth's own APP_LINK_TTL_MAX (Wave 0b) - the two must never drift, see
  // lib/inviteDuration.ts's header comment.
  const ttlSeconds = body.ttl_seconds === undefined ? DEFAULT_INVITE_TTL_SECONDS : body.ttl_seconds;
  if (!isValidInviteTtl(ttlSeconds)) {
    reply.code(400).send({ error: "invalid_ttl" });
    return;
  }
  const target = await resolveShareTarget(body.type, body.id, claims);
  if (target === null) {
    reply.code(404).send();
    return;
  }
  const meta = targetMeta(target);
  // D-195: see grantShareHandler's comment - the same reversal applies to invites.

  const destination = await destinationUrlFor(config, target);
  const minted = await mintInviteLink({
    roles: ["files:read"],
    ttlSeconds,
    destination,
    // Shown to Hannah in auth's own /admin screen - names the object and nothing sensitive.
    label: `files: ${meta.name}`,
    // E7-QA1 §B1.7/D-198: defaults to true, matching the dialog's own default-on switch - only D-23's
    // `allow_register` moves here; the rest of invite management stays E8's (D-191).
    allowRegister: body.allow_register ?? true,
  });
  if (!minted.ok) {
    if (MINT_ERROR_PASSTHROUGH.has(minted.error)) {
      reply.code(400).send({ error: minted.error });
      return;
    }
    reply.code(502).send({ error: "auth_unavailable" });
    return;
  }

  // link:${id} is the ONLY sub this app ever constructs, from the id auth returned in THIS SAME response
  // (security invariant 6: every comparison elsewhere is `=`/`===`, never a parse). auth guarantees this
  // is the invitee's sub from their first click, upgrade or not - see verification-concept.md's mandatory
  // box check, the one proof no automated tier here can produce.
  const sub = `link:${minted.value.id}`;
  // D-220: the ACL row's expiry is auth's OWN returned expiry for THIS mint, not a recomputed value, so
  // the row and the link can never disagree. Passed regardless of allow_register - the switch changes who
  // the identity is (upgraded account vs. link-bound), never how long the grant lasts.
  const expiresAt = new Date(minted.value.expiresAt);
  try {
    if (target.type === "file") {
      await grantFileAcl(target.file.id, sub, expiresAt);
    } else {
      await grantCollectionAcl(target.collection.id, sub, body.canUpload === true, expiresAt);
    }
  } catch (err) {
    // The mint already succeeded - the link is live and un-revocable via this API (auth has no internal
    // link-revoke). Never log the URL (invariant 11) - only the id identifies the incident.
    request.log.error(
      { linkId: minted.value.id, err },
      "controllers/share: ACL insert failed after a successful invite mint - the link grants nothing",
    );
    reply.code(502).send({ error: "acl_write_failed" });
    return;
  }
  emitAuditEvent({ action: "invite-create", actor: actorLabel(claims), target: meta.name });
  reply.code(201).send({ url: minted.value.url, expiresAt: minted.value.expiresAt, sub });
}
