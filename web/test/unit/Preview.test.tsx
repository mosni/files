// React's act() only suppresses its "not configured for act" console warning when this flag is set.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { PreviewPage } from "../../src/pages/Preview.tsx";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";

function makeContext(overrides: Partial<PreviewContext> = {}): PreviewContext {
  return {
    id: "file0000000000id",
    collectionId: "coll000000000000",
    name: "photo.png",
    path: "photo.png",
    bytes: 2_400_000,
    sizeLabel: "2.4 MB",
    protection: "public",
    createdAt: "2026-07-21T00:00:00.000Z",
    previewUrl: "https://files.mosni.dev/f/photo.png",
    directUrl: "https://dl.mosni.dev/photo.png",
    thumbUrl: null,
    directUrlExpiresAt: null,
    kind: "image",
    mimeType: "image/png",
    inline: true,
    width: 800,
    height: 600,
    durationSeconds: null,
    textPreview: null,
    uploaderName: null,
    uploaderAvatarUrl: null,
    isOwner: false,
    canManage: false,
    canDelete: false,
    ancestors: [],
    ...overrides,
  };
}

// D-160/Wave B: the server stamps `embeddedFor` (the request pathname) on the wrapper it serializes.
// Defaults to `/f/${ctx.name}`, which matches every existing call site's own mount path - pass an explicit
// value when the test's mount path is NOT simply the context's own name (e.g. a stale-content repro).
function embedContext(ctx: PreviewContext, embeddedFor: string = `/f/${ctx.name}`) {
  const script = document.createElement("script");
  script.type = "application/json";
  script.id = "preview-context";
  script.textContent = JSON.stringify({ ...ctx, embeddedFor });
  document.head.appendChild(script);
}

// D-123 (E4.1 live-testing findings, Wave D): both PreviewPage and FileBrowser now subscribe to
// window.mosni.onChange to know when auth has genuinely RESOLVED (not just "no embedded target"), the
// same fix DropZone.tsx already had - a real production visit always has the SDK script tag, even an
// anonymous one, so `onChange` firing (even with a null user) is what "ready" means. `token` defaults to
// null (anonymous but ready) since most of this file's fixtures are about anonymous/public targets.
function installMosni(token: string | null = null) {
  (window as unknown as { mosni: unknown }).mosni = {
    token: () => token,
    onChange: (cb: (user: unknown) => void) => cb(null),
  };
}

// Flushes every pending microtask (fetch → res.json() → setState is two awaits deep) by yielding to a
// real macrotask - more robust than a fixed number of `await Promise.resolve()` hops.
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// E5 Wave F: PreviewCard's video branch is a React.lazy() chunk (VideoPreview.tsx, kept out of the main
// bundle - see PreviewCard.tsx's own comment). The FIRST load of a lazy chunk in this test environment can
// take longer than one macrotask to resolve, unlike a fetch mock's already-queued promise - poll rather
// than assume a fixed number of flush()es is enough.
async function flushUntil(predicate: () => boolean, attempts = 20) {
  for (let i = 0; i < attempts && !predicate(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

function routes() {
  return (
    <Routes>
      <Route path="/f/*" element={<PreviewPage />} />
      <Route path="/t/:token" element={<PreviewPage />} />
    </Routes>
  );
}

function renderAt(path: string) {
  act(() => {
    root.render(<MemoryRouter initialEntries={[path]}>{routes()}</MemoryRouter>);
  });
}

// A real in-router navigation trigger. Re-rendering MemoryRouter with different `initialEntries` does
// NOT navigate - it reads them once and keeps its own history thereafter - so the navigation has to go
// through useNavigate, exactly as an in-app link would.
function Navigator({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="navigate" onClick={() => navigate(to)}>
      go
    </button>
  );
}

// Drives the same mounted PreviewPage across a client-side navigation: both paths match the same
// <Route path="/f/*">, so React keeps the component instance (and its refs) alive - which is exactly the
// condition under which a mount-time embedded context can go stale.
function renderNavigating(from: string, to: string) {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[from]}>
        <Navigator to={to} />
        {routes()}
      </MemoryRouter>,
    );
  });
  act(() => {
    (container.querySelector('[data-testid="navigate"]') as HTMLButtonElement).click();
  });
}

