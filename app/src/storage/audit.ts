// D-43/D-46: the ONLY module that performs the write-action audit emit. Fire-and-forget, non-fatal, NEVER
// awaited by callers, and swallows every error internally - a dead bot must never break or delay a write.
// Formatting is pure and lives in lib/audit.ts; this module is the I/O side only.

import { formatAuditLine, type AuditEvent } from "../lib/audit.ts";

export function emitAuditEvent(event: AuditEvent): void {
  const botApi = process.env.BOT_API;
  if (!botApi) return; // no target configured - nothing to do, never throw

  fetch(`${botApi}/say`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channel: "server-notifications",
      content: formatAuditLine(event),
      silent: true,
    }),
  }).catch((err) => {
    console.error("audit: emit failed (non-fatal - a dead bot must never break a write)", err);
  });
}
