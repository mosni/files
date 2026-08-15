import { describe, expect, it } from "vitest";
import {
  MAX_DISPLAY_NAME_CHARS,
  TRUNCATION_STYLE,
  avatarInitial,
  truncateDisplayName,
} from "../../src/lib/displayName.ts";

// The concrete value that started E7-QA1 round 3: a link account's display name is its own sub (D-168's
// "name if captured, else the sub"), and auth's directory excludes link-bound subs (D-86) so the name is
// always null. `link:` + a 32-char hex id = 37 characters with no wrap opportunity anywhere.
const LINK_SUB = "link:9f86d081884c4d1c9be011223344556677";

describe("truncateDisplayName", () => {
  it("leaves a name that already fits completely untouched", () => {
    expect(truncateDisplayName("Hannah")).toBe("Hannah");
  });

  it("leaves a name of exactly the cap untouched - the boundary is inclusive", () => {
    const exact = "x".repeat(MAX_DISPLAY_NAME_CHARS);
    expect(truncateDisplayName(exact)).toBe(exact);
  });

  it("truncates one character past the cap, and the result never exceeds the cap", () => {
    const over = "x".repeat(MAX_DISPLAY_NAME_CHARS + 1);
    const result = truncateDisplayName(over);
    expect(result).not.toBe(over);
    expect(Array.from(result)).toHaveLength(MAX_DISPLAY_NAME_CHARS);
    expect(result.endsWith("…")).toBe(true);
  });

  it("bounds a raw link sub - the value this whole change exists for", () => {
    const result = truncateDisplayName(LINK_SUB);
    expect(Array.from(LINK_SUB).length).toBeGreaterThan(MAX_DISPLAY_NAME_CHARS);
    expect(Array.from(result)).toHaveLength(MAX_DISPLAY_NAME_CHARS);
    expect(result.startsWith("link:")).toBe(true);
  });

  it("bounds an absurdly long name too, which is the point of having a cap at all", () => {
    expect(Array.from(truncateDisplayName("a".repeat(5000)))).toHaveLength(MAX_DISPLAY_NAME_CHARS);
  });

  // Array.from, not String.slice: cutting UTF-16 by code unit can split a surrogate pair and leave a lone
  // half that renders as the replacement character.
  it("never splits an astral character in half", () => {
    const emoji = "😀".repeat(MAX_DISPLAY_NAME_CHARS + 5);
    const result = truncateDisplayName(emoji);
    expect(result).not.toContain("�");
    expect(result.split("\uD83D").length - 1).toBe(result.split("\uDE00").length - 1);
  });

  it("honours an explicit cap", () => {
    expect(truncateDisplayName("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("avatarInitial", () => {
  it("takes the first letter of a real name", () => {
    expect(avatarInitial("Hannah")).toBe("H");
  });

  // The previous rule took the SUB's last character. For `link:<hex>` that is a random hex digit, which
  // carries no meaning and collides across roughly one account in sixteen.
  it("takes a leading letter from a link sub rather than a meaningless trailing hex digit", () => {
    expect(avatarInitial(LINK_SUB)).toBe("L");
    expect(avatarInitial(LINK_SUB)).not.toBe(LINK_SUB.slice(-1).toUpperCase());
  });

  it("skips leading punctuation to find the first real character", () => {
    expect(avatarInitial("  ...ada")).toBe("A");
  });

  it("finds a digit when the name has no letters", () => {
    expect(avatarInitial("42")).toBe("4");
  });

  it("falls back to a neutral glyph rather than rendering an empty circle", () => {
    expect(avatarInitial("---")).toBe("?");
    expect(avatarInitial("")).toBe("?");
  });
});

describe("TRUNCATION_STYLE", () => {
  // minWidth: 0 is the load-bearing property - a flex item's automatic minimum size is its content, so
  // without it the item refuses to shrink and neither overflow nor textOverflow ever applies. Dropping it
  // would silently disable the whole fix while leaving the other three properties looking correct.
  it("carries minWidth: 0, without which the ellipsis never engages in a flex row", () => {
    expect(TRUNCATION_STYLE.minWidth).toBe(0);
    expect(TRUNCATION_STYLE.overflow).toBe("hidden");
    expect(TRUNCATION_STYLE.textOverflow).toBe("ellipsis");
    expect(TRUNCATION_STYLE.whiteSpace).toBe("nowrap");
  });
});
