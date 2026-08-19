// The one way this app shows a person: their avatar, their name, and their `sub` only ever as a tooltip
// or as the last-resort fallback when the directory has no name for them.
//
// Hannah, 2026-08-19 (live-testing E8's admin panel): *"grantee and owner columns should always be name
// with sub in the tooltip, never plain sub. preferably even the agreed-on picture+name combo we usually
// denote owners with."* This is that combo, extracted so there is one definition rather than a fourth
// copy - ShareDialog had `GrantAvatar` + an ad-hoc span, headerIdentity had its own `avatarUrlFor`, and
// the admin panel was about to grow a third.
//
// ⚠ This does NOT reverse D-222. That decision is about a **link-bound** account, which auth's directory
// deliberately excludes (`WHERE link_id IS NULL`), so there is no name to resolve and the truncated raw
// sub with a full-value title is exactly what still renders. What changes is the ordinary case, where a
// name has always been available and simply was not being asked for.
//
// ⚠ Security invariant 6: a `sub` is a key to look up, never a string to interpret. Nothing here parses
// one - `nameFor` is a Map lookup and the fallback is the whole value, unmodified.

import { useState } from "react";

// D-169: auth.mosni.dev/avatar/<sub> DIRECTLY - no files.-side proxy, and this exact origin is what
// lib/csp.ts's img-src allow-lists (along with the two CDNs it redirects to, review 052's F3). Never
// render auth's raw `picture` field instead: that is an IdP CDN URL the CSP does not allow.
export function avatarUrlFor(sub: string): string {
  return `https://auth.mosni.dev/avatar/${encodeURIComponent(sub)}`;
}

// The letter shown when there is no picture. The LAST character of the sub, because the first characters
// are the provider prefix every sub of that kind shares (`google:`, `user:`, `link:`) - an initial that is
// "G" for everyone distinguishes nobody. Reading a character is not parsing a sub (invariant 6): nothing
// branches on it, and it never decides access.
function initialFor(sub: string): string {
  return (sub.slice(-1) || "?").toUpperCase();
}

// On a load failure, degrade to an initial rather than the browser's broken-image icon (D-169, review
// 036 round 4). `sub` is re-read on every render, so a changed sub retries rather than staying failed.
export function Avatar({ sub, size = 20 }: { sub: string; size?: number }) {
  const [failedFor, setFailedFor] = useState<string | null>(null);
  if (failedFor === sub) {
    return (
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          // Explicit border and colour, not a bare background: the D-79 screenshots of the admin panel
          // showed the fallback occupying its 20px box and rendering nothing an eye could find, because a
          // surface token on a dark theme is the same colour as the row it sits in. A circle has to look
          // like a circle for "this identity has no picture" to read as a state rather than a glitch.
          background: "var(--mosni-surface-input, #2b2b2b)",
          border: "1px solid var(--mosni-border-muted, #555)",
          color: "var(--mosni-text-soft, #ddd)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: `${Math.round(size * 0.5)}px`,
          lineHeight: 1,
          boxSizing: "border-box",
          flexShrink: 0,
        }}
      >
        {initialFor(sub)}
      </span>
    );
  }
  return (
    <img
      src={avatarUrlFor(sub)}
      alt=""
      width={size}
      height={size}
      style={{ borderRadius: "50%", flexShrink: 0 }}
      onError={() => setFailedFor(sub)}
    />
  );
}

// The tooltip carries BOTH, because the name is what a human recognises and the sub is what the ACL row
// actually holds - an admin revoking access needs to be able to see the exact identity being revoked.
export function identityTitle(sub: string, name: string | null | undefined): string {
  return name ? `${name} (${sub})` : sub;
}

// One line, ellipsised, always. Carried over from ShareDialog, where session 048 first added this and
// commit `b5ba853` reverted it along with the label substitution it was bundled with - only the LABEL half
// was ever the problem (it parsed the sub, violating invariant 6); truncation parses nothing.
//
// Why `overflowWrap: anywhere` on the container is not a substitute: it makes a raw sub WRAP rather than
// overflow, so nothing is clipped and an overflow check stays clean - but a 40-character `link:<uuid>`
// wrapped over three lines still shoves whatever follows it around and reads as broken.
//
// `maxWidth` is a prop because a table cell and a dialog row have genuinely different budgets - the Access
// table carries two of these side by side. `grow` is the dialog's shape: take the remaining space so the
// controls after it stay right-aligned, rather than sitting at the chip's natural width.
export function IdentityChip({
  sub,
  name,
  maxWidth = "16rem",
  size,
  grow = false,
}: {
  sub: string;
  name?: string | null;
  maxWidth?: string;
  size?: number;
  grow?: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        minWidth: 0,
        ...(grow ? { flex: 1 } : { maxWidth: "100%" }),
      }}
    >
      <Avatar sub={sub} size={size} />
      <span
        title={identityTitle(sub, name)}
        style={{
          ...(grow ? { flex: 1, minWidth: 0 } : { maxWidth }),
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name ?? sub}
      </span>
    </span>
  );
}
