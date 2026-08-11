// D-46: a write-action audit line carries actor, action, target, protection level, size, collection.
// Pure formatting only - the emit (the actual POST /say) lives in storage/audit.ts. This module must never
// perform I/O.

import type { Protection } from "./protection.ts";
import type { VerifiedClaims } from "./roles.ts";

export type WriteAction =
  | "upload"
  | "rename"
  | "move"
  | "delete"
  | "protection-change"
  | "share-change"
  | "invite-create"
  | "invite-revoke";

export type AuditEvent = {
  action: WriteAction;
  actor: string;
  target: string;
  // D-59 (session 006) split "semi-private" into unlisted/secret - this now tracks lib/protection.ts's
  // Protection type directly instead of a hardcoded copy, so the two can never drift again.
  protection?: Protection;
  bytes?: number;
  collection?: string;
  // Live-testing addition (2026-08-06, Hannah): "bulk operations like deleting a folder, moving a grouped
  // set of uploads, etc may not send a notification for each action." A bulk action is ONE action and gets
  // ONE line carrying how many files it touched - not N lines, which is what a recursive delete used to
  // emit (one per file, each naming a raw file id rather than a name) and what the client's grouped move
  // used to produce by issuing N separate requests.
  //
  // Grouping is the fix, not throttling: an earlier attempt at this spaced the N sends out instead, which
  // left the feed just as noisy, made a large delete take minutes to finish reporting, and grew an
  // unbounded in-memory queue. `count` is deliberately part of the EVENT rather than anything in
  // storage/audit.ts, so the emitter stays a dumb one-shot POST.
  count?: number;
};

const VERBS: Record<WriteAction, string> = {
  upload: "uploaded",
  rename: "renamed",
  move: "moved",
  delete: "deleted",
  "protection-change": "changed the protection level of",
  "share-change": "changed the sharing of",
  "invite-create": "created an invite for",
  "invite-revoke": "revoked an invite for",
};

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return unitIndex === 0 ? `${value} ${units[unitIndex]}` : `${value.toFixed(1)} ${units[unitIndex]}`;
}

// The audit channel is an internal ops Discord channel (storage/audit.ts posts to "server-notifications"),
// not public - so unlike the default collection name (controllers/upload.ts), a sub fallback here is not a
// privacy leak, just less readable than a name. Prefer the token's `name` claim; fall back to the sub only
// when no name claim is present.
export function actorLabel(claims: VerifiedClaims): string {
  return typeof claims.name === "string" && claims.name.trim().length > 0 ? claims.name : claims.sub;
}

export function formatAuditLine(event: AuditEvent): string {
  const line = `${event.actor} ${VERBS[event.action]} "${event.target}"`;

  const details: string[] = [];
  // First in the list on purpose: for a bulk action the count is the most important thing in the line.
  if (event.count !== undefined) details.push(`${event.count} ${event.count === 1 ? "file" : "files"}`);
  if (event.protection !== undefined) details.push(event.protection);
  if (event.bytes !== undefined) details.push(formatBytes(event.bytes));
  if (event.collection !== undefined) details.push(`in ${event.collection}`);

  return details.length > 0 ? `${line} (${details.join(", ")})` : line;
}
