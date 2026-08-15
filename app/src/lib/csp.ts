// The Content-Security-Policy directives shared by every ordinary page (registered once, globally, via
// helmet in server.ts). Extracted to its own module so the embeddable player route (E5 Wave H, D-140) can
// build its OWN, separately-serialized CSP header from the same base values rather than a second, drifting
// copy - see embedContentSecurityPolicy() below for why it must be a full replacement, not a merge.

export const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "https://ui.mosni.dev", "https://auth.mosni.dev"],
  styleSrc: ["'self'", "https://ui.mosni.dev", "'unsafe-inline'"],
  frameSrc: ["'self'", "https://auth.mosni.dev", "https://dl.mosni.dev"],
  frameAncestors: ["'self'", "https://files.mosni.dev"],
  // D-169: the avatar <img> links straight to auth.mosni.dev/avatar/<sub> (no more files.-side proxy) -
  // without this origin here, every avatar image is silently blocked by this exact policy.
  // Review session 052 - F3's ACTUAL root cause, still live after two rounds that thought they had fixed
  // it. `auth.mosni.dev` being allow-listed is NOT enough, because `GET auth.mosni.dev/avatar/<sub>` is a
  // **302 redirect**, and CSP img-src is enforced against the FINAL url after redirects, not the one the
  // page asked for. Read out of `mosni/auth/app/src/routes/avatar.ts`: a Google account redirects to its
  // stored `picture` (Google's CDN), an EVE account to `images.evetech.net`, the owner to
  // `mosni.dev/portraits/...` (already allowed, which is why the owner's avatar always worked), and
  // everything else gets an inline SVG served by auth itself (also fine). So exactly the two IdP-backed
  // cases were blocked - the ones with a real photo.
  //
  // F3 was originally diagnosed correctly ("img-src allows auth.mosni.dev but not an IdP CDN") and then
  // fixed by pointing at `auth.mosni.dev/avatar/<sub>` instead, which just moves the same CDN one hop
  // away. Session 048 then "disproved" the whole premise by curling the route for INVENTED subs - which
  // have no account row, so they can only ever return the default SVG. curl enforces no CSP either.
  //
  // Named origins only, never a wildcard - the same posture frameSrc keeps below. A files.mosni.dev
  // proxy is not the alternative: D-169 deliberately removed one.
  imgSrc: [
    "'self'",
    "https://mosni.dev",
    "https://ui.mosni.dev",
    "https://auth.mosni.dev",
    "https://dl.mosni.dev",
    "https://lh3.googleusercontent.com",
    "https://images.evetech.net",
    "data:",
    "blob:",
  ],
  mediaSrc: ["'self'", "https://dl.mosni.dev"],
  connectSrc: ["'self'", "https://auth.mosni.dev", "https://dl.mosni.dev"],
} as const;

// D-140: the embeddable route is a video PLAYER meant to be iframed by named platforms - Twitter/X is the
// concrete, immediate consumer (`twitter:card=player`, PreviewHead.tsx). Named origins only, never a
// wildcard - widening this list is a judgment call worth a deliberate look (flagged in the session log),
// not something to extend casually.
//
// Discord added in review session 034 (Hannah's call): it is named in Wave H's own manual check, and with
// Twitter/X alone a Discord player embed would simply be refused by this header. `canary`/`ptb` are the
// same application on separate origins - a CSP origin match is exact, so they need naming individually or
// they are refused too.
const EMBED_FRAME_ANCESTORS = [
  "https://twitter.com",
  "https://x.com",
  "https://discord.com",
  "https://canary.discord.com",
  "https://ptb.discord.com",
];

function toKebabCase(directiveName: string): string {
  return directiveName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function serialize(directives: Record<string, readonly string[]>): string {
  return Object.entries(directives)
    .map(([name, values]) => `${toKebabCase(name)} ${values.join(" ")}`)
    .join("; ");
}

// A full, from-scratch CSP string - NOT a merge with helmet's globally-registered header. Helmet is
// registered exactly once, for the whole Fastify instance (server.ts) - that single global registration is
// the exact trap that produced D-77 (dl.'s responses silently inheriting files.'s directives). Setting
// `Content-Security-Policy` explicitly in the embed route's own handler, AFTER helmet's onRequest-time
// default already ran, replaces the header for that one response; every other route is untouched.
export function embedContentSecurityPolicy(): string {
  return serialize({ ...CSP_DIRECTIVES, frameAncestors: EMBED_FRAME_ANCESTORS });
}