// @vidstack/react 1.15.6 (E5.1 live-testing round 4 upgrade) needs IntersectionObserver/ResizeObserver/
// matchMedia internally, none of which jsdom provides - see VideoPreview.test.tsx's own stubs (same
// classes) for the full explanation. This file mounts real VideoPreview instances (via PreviewPage ->
// PreviewCard) for its own video-kind test cases, so it needs the same stubs.
class ImmediatelyIntersectingObserver {
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let container: HTMLDivElement;
let root: Root;

describe("PreviewPage", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", ImmediatelyIntersectingObserver);
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.getElementById("preview-context")?.remove();
    delete (window as unknown as { mosni?: unknown }).mosni;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders from the embedded context without fetching (B2d step 1)", () => {
    embedContext(makeContext());
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    renderAt("/f/photo.png");

    expect(container.textContent).toContain("photo.png");
    expect(container.querySelector("img")).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to fetch when there is no embedded context (private file / client-side nav)", async () => {
    const ctx = makeContext({ kind: "pdf", mimeType: "application/pdf", name: "doc.pdf" });
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(ctx),
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderAt("/f/doc.pdf");

    // Shows the spinner while the fetch is in flight, with no embedded context to paint from.
    expect(container.querySelector(".spinner")).not.toBeNull();

    await flush();

    expect(fetchSpy).toHaveBeenCalledWith("/api/preview/f/doc.pdf", undefined);
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("sends a Bearer header when window.mosni has a token, for both routed shapes", async () => {
    installMosni("test-token");
    const ctx = makeContext({ path: "t/abc12" });
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(ctx) });
    vi.stubGlobal("fetch", fetchSpy);

    renderAt("/t/abc12");

    await flush();

    expect(fetchSpy).toHaveBeenCalledWith("/api/preview/t/abc12", {
      headers: { Authorization: "Bearer test-token" },
    });
  });

  it("renders the not-found panel on a 404, with no embedded context", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve(null) });
    vi.stubGlobal("fetch", fetchSpy);

    renderAt("/f/missing.png");

    await flush();

    expect(container.textContent).toContain("This file doesn't exist, or you don't have access to it.");
  });

  it("renders the not-found panel when the fetch itself fails, with no embedded context", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchSpy);

    renderAt("/f/whatever.png");

    await flush();

    expect(container.textContent).toContain("This file doesn't exist, or you don't have access to it.");
  });

  it("never blanks an already-rendered embedded context when the background refetch fails", async () => {
    installMosni("test-token");
    embedContext(makeContext());
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchSpy);

    renderAt("/f/photo.png");
    expect(container.textContent).toContain("photo.png");

    await flush();

    // Still showing the embedded content, not a blank page or a not-found panel.
    expect(container.textContent).toContain("photo.png");
    expect(container.querySelector("img")).not.toBeNull();
  });

  // The embedded context describes the file the SERVER rendered the document for - it is only valid for
  // the pathname the page mounted at. On a client-side navigation to a different preview the page must
  // fall back to the API (B2d step 2), not keep painting the file it arrived with.
  it("refetches on a client-side navigation instead of showing the file it mounted with", async () => {
    embedContext(makeContext({ name: "first.png", previewUrl: "https://files.mosni.dev/f/first.png" }));
    const second = makeContext({ name: "second.png", previewUrl: "https://files.mosni.dev/f/second.png" });
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(second) });
    vi.stubGlobal("fetch", fetchSpy);

    renderNavigating("/f/first.png", "/f/second.png");
    await flush();

    expect(fetchSpy).toHaveBeenCalledWith("/api/preview/f/second.png", undefined);
    expect(container.textContent).toContain("second.png");
    expect(container.textContent).not.toContain("first.png");
  });

  it("does not refetch when re-rendered at the pathname it mounted at", async () => {
    embedContext(makeContext());
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    renderNavigating("/f/photo.png", "/f/photo.png");
    await flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain("photo.png");
  });

  // D-160/Wave B (finding 3): a COLD mount whose embedded #preview-context was never actually rendered for
  // THIS path - exactly what a PreviewPage remount (e.g. FileBrowser's `key` on a collection change, or an
  // unrelated route unmounting and remounting this component) produces if stale embedded content survives
  // in the document. The old code trusted `embeddedPathRef.current === location.pathname`, which is true
  // by construction on any cold mount (the ref just records wherever the component happened to land, never
  // what the server actually rendered the embed for) - so it painted whatever was left over regardless of
  // whether it described this URL at all.
  it("a cold mount never trusts embedded content that was not actually rendered for this path (finding 3)", async () => {
    embedContext(makeContext({ name: "first.png", previewUrl: "https://files.mosni.dev/f/first.png" }), "/f/first.png");
    const second = makeContext({ name: "second.png", previewUrl: "https://files.mosni.dev/f/second.png" });
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(second) });
    vi.stubGlobal("fetch", fetchSpy);

    renderAt("/f/second.png");
    await flush();

    expect(fetchSpy).toHaveBeenCalledWith("/api/preview/f/second.png", undefined);
    expect(container.textContent).toContain("second.png");
    expect(container.textContent).not.toContain("first.png");
  });

  it("shows the owner indicator only when isOwner is true", () => {
    embedContext(makeContext({ isOwner: true, canManage: true, protection: "unlisted" }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    expect(container.textContent).toContain("You own this file");
    expect(container.textContent).toContain("unlisted");
  });

  it("shows no owner indicator when isOwner is false", () => {
    embedContext(makeContext({ isOwner: false }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    expect(container.textContent).not.toContain("You own this file");
  });

  // E7-QA1 §B2.1/B2.3 (F10/F11): the conflation cannot come back - a superuser (canManage true, isOwner
  // false) sees the manage controls and protection badge but NEVER the ownership prose.
  it("a superuser sees the protection level and manage controls, but never 'You own this file'", () => {
    embedContext(makeContext({ isOwner: false, canManage: true, canDelete: true, protection: "unlisted" }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    expect(container.textContent).not.toContain("You own this file");
    expect(container.textContent).toContain("unlisted");
    expect(container.querySelector('button[aria-label="Rename"]')).not.toBeNull();
  });

  // D-190: a collection owner may delete a file hosted there, but has no rename/protection/move rights -
  // canDelete without canManage must show ONLY the delete affordance.
  it("a delete-only viewer (D-190) sees the delete button but no rename pen, no manage controls, no share", () => {
    embedContext(makeContext({ isOwner: false, canManage: false, canDelete: true }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    expect(container.textContent).not.toContain("You own this file");
    expect(container.querySelector('button[aria-label="Rename"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Delete file"]')).not.toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("Share"))).toBe(false);
  });

  // A grantee: no rename pen, no protection control, no ownership prose, no delete, no share.
  it("a grantee (all three false) sees no manage/delete/share affordances and no ownership prose", () => {
    embedContext(makeContext({ isOwner: false, canManage: false, canDelete: false }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    expect(container.textContent).not.toContain("You own this file");
    expect(container.querySelector('button[aria-label="Rename"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Delete file"]')).toBeNull();
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.includes("Share"))).toBe(false);
  });

  it("picks up the true isOwner from a background refetch when a Bearer is available", async () => {
    installMosni("test-token");
    embedContext(makeContext({ isOwner: false }));
    const refreshed = makeContext({ isOwner: true, canManage: true });
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(refreshed) });
    vi.stubGlobal("fetch", fetchSpy);

    renderAt("/f/photo.png");
    expect(container.textContent).not.toContain("You own this file");

    await flush();

    expect(container.textContent).toContain("You own this file");
  });

  it("renders the uploader's name and avatar when uploaderName is present (D-169)", () => {
    embedContext(
      makeContext({ uploaderName: "Hannah", uploaderAvatarUrl: "https://auth.mosni.dev/avatar/user-1" }),
    );
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    expect(container.textContent).toContain("Hannah");
    const avatar = container.querySelector("img[alt='']");
    expect(avatar?.getAttribute("src")).toBe("https://auth.mosni.dev/avatar/user-1");
  });

  it("renders no uploader block at all when uploaderAvatarUrl is null (no uploaderSub at all) - never 'Unknown' (D-92/D-136)", () => {
    embedContext(makeContext({ uploaderName: null, uploaderAvatarUrl: null }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    expect(container.textContent).not.toContain("Unknown");
    expect(container.querySelector("img[alt='']")).toBeNull();
  });

  it("renders the avatar with no name when uploaderName is null but uploaderAvatarUrl is present (C1/C4)", () => {
    embedContext(
      makeContext({ uploaderName: null, uploaderAvatarUrl: "https://auth.mosni.dev/avatar/user-1" }),
    );
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    const avatar = container.querySelector("img[alt='']");
    expect(avatar?.getAttribute("src")).toBe("https://auth.mosni.dev/avatar/user-1");
    expect(avatar?.parentElement?.querySelector("span.little-link")).toBeNull();
  });

  it("renders no uploader block when uploaderAvatarUrl is null even if a name exists (C1: the block gates on the avatar, not the name)", () => {
    // Not a reachable server state today (buildPreviewContext sets uploaderAvatarUrl to null exactly when
    // uploaderSub is null, and uploaderName can only be non-null when uploaderSub is non-null) - covered
    // anyway so the component's own gating contract doesn't silently drift.
    embedContext(makeContext({ uploaderName: "Hannah", uploaderAvatarUrl: null }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    expect(container.textContent).not.toContain("Hannah");
    expect(container.querySelector("img[alt='']")).toBeNull();
  });

  // Mirrors PreviewCard.tsx's own local-time formatting - the point under test is the SHAPE/ordering of
  // the rendered line, not a specific timezone offset (which depends on wherever this suite runs).
  function expectedLocalDateTime(iso: string): string {
    const d = new Date(iso);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return `${date} ${time}`;
  }

  // E5.1 live-testing round 2 ("the section should probably say something like 'uploaded 2026-08-04
  // 12:20 by [image] hannah', also make it local time"): one line, always showing the upload timestamp in
  // the VIEWER'S OWN local time, "by <avatar> <name>" appended only when there is an uploader to show.
  it("renders 'uploaded <when> by <who>' as one line, in local time, with the upload date always present", () => {
    const createdAt = "2026-08-04T12:20:00.000Z";
    embedContext(
      makeContext({
        createdAt,
        uploaderName: "hannah",
        uploaderAvatarUrl: "https://auth.mosni.dev/avatar/user-1",
      }),
    );
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    // Adjacent <span>s carry no literal whitespace between them (real visual spacing comes from the
    // flex row's `gap`, not text content) - assert the pieces exist in order, not a literal joined string.
    expect(container.textContent).toContain(`uploaded ${expectedLocalDateTime(createdAt)}`);
    expect(container.textContent).not.toContain("UTC");
    expect(container.textContent).toContain("by");
    expect(container.textContent).toContain("hannah");
  });

  it("still shows the upload date when there is no uploader to show at all", () => {
    const createdAt = "2026-08-04T12:20:00.000Z";
    embedContext(makeContext({ createdAt, uploaderAvatarUrl: null }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    expect(container.textContent).toContain(`uploaded ${expectedLocalDateTime(createdAt)}`);
    expect(container.textContent).not.toContain(" by ");
  });

  // E5.1 live-testing round 2 (found live, second report - "not fixed, now shows '...UTC by' (nothing
  // else)"): an avatar that fails to LOAD client-side, with no captured name to fall back to, must not
  // leave a dangling "by" with nothing after it - the whole "by ..." segment must disappear.
  it("shows no 'by' segment at all when the avatar fails to load and there is no name either", () => {
    embedContext(
      makeContext({
        uploaderName: null,
        uploaderAvatarUrl: "https://auth.mosni.dev/avatar/user-1",
      }),
    );
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    const img = container.querySelector("img[alt='']") as HTMLImageElement;
    act(() => {
      img.dispatchEvent(new Event("error"));
    });

    expect(container.textContent).not.toContain("by");
    expect(container.querySelector("img[alt='']")).toBeNull();
  });

  // E5.1 live-testing round 2 (avatar 404 found live): a broken avatar image must never show the
  // browser's own broken-image icon - the <img> hides itself on error rather than rendering nothing at
  // its src, and the name (if any) still renders.
  it("hides the avatar image on a load failure, but keeps the uploader's name", async () => {
    embedContext(
      makeContext({
        uploaderName: "hannah",
        uploaderAvatarUrl: "https://auth.mosni.dev/avatar/user-1",
      }),
    );
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    const img = container.querySelector("img[alt='']") as HTMLImageElement;
    expect(img).not.toBeNull();
    act(() => {
      img.dispatchEvent(new Event("error"));
    });

    expect(container.querySelector("img[alt='']")).toBeNull();
    expect(container.textContent).toContain("hannah");
  });

  // E5.1 live-testing round 2 ("I don't like the You own this file (unlisted) panel at all, should also
  // be two icons"): an icon-labelled ownership badge and an icon-labelled protection badge, both directly
  // under the header rather than a separate boxed text panel.
  it("shows an icon-labelled ownership badge and protection badge for the owner, one per level", () => {
    embedContext(makeContext({ isOwner: true, canManage: true, protection: "secret" }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    expect(container.querySelector('mosni-icon[name="user-check"]')).not.toBeNull();
    expect(container.querySelector('mosni-icon[name="key"]')).not.toBeNull(); // secret -> key
    expect(container.textContent).toContain("secret");
  });

  // E5.1 live-testing round 2 ("the rename pencil should be in the title header, not the bottom panel, we
  // do not need to show the file name twice"): moved from ManageControls.tsx into PreviewCard.tsx's own
  // header, alongside the <h1> it edits - see ManageControls.test.tsx for the tests this replaced.
  describe("rename (header)", () => {
    function ownedContext(overrides: Partial<PreviewContext> = {}): PreviewContext {
      return makeContext({ isOwner: true, canManage: true, canDelete: true, ...overrides });
    }

    it("starts collapsed behind a pencil icon button in the header, next to the <h1>, not repeated below", () => {
      embedContext(ownedContext());
      vi.stubGlobal("fetch", vi.fn());

      renderAt("/f/photo.png");

      expect(container.querySelector("h1")?.textContent).toBe("photo.png");
      const renameButton = container.querySelector('button[aria-label="Rename"]') as HTMLButtonElement;
      expect(renameButton).not.toBeNull();
      expect(renameButton.className).toContain("btn-icon");
      expect(container.querySelectorAll('button[aria-label="Rename"]').length).toBe(1);
      // Not repeated inside ManageControls' own panel below (the breadcrumb's trailing segment also
      // says "photo.png", same as any breadcrumb trail ending at the current page - that's not the
      // duplication the fix targets).
      expect(container.querySelector(".panel")?.textContent).not.toContain("photo.png");
    });

    // "can we just make the existing title editable without turning it into an input?" - the SAME <h1>
    // gains `contentEditable`, rather than being swapped for a separate <input>. Simulated the way a real
    // contentEditable edit lands in the DOM: set `.textContent` directly on the still-mounted <h1>, then
    // dispatch the "input" event React listens for.
    it("editing turns the SAME <h1> contentEditable, rather than swapping in an <input>", () => {
      embedContext(ownedContext());
      vi.stubGlobal("fetch", vi.fn());

      renderAt("/f/photo.png");
      const heading = container.querySelector("h1") as HTMLHeadingElement;
      act(() => (container.querySelector('button[aria-label="Rename"]') as HTMLButtonElement).click());

      expect(container.querySelector("h1")).toBe(heading); // the SAME element, not remounted
      expect(heading.getAttribute("contenteditable")).toBe("true");
      expect(heading.getAttribute("aria-label")).toBe("File name");
      expect(container.querySelector('input[aria-label="File name"]')).toBeNull();
    });

    it("submitting the header rename PATCHes /api/files/:id and updates the rendered name", async () => {
      installMosni("test-token");
      embedContext(ownedContext());
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(ownedContext({ name: "renamed.png" })),
      });
      vi.stubGlobal("fetch", fetchSpy);

      renderAt("/f/photo.png");
      act(() => (container.querySelector('button[aria-label="Rename"]') as HTMLButtonElement).click());

      const heading = container.querySelector('h1[aria-label="File name"]') as HTMLHeadingElement;
      act(() => {
        heading.textContent = "renamed.png";
        heading.dispatchEvent(new Event("input", { bubbles: true }));
      });

      await act(async () => {
        (container.querySelector('button[aria-label="Save name"]') as HTMLButtonElement).click();
        await flush();
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/files/file0000000000id",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "renamed.png" }) }),
      );
      expect(container.querySelector("h1")?.textContent).toBe("renamed.png");
    });

    it("pressing Escape discards the edit and restores the original name in the DOM", () => {
      embedContext(ownedContext());
      vi.stubGlobal("fetch", vi.fn());

      renderAt("/f/photo.png");
      act(() => (container.querySelector('button[aria-label="Rename"]') as HTMLButtonElement).click());

      const heading = container.querySelector('h1[aria-label="File name"]') as HTMLHeadingElement;
      act(() => {
        heading.textContent = "typed-but-abandoned.png";
        heading.dispatchEvent(new Event("input", { bubbles: true }));
      });
      act(() => {
        heading.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });

      expect(container.querySelector("h1")?.textContent).toBe("photo.png");
      expect(container.querySelector("h1")?.getAttribute("contenteditable")).not.toBe("true");
    });

    it("Save stays disabled until the text actually changes", () => {
      embedContext(ownedContext());
      vi.stubGlobal("fetch", vi.fn());

      renderAt("/f/photo.png");
      act(() => (container.querySelector('button[aria-label="Rename"]') as HTMLButtonElement).click());

      const save = container.querySelector('button[aria-label="Save name"]') as HTMLButtonElement;
      expect(save.disabled).toBe(true);

      const heading = container.querySelector('h1[aria-label="File name"]') as HTMLHeadingElement;
      act(() => {
        heading.textContent = "renamed.png";
        heading.dispatchEvent(new Event("input", { bubbles: true }));
      });

      expect(save.disabled).toBe(false);
    });
  });

  // E5.1 live-testing round 2 ("move trash next to pencil"): delete moved out of ManageControls.tsx into
  // the SAME header row as rename - see web/test/unit/ManageControls.test.tsx for confirmation that
  // component no longer renders it at all.
  describe("delete (header)", () => {
    function ownedContext(overrides: Partial<PreviewContext> = {}): PreviewContext {
      return makeContext({ isOwner: true, canManage: true, canDelete: true, ...overrides });
    }

    it("sits next to the rename pencil as a bare trash icon, and requires a confirm step", async () => {
      installMosni("test-token");
      embedContext(ownedContext());
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 204 });
      vi.stubGlobal("fetch", fetchSpy);
      const assignSpy = vi.fn();
      vi.stubGlobal("location", { ...window.location, assign: assignSpy });

      renderAt("/f/photo.png");

      const renameButton = container.querySelector('button[aria-label="Rename"]') as HTMLButtonElement;
      const deleteButton = container.querySelector('button[aria-label="Delete file"]') as HTMLButtonElement;
      expect(deleteButton).not.toBeNull();
      expect(deleteButton.className).toContain("btn-icon");
      expect(renameButton.parentElement).toBe(deleteButton.parentElement); // same row

      // installMosni's Bearer triggers Preview.tsx's own background owner-status refetch on mount, so
      // "no request yet" is scoped to the DELETE call specifically, not fetch overall.
      act(() => deleteButton.click());
      expect(fetchSpy).not.toHaveBeenCalledWith("/api/files/file0000000000id", expect.objectContaining({ method: "DELETE" }));
      expect(container.textContent).toContain("Delete permanently?");
      // Rename is hidden while the delete confirmation is showing - one mode at a time.
      expect(container.querySelector('button[aria-label="Rename"]')).toBeNull();

      await act(async () => {
        (container.querySelector('button[aria-label="Yes, delete"]') as HTMLButtonElement).click();
        await flush();
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/files/file0000000000id",
        expect.objectContaining({ method: "DELETE", headers: expect.objectContaining({ Authorization: "Bearer test-token" }) }),
      );
      expect(assignSpy).toHaveBeenCalledWith("/");
    });

    it("cancelling the delete confirmation issues no request and restores the pencil/trash row", () => {
      embedContext(ownedContext());
      vi.stubGlobal("fetch", vi.fn());

      renderAt("/f/photo.png");
      act(() => (container.querySelector('button[aria-label="Delete file"]') as HTMLButtonElement).click());
      act(() => (container.querySelector('button[aria-label="Cancel delete"]') as HTMLButtonElement).click());

      expect(container.querySelector('button[aria-label="Delete file"]')).not.toBeNull();
      expect(container.querySelector('button[aria-label="Rename"]')).not.toBeNull();
      expect(container.textContent).not.toContain("Delete permanently?");
    });
  });

  // E5 Wave F: kind video now renders VideoPreview (Vidstack + a runtime capability fallback), not a bare
  // <video controls> - see web/test/unit/VideoPreview.test.tsx for that component's own coverage. This
  // just confirms PreviewCard wires the video kind to it at all.
  it("renders the video preview (VideoPreview) for kind video", async () => {
    vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
    embedContext(makeContext({ kind: "video", mimeType: "video/mp4", name: "clip.mp4", width: 1920, height: 1080 }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/clip.mp4");
    await flushUntil(() => container.querySelector("[data-media-player]") !== null);

    expect(container.querySelector("[data-media-player]")).not.toBeNull();
  });

  // D1/AC-D1 (E5.1 Wave D): reaches the player instead of being short-circuited by the old
  // canDefinitelyNotPlay() pre-check - confirming PreviewCard/VideoPreview wire an exotic MIME type
  // through correctly. The exhaustive "eventually falls back" proof (D2's deadline, and the height/
  // progress/error variants around it) lives in VideoPreview.test.tsx and
  // VideoPreview.readiness.test.tsx, with fake timers - this integration-level test only confirms the
  // wiring, since a real 8-second wait has no place in this suite.
  it("reaches the video player for an exotic MIME type rather than being short-circuited (D1)", async () => {
    vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
    embedContext(makeContext({ kind: "video", mimeType: "video/x-matroska", name: "clip.mkv", width: 1920, height: 1080 }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/clip.mkv");
    await flushUntil(() => container.querySelector("[data-media-player]") !== null);

    expect(container.querySelector("[data-media-player]")).not.toBeNull();
  });

  // E5 Wave E (D-141): the plain iframe-to-dl. fallback for a snippet-less text file is gone - above the
  // 256KB cap (makeContext's default `bytes` is 2.4MB) with no ingest snippet, the panel offers only the
  // download action; nothing renders for content that does not exist.
  it("renders only the download action for kind text when there is no captured textPreview and the file is above the cap", () => {
    embedContext(makeContext({ kind: "text", mimeType: "text/plain", name: "notes.txt", textPreview: null }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/notes.txt");

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector(".code")).toBeNull();
    const link = container.querySelector(".panel a.btn") as HTMLAnchorElement;
    expect(link.textContent).toBe("Download to view in full");
    expect(link.getAttribute("href")).toBe("https://dl.mosni.dev/photo.png");
  });

  // session 013 debt: PreviewCard's CodeBlock (mosni-code wrapper) had no coverage at any tier.
  // E7.5: CodeBlock is gone - <Code> from @mosni/react renders real DOM (div.code > pre > code).
  it("renders <Code> instead of an iframe for kind text when a textPreview was captured at ingest", () => {
    embedContext(
      makeContext({ kind: "text", mimeType: "text/plain", name: "notes.txt", textPreview: "Hello from the file." }),
    );
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/notes.txt");

    expect(container.querySelector("iframe")).toBeNull();
    const code = container.querySelector(".code code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe("Hello from the file.");
  });

  // E5 Wave E (D-141): a text file within the 256KB cap fetches and renders its FULL content, not just
  // the 400-char ingest snippet.
  describe("full text preview (E5 Wave E)", () => {
    it("fetches and renders the full file when within the 256KB cap", async () => {
      embedContext(
        makeContext({
          kind: "text",
          mimeType: "text/plain",
          name: "notes.txt",
          bytes: 1000,
          textPreview: "short snippet",
        }),
      );
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("the full file body") });
      vi.stubGlobal("fetch", fetchSpy);

      renderAt("/f/notes.txt");

      await flush();

      expect(fetchSpy).toHaveBeenCalledWith("https://dl.mosni.dev/photo.png");
      const code = container.querySelector(".code code");
      expect(code?.textContent).toBe("the full file body");
    });

    it("keeps showing the ingest snippet while the full-text fetch is in flight - never an empty block", () => {
      embedContext(
        makeContext({ kind: "text", mimeType: "text/plain", name: "notes.txt", bytes: 1000, textPreview: "short snippet" }),
      );
      // A fetch that never resolves within this test - simulates "still in flight".
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      renderAt("/f/notes.txt");

      const code = container.querySelector(".code code");
      expect(code?.textContent).toBe("short snippet");
    });

    it("falls back to the ingest snippet when the full-text fetch fails", async () => {
      embedContext(
        makeContext({ kind: "text", mimeType: "text/plain", name: "notes.txt", bytes: 1000, textPreview: "short snippet" }),
      );
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

      renderAt("/f/notes.txt");
      await flush();

      const code = container.querySelector(".code code");
      expect(code?.textContent).toBe("short snippet");
    });

    it("stays on the snippet+download fallback above the cap and never fetches", () => {
      embedContext(
        makeContext({
          kind: "text",
          mimeType: "text/plain",
          name: "notes.txt",
          bytes: 500_000,
          textPreview: "short snippet",
        }),
      );
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      renderAt("/f/notes.txt");

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(container.querySelector(".code code")?.textContent).toBe("short snippet");
      expect(container.querySelector(".panel a.btn")?.textContent).toBe("Download to view in full");
    });

    it("passes a language derived from the filename's inner extension to <Code>", async () => {
      embedContext(
        makeContext({
          kind: "text",
          mimeType: "text/plain",
          name: "script.py.txt",
          bytes: 1000,
          textPreview: "print('hi')",
        }),
      );
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("print('hi')") });
      vi.stubGlobal("fetch", fetchSpy);

      renderAt("/f/script.py.txt");
      await flush();

      const code = container.querySelector(".code code");
      expect(code?.className).toBe("language-python");
    });

    it("passes no language for a plain .txt file - Prism degrades to unhighlighted", () => {
      embedContext(
        makeContext({ kind: "text", mimeType: "text/plain", name: "notes.txt", bytes: 500_000, textPreview: "plain text" }),
      );
      vi.stubGlobal("fetch", vi.fn());

      renderAt("/f/notes.txt");

      expect(container.querySelector(".code code")?.className).toBe("language-");
    });
  });

  it("renders the download card for kind other", () => {
    embedContext(makeContext({ kind: "other", mimeType: "application/octet-stream", name: "archive.zip", inline: false }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/archive.zip");

    expect(container.textContent).toContain("This file type does not preview inline");
    const link = container.querySelector("a.btn") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("https://dl.mosni.dev/photo.png");
  });

  it("renders the download card when inline is false even for an otherwise-inlinable kind", () => {
    embedContext(makeContext({ kind: "image", inline: false }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    expect(container.textContent).toContain("This file type does not preview inline");
    expect(container.querySelector("img")).toBeNull();
  });

  it("sets image width/height attributes from the context when known", () => {
    embedContext(makeContext({ kind: "image", width: 640, height: 480 }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("width")).toBe("640");
    expect(img.getAttribute("height")).toBe("480");
  });

  it("always renders CopyLink with previewUrl and directUrl", () => {
    embedContext(makeContext());
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    const previewInput = container.querySelector(".copy-field-primary input") as HTMLInputElement;
    expect(previewInput.value).toBe("https://files.mosni.dev/f/photo.png");
  });

  // G1 (E5.1 Wave G, finding 7): the detail page never rendered a breadcrumb trail. Built from
  // `ctx.path`/`ctx.previewUrl` (already carried by the context - no re-derivation, no separate fetch),
  // reusing FileBrowser's own crumb markup/aria-label so the two surfaces match.
  describe("breadcrumbs (G1, E7-QA1 §B2.2/F12: every ancestor is a real server-sent link)", () => {
    it("renders Home, each ancestor as a real anchor built from ctx.ancestors, and the file's own name as the current location", () => {
      embedContext(
        makeContext({
          name: "img.png",
          path: "Photos/Vacation/img.png",
          previewUrl: "https://files.mosni.dev/f/Photos/Vacation/img.png",
          ancestors: [
            { id: "coll-photos", name: "Photos", previewUrl: "https://files.mosni.dev/f/Photos" },
            { id: "coll-vacation", name: "Vacation", previewUrl: "https://files.mosni.dev/f/Photos/Vacation" },
          ],
        }),
        "/f/Photos/Vacation/img.png",
      );
      vi.stubGlobal("fetch", vi.fn());

      renderAt("/f/Photos/Vacation/img.png");

      const nav = container.querySelector('nav[aria-label="Breadcrumb"]');
      expect(nav).not.toBeNull();
      expect(nav!.textContent).toContain("Home");
      expect(nav!.textContent).toContain("Photos");
      expect(nav!.textContent).toContain("Vacation");
      expect(nav!.textContent).toContain("img.png");

      // Every crumb is a REAL <a>, built from the server-sent previewUrl - never assembled client-side.
      const links = Array.from(nav!.querySelectorAll("a"));
      expect(links.map((a) => a.textContent)).toEqual(["Home", "Photos", "Vacation", "img.png"]);
      const photosCrumb = links.find((a) => a.textContent === "Photos")!;
      expect(photosCrumb.getAttribute("href")).toBe("/f/Photos");
      const vacationCrumb = links.find((a) => a.textContent === "Vacation")!;
      expect(vacationCrumb.getAttribute("href")).toBe("/f/Photos/Vacation");
    });

    // D-100 (non-negotiable, §0.2): a secret file's display path is redacted to its bare name server-side
    // (displayPathFor), and its ancestors are correspondingly empty - the breadcrumb must not reintroduce
    // a collection name that was deliberately hidden.
    it("shows only Home and the file's own name for a redacted path - never a collection name (D-100)", () => {
      embedContext(
        makeContext({ name: "hidden.txt", path: "hidden.txt", previewUrl: "https://files.mosni.dev/t/Ab3xY", ancestors: [] }),
        "/t/Ab3xY",
      );
      vi.stubGlobal("fetch", vi.fn());

      renderAt("/t/Ab3xY");

      const nav = container.querySelector('nav[aria-label="Breadcrumb"]');
      expect(nav!.textContent).toContain("Home");
      expect(nav!.textContent).toContain("hidden.txt");
      expect(nav!.querySelectorAll("a")).toHaveLength(2); // Home + the file's own current-location crumb
    });

    // A root-level file (E7-QA1's own acceptance criterion): empty ancestors renders exactly "Home / <file>".
    it("a root-level file (empty ancestors) renders exactly Home / <file>", () => {
      embedContext(makeContext({ name: "root-file.png", path: "root-file.png", ancestors: [] }), "/f/root-file.png");
      vi.stubGlobal("fetch", vi.fn());

      renderAt("/f/root-file.png");

      const nav = container.querySelector('nav[aria-label="Breadcrumb"]')!;
      const links = Array.from(nav.querySelectorAll("a")).map((a) => a.textContent);
      expect(links).toEqual(["Home", "root-file.png"]);
    });

    it("the current-location crumb is a real anchor to the file's own previewUrl (D-121)", () => {
      embedContext(makeContext({ name: "photo.png", path: "photo.png" }), "/f/photo.png");
      vi.stubGlobal("fetch", vi.fn());

      renderAt("/f/photo.png");

      const nav = container.querySelector('nav[aria-label="Breadcrumb"]')!;
      const currentCrumb = Array.from(nav.querySelectorAll("a")).find((a) => a.textContent === "photo.png");
      expect(currentCrumb?.getAttribute("href")).toBe("/f/photo.png");
      expect(currentCrumb?.getAttribute("aria-current")).toBe("location");
    });

    // A modifier/middle click must be left to the browser, not intercepted by the SPA navigation -
    // isPlainLeftClick already guards Home and the current crumb; this proves the SAME guard covers an
    // ancestor crumb now that it is a real anchor too.
    it("a modifier click on an ancestor crumb is NOT intercepted - the browser handles it", () => {
      embedContext(
        makeContext({
          name: "img.png",
          path: "Photos/img.png",
          ancestors: [{ id: "coll-photos", name: "Photos", previewUrl: "https://files.mosni.dev/f/Photos" }],
        }),
        "/f/Photos/img.png",
      );
      vi.stubGlobal("fetch", vi.fn());

      renderAt("/f/Photos/img.png");

      const nav = container.querySelector('nav[aria-label="Breadcrumb"]')!;
      const photosCrumb = Array.from(nav.querySelectorAll("a")).find((a) => a.textContent === "Photos")!;
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
      const prevented = !photosCrumb.dispatchEvent(event);
      expect(prevented).toBe(false); // preventDefault() was NOT called - the browser's own ctrl-click handling applies
    });
  });

  // E4.1 Wave C (D-107 client half): the same route now resolves to EITHER a file or a collection - these
  // mount <FileBrowser> instead of <PreviewCard> when the server says the target is a collection.
  describe("collection targets (E4.1 Wave C)", () => {
    function embedCollection(collectionId: string, embeddedFor: string) {
      const script = document.createElement("script");
      script.type = "application/json";
      script.id = "preview-context";
      script.textContent = JSON.stringify({ kind: "collection", collectionId, embeddedFor });
      document.head.appendChild(script);
    }

    function browseResponse() {
      return { ok: true, json: () => Promise.resolve({ breadcrumb: [], collections: [], files: [], nextOffset: null }) };
    }

    it("mounts FileBrowser (not PreviewCard) from an embedded CollectionLocation, with zero round trips for the target itself", async () => {
      installMosni();
      embedCollection("coll-abc", "/f/Photos");
      const fetchSpy = vi.fn().mockImplementation((url: string) =>
        url.startsWith("/api/browse") ? Promise.resolve(browseResponse()) : Promise.reject(new Error("unexpected fetch")),
      );
      vi.stubGlobal("fetch", fetchSpy);

      renderAt("/f/Photos");
      await flush();

      // No /api/preview round trip for the TARGET itself - only FileBrowser's own /api/browse call.
      expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining("/api/preview"), expect.anything());
      expect(container.querySelector('nav[aria-label="Breadcrumb"]')).not.toBeNull(); // FileBrowser mounted
      expect(container.querySelector(".copy-field-primary")).toBeNull(); // not a PreviewCard
    });

    it("resolves a collection via the API when there is no embedded target (client-side navigation)", async () => {
      installMosni();
      const fetchSpy = vi.fn().mockImplementation((url: string) => {
        if (url === "/api/preview/f/Vacation") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ kind: "collection", collectionId: "coll-vac" }) });
        }
        if (url.startsWith("/api/browse")) return Promise.resolve(browseResponse());
        return Promise.reject(new Error(`unexpected fetch ${url}`));
      });
      vi.stubGlobal("fetch", fetchSpy);

      renderAt("/f/Vacation");
      expect(container.querySelector(".spinner")).not.toBeNull();

      await flush();

      expect(container.querySelector('nav[aria-label="Breadcrumb"]')).not.toBeNull(); // FileBrowser mounted
      expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("collectionId=coll-vac"), undefined);
    });

    it("resolves via /t/:token too, and threads the token through to FileBrowser's own browse fetch", async () => {
      installMosni();
      const fetchSpy = vi.fn().mockImplementation((url: string) => {
        if (url === "/api/preview/t/sec12") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ kind: "collection", collectionId: "coll-sec" }) });
        }
        if (url.startsWith("/api/browse")) return Promise.resolve(browseResponse());
        return Promise.reject(new Error(`unexpected fetch ${url}`));
      });
      vi.stubGlobal("fetch", fetchSpy);

      renderAt("/t/sec12");
      await flush();

      expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("token=sec12"), undefined);
    });

    it("a client-side navigation from a file to a collection swaps PreviewCard for FileBrowser", async () => {
      installMosni();
      embedContext(makeContext({ name: "first.png", previewUrl: "https://files.mosni.dev/f/first.png" }));
      const fetchSpy = vi.fn().mockImplementation((url: string) => {
        if (url === "/api/preview/f/Photos") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ kind: "collection", collectionId: "coll-photos" }) });
        }
        if (url.startsWith("/api/browse")) return Promise.resolve(browseResponse());
        return Promise.reject(new Error(`unexpected fetch ${url}`));
      });
      vi.stubGlobal("fetch", fetchSpy);

      renderNavigating("/f/first.png", "/f/Photos");
      await flush();

      expect(container.querySelector('nav[aria-label="Breadcrumb"]')).not.toBeNull(); // FileBrowser mounted
      expect(container.querySelector("img")).toBeNull();
    });
  });
});
