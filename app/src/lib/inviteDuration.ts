// E7-QA2 §1.1: the one definition of the ten duration stops, imported by controllers/share.ts AND by
// web/ (ShareDialog.tsx) - the same one-definition pattern shareContext.ts already uses, so the client's
// slider and the server's validator cannot drift. Pure, I/O-free (technical-baseline.md §2).

// D-204's ten stops, ascending. The slider is an INDEX into this array; the wire carries seconds. Only
// the first and last are labelled in the UI (D-204) - `label` is still defined for every stop because the
// readout names the current one, and because ShareDialog's copy interpolates it.
//
// The top stop (7776000 = 90 days) MUST equal auth's APP_LINK_TTL_MAX after Wave 0b (raised on the box
// per D-206). If the two ever disagree, this stop 400s live (auth's ttl_too_long) while every test in
// this repo stays green - Wave 0b is the one step that cannot be verified from this sandbox.
export const INVITE_DURATION_STOPS = [
  { seconds: 1800, label: "30 minutes" },
  { seconds: 3600, label: "1 hour" },
  { seconds: 7200, label: "2 hours" },
  { seconds: 21600, label: "6 hours" },
  { seconds: 43200, label: "12 hours" },
  { seconds: 86400, label: "24 hours" },
  { seconds: 172800, label: "2 days" },
  { seconds: 604800, label: "7 days" },
  { seconds: 2592000, label: "30 days" },
  { seconds: 7776000, label: "90 days" },
] as const;

// D-205: the default is 1h and lives HERE, in code, not in config - INVITE_TTL_SECONDS is retired.
export const DEFAULT_INVITE_DURATION_INDEX = 1;

export const DEFAULT_INVITE_TTL_SECONDS = INVITE_DURATION_STOPS[DEFAULT_INVITE_DURATION_INDEX].seconds;

/**
 * Server-side validation (§A2). A client picking from a list is not validation: a hand-crafted
 * POST /api/invites must be rejected here, not merely trusted because the UI only ever sends one of
 * these ten values.
 */
export function isValidInviteTtl(seconds: unknown): seconds is number {
  return typeof seconds === "number" && INVITE_DURATION_STOPS.some((stop) => stop.seconds === seconds);
}
