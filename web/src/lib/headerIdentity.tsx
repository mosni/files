// Live-testing addition (2026-08-06, Hannah): "the top bar right side (it has a slot for this) should show
// 'logged in as [pic] [name]' when logged in".
//
// E7.5 Wave E: `<HeaderIdentity />` is now ordinary composition - main.tsx passes it straight as
// `<Header tagline={<HeaderIdentity />}>`, because the header itself moved INTO the React tree (D-213) and
// @mosni/react's `<Header>` accepts a real `ReactNode` for `tagline`. Everything below this comment is
// unchanged from before: `useSignedInUser`, `HeaderAvatar`, `displayNameFor` and the truncation styling all
// still do real work. What is GONE is `initHeaderIdentity()` - the polling `querySelector` for a
// chrome-owned `.little-link` node, the `dataset.identityMounted` guard, and the second `createRoot` it
// mounted into that node - all of which existed only because the header used to live OUTSIDE the SPA's
// React tree (a static `<mosni-header>` in index.html) and had to be reached by locating a DOM node after
// the fact. That constraint no longer exists; do not resurrect it.

import { useEffect, useState } from "react";
import type { VerifiedClaims } from "../../../app/src/lib/roles.ts";

const AUTH_ORIGIN = "https://auth.mosni.dev"; // matches lib/csp.ts's imgSrc entry and D-169's direct avatar link

function avatarUrlFor(sub: string): string {
  return `${AUTH_ORIGIN}/avatar/${encodeURIComponent(sub)}`;
}

// D-168: name if captured, else the sub, unconditionally - the same fallback rule PreviewCard's uploader
// line and lib/audit.ts's actorLabel() already use, so identity display reads consistently everywhere.
// VerifiedClaims (not Claims) is the type that actually models the optional `name` claim, so this needs no
// cast: mosni/auth's SDK returns the whole decoded JWT payload from user() (client/sdk.ts's currentUser ->
// decodeClaims), and its /token route does mint `name` - both verified by reading that repo, not assumed.
function displayNameFor(user: VerifiedClaims): string {
  const name = user.name;
  return typeof name === "string" && name.trim().length > 0 ? name : user.sub;
}

// Same subscribe-with-poll shape ShareDialog's useCurrentUserSub, FileBrowser and lib/shareTarget.ts all
// use - the auth SDK's <script> loads independently of this module, so window.mosni may not exist yet on
// first mount. mosni/auth's SDK keeps listeners in an ARRAY and pushes, so subscribing here does not
// displace any other component's onChange.
function useSignedInUser(): VerifiedClaims | null {
  const [user, setUser] = useState<VerifiedClaims | null>(null);
  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    function subscribe() {
      if (typeof window.mosni === "undefined") {
        pollTimer = setTimeout(subscribe, 50);
        return;
      }
      window.mosni.onChange((next) => {
        if (!cancelled) setUser((next as VerifiedClaims | null) ?? null);
      });
    }
    subscribe();
    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, []);
  return user;
}

// D-169: a failed load hides the image rather than showing the browser's broken-image icon - the same rule
// PreviewCard's uploader avatar and ShareDialog's GrantAvatar already follow, as a state flag rather than
// an `error` listener that removes the node behind React's back.
function HeaderAvatar({ sub }: { sub: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [sub]);
  if (failed) return null;
  return (
    <img
      src={avatarUrlFor(sub)}
      alt=""
      width={18}
      height={18}
      style={{
        width: "18px",
        height: "18px",
        borderRadius: "50%",
        verticalAlign: "middle",
        margin: "0 0.3em",
      }}
      onError={() => setFailed(true)}
    />
  );
}

// Review session 052 round 4 (Hannah): the header keeps to ONE row at every width (mosni-chrome's
// _layout.scss), and the brand lockup never shrinks - so on a phone the tagline gets only what the brand
// leaves, around 110px at 360px. "Logged in as " alone is ~85px of that, which left the avatar and the
// name - the entire content - truncated away to a bare ellipsis. The words are the only part of the line
// carrying no information, so they are what goes.
//
// A media query would be the natural way to express that, except this subtree is mounted into a
// chrome-owned node outside the SPA's stylesheet; matchMedia in React state is the same rule with the
// same breakpoint ($bp-phone), evaluated where it can actually be read.
const PHONE_QUERY = "(max-width: 480px)"; // mosni-chrome's shared.$bp-phone

function useMatchesMedia(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    // jsdom implements matchMedia only behind a flag, and the header must not take the page down in a
    // browser that lacks it either - treating "unknown" as "wide" keeps the fuller label.
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

export function HeaderIdentity() {
  const user = useSignedInUser();
  const narrow = useMatchesMedia(PHONE_QUERY);
  if (user === null) return null; // signed out: the slot renders as empty as it started

  const name = displayNameFor(user);
  return (
    // A flex row rather than inline content, for one reason: it makes the name truncate against the
    // space that is genuinely left. `.little-link` is the header's shrinking item, so its width is
    // already "whatever the brand did not take"; `max-width: 100%` on a flex child resolves against
    // that, and `min-width: 0` lets it go below its text. A fixed cap cannot do this - it is either too
    // wide (the container clips and eats the name whole, showing `Logged in as …`) or needlessly narrow.
    // `justify-content: flex-end` keeps the line hard against the right edge, which is where the tagline
    // has always sat; without it a shrunk row reads as left-aligned against the brand.
    <span
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        minWidth: 0,
        maxWidth: "100%",
      }}
    >
      {narrow ? null : "Logged in as "}
      <HeaderAvatar sub={user.sub} />
      {/* Review session 052: D-168's fallback renders the raw `sub` whenever no name was captured, and
          since D-196 that sub can be a ~40-character `link:<uuid>` for a claimed invite - which ran
          straight across the top bar, on every page, in the one identity display a user cannot navigate
          away from. `text-overflow` needs a box that can actually be squeezed below its own text, which
          is what the flex sizing below provides. The full value stays in `title`. Nothing here parses the
          sub (invariant 6) - the three sibling sites (both ShareDialog lists, PreviewCard's byline) get
          the identical treatment, each with the width constraint its own container makes available. */}
      <span
        data-identity-name=""
        title={name}
        style={{
          // The flex child that actually gives way. `minWidth: 0` is what permits it (a flex item's
          // automatic minimum is its content, so without it the row overflows instead of ellipsising);
          // the 14rem cap only stops a 40-character sub from dominating a wide desktop header, and does
          // no work at phone widths, where the shrink decides.
          minWidth: 0,
          maxWidth: "14rem",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
    </span>
  );
}
