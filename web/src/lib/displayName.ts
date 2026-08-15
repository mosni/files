// How a person's name is rendered, everywhere this app renders one.
//
// E7-QA1 live-testing round 3 (Hannah): "the username for link accounts is too long and breaks the layout
// in several places on the website, not just the share modal - usernames need to be length limited with
// ellipses everywhere they are rendered."
//
// The long value is not a pathological name, it is the normal case for a link account: D-168's rule is
// "name if captured, else the sub, unconditionally", auth's directory deliberately excludes link-bound
// subs (D-86) so their `name` is always null, and the sub itself is `link:` + a 32-char hex id - 37
// characters with no space, hyphen or other wrap opportunity anywhere in it. CSS will not break such a
// token, so it grows its container until something gives.
//
// Two layers, because neither alone is enough:
//
//   - TRUNCATION_STYLE is what actually fixes the layout. It adapts to whatever width the container really
//     has, so the same name ellipsizes harder in a narrow share-dialog row than in a wide preview card,
//     and no characters are thrown away on a screen with room for them.
//   - truncateDisplayName is the bound that CSS cannot provide: `min-width: 0` + `overflow: hidden` need an
//     ancestor with a real width to shrink against, and a hard character cap keeps an absurd name (or a
//     future id format longer than today's) from mattering even where that isn't true.
//
// Both are applied at every render site, and the full value always stays reachable via `title`.

import type { CSSProperties } from "react";

// Comfortably above any realistic human display name (the longest names in common use run under 30
// characters), while still cutting the 37-character `link:<32 hex>` sub. This is the absurd-input bound,
// not the layout fix - TRUNCATION_STYLE below is what makes a name fit its actual container.
export const MAX_DISPLAY_NAME_CHARS = 32;

// U+2026, not "...", so the ellipsis costs one character rather than three and screen readers announce it
// as an ellipsis.
const ELLIPSIS = "…";

export function truncateDisplayName(value: string, max: number = MAX_DISPLAY_NAME_CHARS): string {
  // Array.from, not slice: a name can contain astral characters (emoji, some scripts), and cutting a
  // UTF-16 string by code unit can split a surrogate pair into a replacement character.
  const characters = Array.from(value);
  if (characters.length <= max) return value;
  return characters.slice(0, max - 1).join("") + ELLIPSIS;
}

// The single-line ellipsis treatment. `minWidth: 0` is the part that actually does the work in a flex row:
// a flex item's automatic minimum size is its content, so without it the item refuses to shrink below its
// text and neither overflow nor textOverflow ever applies. Every parent between this element and the
// bounded ancestor needs minWidth: 0 too, for the same reason.
export const TRUNCATION_STYLE: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// The letter shown when an avatar image cannot be displayed. Taken from the FRONT of the rendered name:
// the previous rule took the sub's last character, which for `link:<hex>` is a random hex digit that means
// nothing to anyone and is identical across roughly one account in sixteen. Falls back to a neutral glyph
// rather than an empty circle when a name has no alphanumeric character at all.
export function avatarInitial(displayName: string): string {
  const match = /\p{Letter}|\p{Number}/u.exec(displayName);
  return match === null ? "?" : match[0].toUpperCase();
}
