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
// `.little-link` div. Auth state is not known until long after that. So this writes directly into the
// already-rendered `.little-link` node instead of trying to slot anything into <mosni-header> itself - the
// same class of outside-React-root DOM ownership main.tsx already documents for the header element as a
// whole. This depends on mosni-chrome's internal class name rather than a public API, which is the same
// risk D-8's mosni-tab workaround already carries elsewhere in this app; a real mosni-chrome API (D-31) is
// the cleaner long-term fix if this grows past one line of text and an avatar.

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

function renderIdentity(target: HTMLElement, user: VerifiedClaims | null): void {
  target.replaceChildren();
  if (user === null) return; // signed out: leave the slot exactly as empty as it already was

  target.append("Logged in as ");

  const avatar = document.createElement("img");
  avatar.src = avatarUrlFor(user.sub);
  avatar.alt = "";
  avatar.width = 18;
  avatar.height = 18;
  avatar.style.width = "18px";
  avatar.style.height = "18px";
  avatar.style.borderRadius = "50%";
  avatar.style.verticalAlign = "middle";
  avatar.style.margin = "0 0.3em";
  // Broken-image robustness - same rule PreviewCard's uploader avatar already follows (D-169): a failed
  // load removes the image rather than showing the browser's broken-image icon.
  avatar.addEventListener("error", () => avatar.remove(), { once: true });
  target.append(avatar);

  // Review session 052: an ELEMENT, not a bare text node, so the identity can be truncated. D-168's
  // fallback renders the raw `sub` whenever no name was captured, and since D-196 that sub can be a
  // ~40-character `link:<uuid>` for a claimed invite - which ran straight across the top bar, on every
  // page, in the one identity display the user cannot navigate away from. `display: inline-block` and a
  // `max-width` are both load-bearing: `text-overflow` does nothing on an inline box with no width
  // constraint. `title` keeps the full value recoverable. Nothing here parses the sub (invariant 6) -
  // this is presentation only, and the sibling fix in ShareDialog/PreviewCard uses the same treatment.
  const name = document.createElement("span");
  name.dataset.identityName = "";
  name.textContent = displayNameFor(user);
  name.title = displayNameFor(user);
  name.style.display = "inline-block";
  name.style.maxWidth = "14rem";
  name.style.overflow = "hidden";
  name.style.textOverflow = "ellipsis";
  name.style.whiteSpace = "nowrap";
  name.style.verticalAlign = "middle";
  target.append(name);
}

/** Wires <mosni-header>'s right-side tagline slot to the signed-in identity. Never throws into main.tsx's
 *  render path (mirrors initShareTarget/restorePausedUploads) - a missing header, or an auth SDK that never
 *  loads, just leaves the slot exactly as it already was. */
export function initHeaderIdentity(): void {
  // ⚠ BOTH dependencies are polled, and the second one is not optional pedantry. An earlier version
  // resolved the slot with a single `querySelector` and returned when it was null - so if the header had
  // not upgraded yet, this silently did nothing FOREVER, with no error anywhere. That asymmetry (polling
  // for the auth SDK but not for the element) is a guaranteed-invisible failure, and the built page makes
  // it reachable: `vite build` HOISTS this module's <script> from the end of <body> into <head>, so the
  // shipped document loads it alongside mosnicat.js rather than after the header markup. A module script
  // is still deferred, so the element is normally upgraded in time - but "normally" is doing real work in
  // that sentence, and the cost of being wrong was a blank header with nothing to debug.
  //
  // Bounded rather than infinite: if the design system genuinely never loads, the page has much larger
  // problems (nothing is styled at all) and this must not poll for the lifetime of the tab.
  const RETRY_MS = 50;
  const MAX_WAIT_MS = 10_000;
  let waited = 0;

  function start(): void {
    const target = document.querySelector<HTMLElement>("mosni-header .little-link");
    // mosni/auth's SDK keeps listeners in an ARRAY and pushes (client/sdk.ts: `listeners.push(cb)`), so
    // subscribing here does not displace DropZone's or Preview's own onChange - checked by reading the
    // SDK, because a single-callback implementation would have made this module silently break sign-in
    // handling elsewhere on the page. It also defers the first callback until its initial session check
    // settles, so this never flashes "logged out" on a fresh tab.
    if (target === null || typeof window.mosni === "undefined") {
      waited += RETRY_MS;
      if (waited <= MAX_WAIT_MS) setTimeout(start, RETRY_MS);
      return;
    }
    window.mosni.onChange((user) => {
      renderIdentity(target, user as VerifiedClaims | null);
    });
  }

  start();
}
