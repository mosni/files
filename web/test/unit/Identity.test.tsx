(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Avatar, IdentityChip, avatarUrlFor, identityTitle } from "../../src/components/Identity.tsx";

// components/Identity.tsx is the ONE way this app shows a person (Hannah, 2026-08-19), so the pieces every
// call site depends on are asserted here rather than re-asserted per consumer: the URL shape D-169 fixed,
// the tooltip carrying both halves, the name-else-sub fallback D-222 still requires, and the no-picture
// state - which the D-79 screenshots caught rendering as an invisible 20px hole.
let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  act(() => {
    root.render(node);
  });
}

describe("components/Identity.tsx", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  describe("avatarUrlFor", () => {
    // D-169: auth.mosni.dev DIRECTLY - no files.-side proxy - and this exact origin is what lib/csp.ts
    // allow-lists. A files.-relative URL here would 404 and a raw IdP `picture` URL would be CSP-blocked.
    it("points straight at auth.mosni.dev/avatar/<sub>", () => {
      expect(avatarUrlFor("google:1182736455001")).toBe("https://auth.mosni.dev/avatar/google%3A1182736455001");
    });

    it("encodes a sub that contains URL-significant characters", () => {
      expect(avatarUrlFor("link:a/b?c")).toBe("https://auth.mosni.dev/avatar/link%3Aa%2Fb%3Fc");
    });
  });

  describe("identityTitle", () => {
    it("carries the name AND the sub when a name is known", () => {
      expect(identityTitle("user:1", "Hannah")).toBe("Hannah (user:1)");
    });

    // D-222: the directory excludes link-bound accounts, so there is nothing to resolve and the whole raw
    // sub is the tooltip - never a truncated one, since recovering the full value is the tooltip's job.
    it("is the bare sub when there is no name", () => {
      expect(identityTitle("link:9f86d081-884c-4d1c", null)).toBe("link:9f86d081-884c-4d1c");
      expect(identityTitle("link:9f86d081-884c-4d1c", undefined)).toBe("link:9f86d081-884c-4d1c");
    });
  });

  describe("IdentityChip", () => {
    it("shows the name when there is one, with the picture beside it", () => {
      render(<IdentityChip sub="user:owner" name="Hannah" />);
      expect(container.textContent).toBe("Hannah");
      expect(container.querySelector("img")!.getAttribute("src")).toBe(avatarUrlFor("user:owner"));
      expect(container.querySelector("[title]")!.getAttribute("title")).toBe("Hannah (user:owner)");
    });

    it("falls back to the raw sub when the directory knows no name", () => {
      render(<IdentityChip sub="link:9f86d081" />);
      expect(container.textContent).toBe("link:9f86d081");
    });
  });

  describe("Avatar's no-picture state", () => {
    // The D-79 admin-panel screenshots showed this branch occupying its 20px box and rendering nothing an
    // eye could find - a surface token on a dark theme is the colour of the row behind it. The fix is a
    // visible circle, so these assert the marks that make it one rather than merely that a node exists.
    it("renders a visible lettered circle once the image fails", () => {
      render(<Avatar sub="user:e2e-share-grantee2-c81a434" />);
      const img = container.querySelector("img")!;
      act(() => {
        img.dispatchEvent(new Event("error"));
      });

      const fallback = container.querySelector<HTMLElement>("span[aria-hidden]")!;
      expect(container.querySelector("img")).toBeNull();
      expect(fallback.textContent).toBe("4");
      expect(fallback.style.border).not.toBe("");
      expect(fallback.style.color).not.toBe("");
      expect(fallback.style.background).not.toBe("");
    });

    // The LAST character, not the first: every `google:` sub starts with the same seven characters, so a
    // leading initial would be identical for every account of a provider.
    it("uses the last character of the sub, uppercased", () => {
      render(<Avatar sub="google:11827364550019283746b" />);
      act(() => {
        container.querySelector("img")!.dispatchEvent(new Event("error"));
      });
      expect(container.querySelector("span[aria-hidden]")!.textContent).toBe("B");
    });

    // A changed sub is a different person - it must retry rather than inherit the previous one's failure.
    it("retries for a different sub after a failure", () => {
      render(<Avatar sub="user:a" />);
      act(() => {
        container.querySelector("img")!.dispatchEvent(new Event("error"));
      });
      expect(container.querySelector("img")).toBeNull();

      render(<Avatar sub="user:b" />);
      expect(container.querySelector("img")!.getAttribute("src")).toBe(avatarUrlFor("user:b"));
    });
  });
});
