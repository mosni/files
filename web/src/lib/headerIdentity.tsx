// Live-testing addition (2026-08-06, Hannah): "the top bar right side (it has a slot for this) should show
// 'logged in as [pic] [name]' when logged in".
//
// <mosni-header>'s right-hand slot is `tagline` (mosni-chrome's header.ts: takeSlot(this, "tagline") ->
// rendered into a `.little-link` div, pushed right by its own `margin-left: auto` inside the header's
// `justify-content: space-between` flex row - confirmed by reading mosni-chrome directly, not guessed).
//
// It cannot be filled the normal way. mosni-chrome's MosniElement.connectedCallback runs render() exactly
// ONCE (base-element.ts's `if (this.rendered) return`), and index.html's <mosni-header> has no `tagline`
// slot content to begin with - by the time this module runs, mosnicat.js (a synchronous <script> in <head>,
// D-8/main.tsx's own note on load order) has already consumed whatever slot children existed and built the
// `.little-link` div. Auth state is not known until long after that. So the header lives OUTSIDE the SPA's
// React tree and cannot be reached by ordinary composition.
//
// ⚠ **That does NOT mean it is built by hand.** Review session 052 round 2 (Hannah: *"in the file you
// edited you are creating elements in plain js / the front-end is supposed to use react to avoid exactly
// that"*). This module previously assembled the whole thing imperatively - `document.createElement("img")`,
// `target.append(...)`, `target.replaceChildren()` - which is real UI construction outside React in a
// React 19 + Vite SPA (`technical-baseline.md` §1's pinned stack, §2's markup rules). React's answer to
// "render into a DOM node I do not own" is a **second root**, and this codebase already uses exactly that
// twice: `main.tsx` and `embed.tsx` both `createRoot(node).render(...)`. So `initHeaderIdentity` now only
// LOCATES the chrome-owned slot and mounts a root into it; everything inside is ordinary JSX.
//
// Safe because mosni-chrome renders the header once and never touches `.little-link` again (the
// `if (this.rendered) return` above), so React owning that node's children cannot race the element. This
// is the one narrow thing that would make a portal/root unsafe, and it is the same fact the paragraph
// above already establishes.
//
// The two genuinely imperative `document.createElement` calls left in `web/src` are not this: PreviewCard's
// is D-8's documented `mosni-code` workaround (the element wipes its own JSX children), and archive.ts's is
// the standard synthetic-anchor download trigger, which is not UI at all.

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
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

/** Mounts <HeaderIdentity /> into <mosni-header>'s right-side tagline slot. Never throws into main.tsx's
 *  render path (mirrors initShareTarget/restorePausedUploads) - a missing header just leaves the slot
 *  exactly as it already was. */
export function initHeaderIdentity(): void {
  // ⚠ The slot is polled, and that is not optional pedantry. An earlier version resolved it with a single
  // `querySelector` and returned when it was null - so if the header had not upgraded yet, this silently
  // did nothing FOREVER, with no error anywhere. The built page makes that reachable: `vite build` HOISTS
  // this module's <script> into <head>, so the shipped document loads it alongside mosnicat.js rather than
  // after the header markup. A module script is still deferred, so the element is normally upgraded in
  // time - but "normally" is doing real work in that sentence, and the cost of being wrong was a blank
  // header with nothing to debug.
  //
  // Bounded rather than infinite: if the design system genuinely never loads, the page has much larger
  // problems (nothing is styled at all) and this must not poll for the lifetime of the tab. The auth SDK
  // is no longer polled HERE - useSignedInUser owns that, which is what lets the root mount immediately
  // and render nothing until the session resolves.
  const RETRY_MS = 50;
  const MAX_WAIT_MS = 10_000;
  let waited = 0;

  function start(): void {
    const target = document.querySelector<HTMLElement>("mosni-header .little-link");
    if (target === null) {
      waited += RETRY_MS;
      if (waited <= MAX_WAIT_MS) setTimeout(start, RETRY_MS);
      return;
    }
    // Mount ONCE per node. The old imperative version opened with `target.replaceChildren()`, which
    // silently papered over a double-mount by overwriting; a second React root does not overwrite, it
    // APPENDS - so the same latent bug renders the identity twice. Surfaced by the retry test, where a
    // still-pending timer from an earlier init found the slot as well. Cheap, total, and it also makes
    // `initHeaderIdentity()` safe to call more than once, which nothing currently does but nothing
    // prevents either.
    if (target.dataset.identityMounted === "") return;
    target.dataset.identityMounted = "";
    createRoot(target).render(<HeaderIdentity />);
  }

  start();
}
