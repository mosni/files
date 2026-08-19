// Live-testing addition (2026-08-06): the header's right-side tagline slot shows "Logged in as [avatar]
// [name]" once signed in.
//
// E7.5 Wave E: `initHeaderIdentity()` and its DOM-node-hunting mechanics (the `.little-link` polling, the
// mount-once guard, the second `createRoot`) are gone - the header moved into the React tree, and
// `<HeaderIdentity />` is now ordinary composition passed straight to `<Header tagline={...}>` (main.tsx).
// This file renders it the same way any other component test here does: a real root, real DOM queries on
// the render container. Two tests that covered ONLY the deleted polling/mount-once mechanics (a missing
// slot never throwing; waiting for a late-upgrading slot) are gone with it - there is no slot to wait for
// any more. Everything else - the identity rendering itself - is unchanged real logic and keeps its
// coverage.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { HeaderIdentity } from "../../src/lib/headerIdentity.tsx";

type Listener = (user: unknown) => void;

function installSdk() {
  const listeners: Listener[] = [];
  let user: unknown = null;
  (window as unknown as { mosni: unknown }).mosni = {
    user: () => user,
    token: () => (user === null ? null : "tok"),
    onChange: (cb: Listener) => {
      listeners.push(cb);
      cb(user);
    },
    login: () => {},
    logout: () => {},
    toast: () => {},
  };
  return {
    signIn(claims: Record<string, unknown> = {}) {
      user = { sub: "google:123", ...claims };
      listeners.forEach((cb) => cb(user));
    },
    signOut() {
      user = null;
      listeners.forEach((cb) => cb(null));
    },
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

// jsdom ships no matchMedia, and the module treats "unknown" as the wide case on purpose - so without a
// stub every test here would silently exercise only one of the two labels. Controlling it explicitly is
// what lets both branches be asserted; `false` is the default so the pre-existing expectations, which all
// read "Logged in as ...", keep meaning what they did.
let matchMediaMatches = false;

let container: HTMLDivElement;
let root: Root;

describe("HeaderIdentity (live-testing addition, 2026-08-06)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    delete (window as unknown as { mosni?: unknown }).mosni;
    matchMediaMatches = false;
    (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
      matches: matchMediaMatches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders nothing until signed in", async () => {
    act(() => {
      root.render(
        <MemoryRouter>
          <HeaderIdentity />
        </MemoryRouter>,
      );
    });
    expect(container.textContent).toBe("");

    installSdk();
    await flush();
    // Signed out (the SDK's initial `null` notification) - still nothing.
    expect(container.textContent).toBe("");
  });

  it("shows the avatar and the captured name once signed in", async () => {
    const sdk = installSdk();
    act(() => {
      root.render(
        <MemoryRouter>
          <HeaderIdentity />
        </MemoryRouter>,
      );
    });
    await flush();

    sdk.signIn({ name: "Hannah" });
    await flush();

    expect(container.textContent).toBe("Logged in as Hannah");
    const img = container.querySelector("img")!;
    expect(img.src).toBe("https://auth.mosni.dev/avatar/google%3A123");
  });

  it("falls back to the sub when no name claim is present (D-168's rule)", async () => {
    const sdk = installSdk();
    act(() => {
      root.render(
        <MemoryRouter>
          <HeaderIdentity />
        </MemoryRouter>,
      );
    });
    await flush();

    sdk.signIn();
    await flush();

    expect(container.textContent).toBe("Logged in as google:123");
  });

  // Review session 052, round 2 (Hannah: "it is now truncated in the modal but not in the header"). The
  // first pass fixed the two share-dialog lists and the preview byline and MISSED this one - the header
  // appends the identity as a bare text node, so a claimed invite renders ~40 opaque characters
  // (`link:<uuid>`) straight across the top bar, in the one place that is on EVERY page. Same treatment as
  // the other three sites: one line, ellipsis, full value in `title`. No sub is parsed (invariant 6).
  it("truncates a long identity rather than running it across the header", async () => {
    const sdk = installSdk();
    act(() => {
      root.render(
        <MemoryRouter>
          <HeaderIdentity />
        </MemoryRouter>,
      );
    });
    await flush();

    sdk.signIn({ sub: "link:9f86d081-884c-4d1c-9be0-11223344556677" });
    await flush();

    const nameEl = container.querySelector<HTMLElement>("[data-identity-name]");
    expect(nameEl, "the identity must be an element that can be truncated, not a bare text node").not.toBeNull();
    expect(nameEl!.textContent).toBe("link:9f86d081-884c-4d1c-9be0-11223344556677");
    // The full value stays recoverable even though the rendering is clipped.
    expect(nameEl!.getAttribute("title")).toBe("link:9f86d081-884c-4d1c-9be0-11223344556677");
    expect(nameEl!.style.textOverflow).toBe("ellipsis");
    expect(nameEl!.style.whiteSpace).toBe("nowrap");
    expect(nameEl!.style.overflow).toBe("hidden");
    // Review session 052 round 4. text-overflow does nothing on a box that cannot be squeezed below its
    // own text, and a flex item's automatic minimum size IS its text - so `min-width: 0` is the single
    // declaration that makes every other one above take effect. It is also the one a later edit is most
    // likely to drop, because nothing looks wrong in the markup without it.
    expect(nameEl!.style.minWidth).toBe("0px");
    // The cap must not be viewport-relative any more, and this is not a cosmetic swap. Round 3 used
    // `min(14rem, 34vw)` to guess the space left over; the header now shrinks the tagline for real, so
    // the name truncates against what the brand actually left, and a vw guess fights that - at 360px it
    // resolved wider than the container, so the container clipped first and ate the name whole, leaving
    // a bare "Logged in as …". The remaining cap is only to stop a 40-char sub dominating a wide header.
    expect(nameEl!.style.maxWidth).toBe("14rem");
  });

  // Review session 052 round 4 (Hannah: "it must not be a two line header", "the brand must never be
  // truncated"). The header is one row at every width and the brand lockup does not shrink, so at 360px
  // the tagline gets ~110px total - and "Logged in as " is ~85px of it. Rendering the words there costs
  // the avatar and the name, i.e. all of the content. Below $bp-phone they are dropped.
  it("drops the 'Logged in as' words at phone width, keeping the avatar and the name", async () => {
    matchMediaMatches = true;
    const sdk = installSdk();
    act(() => {
      root.render(
        <MemoryRouter>
          <HeaderIdentity />
        </MemoryRouter>,
      );
    });
    await flush();

    sdk.signIn({ sub: "google:123", name: "Hannah" });
    await flush();

    expect(container.textContent).toBe("Hannah");
    expect(container.querySelector("img"), "the avatar is content, not decoration - it must survive").not.toBeNull();
    expect(container.querySelector<HTMLElement>("[data-identity-name]")!.textContent).toBe("Hannah");
  });

  it("keeps the 'Logged in as' words above the phone breakpoint", async () => {
    matchMediaMatches = false;
    const sdk = installSdk();
    act(() => {
      root.render(
        <MemoryRouter>
          <HeaderIdentity />
        </MemoryRouter>,
      );
    });
    await flush();

    sdk.signIn({ sub: "google:123", name: "Hannah" });
    await flush();

    expect(container.textContent).toBe("Logged in as Hannah");
  });

  it("clears back to empty on sign-out", async () => {
    const sdk = installSdk();
    act(() => {
      root.render(
        <MemoryRouter>
          <HeaderIdentity />
        </MemoryRouter>,
      );
    });
    await flush();

    sdk.signIn({ name: "Hannah" });
    await flush();
    sdk.signOut();
    await flush();

    expect(container.textContent).toBe("");
  });

  it("removes the avatar image on a load failure instead of leaving a broken icon", async () => {
    const sdk = installSdk();
    act(() => {
      root.render(
        <MemoryRouter>
          <HeaderIdentity />
        </MemoryRouter>,
      );
    });
    await flush();
    sdk.signIn({ name: "Hannah" });
    await flush();

    const img = container.querySelector("img")!;
    // `error` on an <img> genuinely does not bubble, and React attaches this one directly to the element -
    // so the event stays the shape a real broken image produces (D-200: never assert a shape the product
    // cannot produce).
    await act(async () => {
      img.dispatchEvent(new Event("error"));
    });

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("Logged in as Hannah");
  });

  // E8/D-217: the admin button's absence is the cosmetic half of reveal-nothing - the server's 404
  // (controllers/admin.ts) is the half that actually matters, but the button must not leak the panel's
  // existence to a non-admin browsing normally either.
  describe("admin button (E8, D-217)", () => {
    function render() {
      act(() => {
        root.render(
          <MemoryRouter>
            <HeaderIdentity />
          </MemoryRouter>,
        );
      });
    }

    it("renders for a both-roles admin, linking to /admin", async () => {
      const sdk = installSdk();
      render();
      await flush();
      sdk.signIn({ name: "Hannah", roles: ["files:write", "files:delete"] });
      await flush();

      const link = container.querySelector<HTMLAnchorElement>('a[aria-label="Admin"]');
      expect(link).not.toBeNull();
      expect(link!.getAttribute("href")).toBe("/admin");
    });

    // Hannah, 2026-08-19: *"the admin panel link icon should be to the right of the logged-in user, not
    // the left"*. Asserted as DOM order rather than as a style, because that is what actually decides it.
    it("sits to the RIGHT of the identity, after the name", async () => {
      const sdk = installSdk();
      render();
      await flush();
      sdk.signIn({ name: "Hannah", roles: ["files:write", "files:delete"] });
      await flush();

      const link = container.querySelector('a[aria-label="Admin"]')!;
      const nameEl = container.querySelector("[data-identity-name]")!;
      // Node.DOCUMENT_POSITION_FOLLOWING (4): the link comes after the name in document order.
      expect(nameEl.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("renders for mosni_owner alone", async () => {
      const sdk = installSdk();
      render();
      await flush();
      sdk.signIn({ name: "Hannah", roles: [], mosni_owner: true });
      await flush();

      expect(container.querySelector('a[aria-label="Admin"]')).not.toBeNull();
    });

    it("does NOT render for a files:write-only user", async () => {
      const sdk = installSdk();
      render();
      await flush();
      sdk.signIn({ name: "Hannah", roles: ["files:write"] });
      await flush();

      expect(container.querySelector('a[aria-label="Admin"]')).toBeNull();
    });

    it("does NOT render for a files:read-only user", async () => {
      const sdk = installSdk();
      render();
      await flush();
      sdk.signIn({ name: "Hannah", roles: ["files:read"] });
      await flush();

      expect(container.querySelector('a[aria-label="Admin"]')).toBeNull();
    });

    it("does NOT render for a signed-out visitor", async () => {
      installSdk();
      render();
      await flush();

      expect(container.querySelector('a[aria-label="Admin"]')).toBeNull();
    });
  });
});
