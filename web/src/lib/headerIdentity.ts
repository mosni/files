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

import type { Claims } from "../../../app/src/lib/roles.ts";

const AUTH_ORIGIN = "https://auth.mosni.dev"; // matches lib/csp.ts's imgSrc entry and D-169's direct avatar link

function avatarUrlFor(sub: string): string {
  return `${AUTH_ORIGIN}/avatar/${encodeURIComponent(sub)}`;
}

// D-168: name if captured, else the sub, unconditionally - the same fallback rule PreviewCard's uploader
// line and lib/audit.ts's actorLabel() already use, so identity display reads consistently everywhere.
function displayNameFor(user: Claims): string {
  const name = (user as { name?: unknown }).name;
  return typeof name === "string" && name.trim().length > 0 ? name : user.sub;
}

function renderIdentity(target: HTMLElement, user: Claims | null): void {
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

  target.append(displayNameFor(user));
}

/** Wires <mosni-header>'s right-side tagline slot to the signed-in identity. Never throws into main.tsx's
 *  render path (mirrors initShareTarget/restorePausedUploads) - a missing header, or an auth SDK that never
 *  loads, just leaves the slot exactly as it already was. */
export function initHeaderIdentity(): void {
  const slot = document.querySelector<HTMLElement>("mosni-header .little-link");
  if (slot === null) return;
  const target: HTMLElement = slot; // re-bound so the closure below sees a non-null type, not just a non-null value

  let cancelled = false;

  function subscribe(): void {
    // The auth SDK's <script> tag loads independently of this module - never assume window.mosni exists
    // yet (same poll-until-present shape DropZone.tsx and Preview.tsx already use).
    if (typeof window.mosni === "undefined") {
      setTimeout(subscribe, 50);
      return;
    }
    window.mosni.onChange((user) => {
      if (cancelled) return;
      renderIdentity(target, user as Claims | null);
    });
  }

  subscribe();

  // No cleanup path is exposed - this runs once for the page's whole lifetime, same as
  // initShareTarget()/restorePausedUploads(), so there is nothing to cancel from outside. `cancelled` only
  // guards against a callback landing after a hot-reload in dev.
  window.addEventListener("beforeunload", () => {
    cancelled = true;
  });
}
