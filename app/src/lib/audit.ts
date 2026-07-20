// D-46: a write-action audit line carries actor, action, target, protection level, size, collection.
// Pure formatting only - the emit (the actual POST /say) lives in storage/audit.ts. This module must never
// perform I/O.

import type { Protection } from "./protection.ts";

export type WriteAction =
  | "upload"
  | "rename"
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
};

const VERBS: Record<WriteAction, string> = {
  upload: "uploaded",
  rename: "renamed",
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

export function formatAuditLine(event: AuditEvent): string {
  const line = `${event.actor} ${VERBS[event.action]} "${event.target}"`;

  const details: string[] = [];
  if (event.protection !== undefined) details.push(event.protection);
  if (event.bytes !== undefined) details.push(formatBytes(event.bytes));
  if (event.collection !== undefined) details.push(`in ${event.collection}`);

  return details.length > 0 ? `${line} (${details.join(", ")})` : line;
}
