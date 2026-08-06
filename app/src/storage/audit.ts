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

// Live-testing addition (2026-08-06): "bulk operations like deleting a folder, moving a grouped set of
// uploads, etc may not send a notification for each action". Traced as far as this sandbox can reach: a
// recursive collection delete (controllers/manage.ts's deleteCollectionHandler) already calls this once
// PER deleted file plus once for the collection itself, and E6's upload-grouping move
// (UploadStack.tsx's confirmGroup()) already PATCHes - and so audits - one file at a time too. Neither
// under-calls this function. What every prior version of it did wrong: N calls in a tight loop each fired
// an immediate, unawaited POST, so an N-file bulk action sent N simultaneous requests at bot-core's /say -
// and a relay or its Discord target enforcing any kind of burst rate limit (Discord's own webhook cap is a
// well-known ~5 requests/2s per channel) would silently drop the overflow, which `.catch()` below has
// always swallowed by design (D-43: "a dead bot must never break or delay a write"). Not confirmable from
// here - there is no local bot-core/infrastructure checkout, the same boundary AUDIT-NOT-SILENT already
// hit - but serializing and spacing the app's OWN sends is a safe mitigation regardless of the exact
// downstream limit: it changes nothing about what gets sent or its content, only paces when, and it can
// only help. AUDIT_EMIT_SPACING_MS is a conservative guess (comfortably under any 5-per-2s-class limit),
// not a measured value - worth tightening once bot-core's real limit is confirmed.
//
// The original contract still holds: a dead or slow bot must never accumulate work forever or delay a
// write. Nothing here is ever awaited by a caller, each send is time-boxed, and a failed or timed-out send
// is dropped (logged) rather than retried, so the queue can never back up without bound.
const DEFAULT_SPACING_MS = 350;
const DEFAULT_TIMEOUT_MS = 5000;
let spacingMs = DEFAULT_SPACING_MS;
let timeoutMs = DEFAULT_TIMEOUT_MS;

let queue: Promise<void> = Promise.resolve();

async function sendOne(botApi: string, event: AuditEvent): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${botApi}/say`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "server-notifications",
        content: formatAuditLine(event),
        silent: true,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    console.error("audit: emit failed (non-fatal - a dead bot must never break a write)", err);
  } finally {
    clearTimeout(timeout);
  }
}

export function emitAuditEvent(event: AuditEvent): void {
  const botApi = configuredBotApi;
  if (!botApi) return; // initAudit() never called (e.g. a test that didn't set it up) - never throw

  // Chained onto the same queue every call uses, so a burst from one bulk action reaches bot-core spaced
  // out instead of all at once. sendOne() already swallows its own errors; the trailing .catch() is
  // defensive only, so one unexpected failure can never wedge every audit line queued after it.
  queue = queue
    .then(() => sendOne(botApi, event))
    .then(() => new Promise<void>((resolve) => setTimeout(resolve, spacingMs)))
    .catch(() => {});
}

/** Test-only: drops any in-flight spacing delay so one test's queued send cannot bleed into the next
 *  test's fetch mock/timing (the module-level queue otherwise persists for the whole test file), and
 *  optionally shrinks the spacing/timeout so a burst/timeout test does not need to run at production
 *  speed. Omit either argument to keep the production default. */
export function __resetAuditQueueForTests(overrides: { spacingMs?: number; timeoutMs?: number } = {}): void {
  queue = Promise.resolve();
  spacingMs = overrides.spacingMs ?? DEFAULT_SPACING_MS;
  timeoutMs = overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}
