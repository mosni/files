// D-43/D-46: the ONLY module that performs the write-action audit emit. Fire-and-forget, non-fatal, NEVER
// awaited by callers, and swallows every error internally - a dead bot must never break or delay a write.
// Formatting is pure and lives in lib/audit.ts; this module is the I/O side only.
//
// botApi comes from validated config (config.ts), set once at boot via initAudit(), rather than read from
// process.env directly - session 005 deferred this to "when E2 first calls the emitter" (Wave A6).

import { formatAuditLine, type AuditEvent } from "../lib/audit.ts";

let configuredBotApi: string | undefined;

export function initAudit(botApi: string): void {
  configuredBotApi = botApi;
}

export function emitAuditEvent(event: AuditEvent): void {
  const botApi = configuredBotApi;
  if (!botApi) return; // initAudit() never called (e.g. a test that didn't set it up) - never throw

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
