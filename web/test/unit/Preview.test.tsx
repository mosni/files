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

let container: HTMLDivElement;
let root: Root;

describe("PreviewPage", () => {
  beforeEach(() => {
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
    embedContext(makeContext({ isOwner: true, protection: "unlisted" }));
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

  it("picks up the true isOwner from a background refetch when a Bearer is available", async () => {
    installMosni("test-token");
    embedContext(makeContext({ isOwner: false }));
    const refreshed = makeContext({ isOwner: true });
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(refreshed) });
    vi.stubGlobal("fetch", fetchSpy);

    renderAt("/f/photo.png");
    expect(container.textContent).not.toContain("You own this file");

    await flush();

    expect(container.textContent).toContain("You own this file");
  });

  it("renders the uploader's name and avatar when uploaderName is present (D-136)", () => {
    embedContext(
      makeContext({ uploaderName: "Hannah", uploaderAvatarUrl: "https://files.mosni.dev/api/avatar/file0000000000id" }),
    );
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    expect(container.textContent).toContain("Hannah");
    const avatar = container.querySelector("img[alt='']");
    expect(avatar?.getAttribute("src")).toBe("https://files.mosni.dev/api/avatar/file0000000000id");
  });

  it("renders no uploader block at all when uploaderName is null - never 'Unknown' (D-92/D-136)", () => {
    embedContext(makeContext({ uploaderName: null, uploaderAvatarUrl: null }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    expect(container.textContent).not.toContain("Unknown");
    expect(container.querySelector("img[alt='']")).toBeNull();
  });

  it("renders the uploader's name with no avatar image when uploaderAvatarUrl is null but a name exists", () => {
    // Not a real production state today (both are set together) but the component contract should not
    // assume they always travel as a pair.
    embedContext(makeContext({ uploaderName: "Hannah", uploaderAvatarUrl: null }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/photo.png");

    expect(container.textContent).toContain("Hannah");
    expect(container.querySelector("img[alt='']")).toBeNull();
  });

  // E5 Wave F: kind video now renders VideoPreview (Vidstack + a runtime capability fallback), not a bare
  // <video controls> - see web/test/unit/VideoPreview.test.tsx for that component's own coverage. This
  // just confirms PreviewCard wires the video kind to it at all.
  it("renders the video preview (VideoPreview) for kind video", async () => {
    vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
    embedContext(makeContext({ kind: "video", mimeType: "video/mp4", name: "clip.mp4", width: 1920, height: 1080 }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/clip.mp4");
    await flushUntil(() => container.querySelector("media-player") !== null);

    expect(container.querySelector("media-player")).not.toBeNull();
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
    await flushUntil(() => container.querySelector("media-player") !== null);

    expect(container.querySelector("media-player")).not.toBeNull();
  });

  // E5 Wave E (D-141): the plain iframe-to-dl. fallback for a snippet-less text file is gone - above the
  // 256KB cap (makeContext's default `bytes` is 2.4MB) with no ingest snippet, the panel offers only the
  // download action; nothing renders for content that does not exist.
  it("renders only the download action for kind text when there is no captured textPreview and the file is above the cap", () => {
    embedContext(makeContext({ kind: "text", mimeType: "text/plain", name: "notes.txt", textPreview: null }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/notes.txt");

    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("mosni-code")).toBeNull();
    const link = container.querySelector(".panel a.btn") as HTMLAnchorElement;
    expect(link.textContent).toBe("Download to view in full");
    expect(link.getAttribute("href")).toBe("https://dl.mosni.dev/photo.png");
  });

  // session 013 debt: PreviewCard's CodeBlock (mosni-code wrapper) had no coverage at any tier.
  it("renders <mosni-code> instead of an iframe for kind text when a textPreview was captured at ingest", () => {
    embedContext(
      makeContext({ kind: "text", mimeType: "text/plain", name: "notes.txt", textPreview: "Hello from the file." }),
    );
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/notes.txt");

    expect(container.querySelector("iframe")).toBeNull();
    const code = container.querySelector("mosni-code");
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
      const code = container.querySelector("mosni-code");
      expect(code?.textContent).toBe("the full file body");
    });

    it("keeps showing the ingest snippet while the full-text fetch is in flight - never an empty block", () => {
      embedContext(
        makeContext({ kind: "text", mimeType: "text/plain", name: "notes.txt", bytes: 1000, textPreview: "short snippet" }),
      );
      // A fetch that never resolves within this test - simulates "still in flight".
      vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

      renderAt("/f/notes.txt");

      const code = container.querySelector("mosni-code");
      expect(code?.textContent).toBe("short snippet");
    });

    it("falls back to the ingest snippet when the full-text fetch fails", async () => {
      embedContext(
        makeContext({ kind: "text", mimeType: "text/plain", name: "notes.txt", bytes: 1000, textPreview: "short snippet" }),
      );
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

      renderAt("/f/notes.txt");
      await flush();

      const code = container.querySelector("mosni-code");
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
      expect(container.querySelector("mosni-code")?.textContent).toBe("short snippet");
      expect(container.querySelector(".panel a.btn")?.textContent).toBe("Download to view in full");
    });

    it("passes a language derived from the filename's inner extension to mosni-code", async () => {
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

      const code = container.querySelector("mosni-code");
      expect(code?.getAttribute("language")).toBe("python");
    });

    it("passes no language attribute for a plain .txt file - Prism degrades to unhighlighted", () => {
      embedContext(
        makeContext({ kind: "text", mimeType: "text/plain", name: "notes.txt", bytes: 500_000, textPreview: "plain text" }),
      );
      vi.stubGlobal("fetch", vi.fn());

      renderAt("/f/notes.txt");

      expect(container.querySelector("mosni-code")?.hasAttribute("language")).toBe(false);
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
  describe("breadcrumbs (G1)", () => {
    it("renders Home, each ancestor collection name, and the file's own name as the current location", () => {
      embedContext(
        makeContext({
          name: "img.png",
          path: "Photos/Vacation/img.png",
          previewUrl: "https://files.mosni.dev/f/Photos/Vacation/img.png",
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
    });

    // D-100 (non-negotiable, §0.2): a secret file's display path is redacted to its bare name server-side
    // (displayPathFor) - the breadcrumb must not reintroduce a collection name that was deliberately hidden.
    it("shows only Home and the file's own name for a redacted path - never a collection name (D-100)", () => {
      embedContext(
        makeContext({ name: "hidden.txt", path: "hidden.txt", previewUrl: "https://files.mosni.dev/t/Ab3xY" }),
        "/t/Ab3xY",
      );
      vi.stubGlobal("fetch", vi.fn());

      renderAt("/t/Ab3xY");

      const nav = container.querySelector('nav[aria-label="Breadcrumb"]');
      expect(nav!.textContent).toContain("Home");
      expect(nav!.textContent).toContain("hidden.txt");
      // No stray collection name could appear anyway - the path IS just the bare file name here - but
      // assert there is exactly one non-Home crumb, proving no ancestor segment was invented.
      expect(nav!.querySelectorAll("a")).toHaveLength(2); // Home + the file's own current-location crumb
    });

    // D-100 also binds on the WAY the trail is built: PreviewContext carries no per-ancestor collection id
    // or URL (unlike FileBrowser's own breadcrumb, fed by /api/browse), so an intermediate collection crumb
    // would have to be a URL ASSEMBLED from its bare name - exactly what D-100 forbids ("the client
    // constructs no URLs"). Ancestor names are shown as plain orientation text; only Home and the file's
    // own current-location crumb (both real, server-provided URLs) are anchors.
    it("does not turn an ancestor collection name into a link - only Home and the file itself are anchors", () => {
      embedContext(
        makeContext({
          name: "img.png",
          path: "Photos/Vacation/img.png",
          previewUrl: "https://files.mosni.dev/f/Photos/Vacation/img.png",
        }),
        "/f/Photos/Vacation/img.png",
      );
      vi.stubGlobal("fetch", vi.fn());

      renderAt("/f/Photos/Vacation/img.png");

      const nav = container.querySelector('nav[aria-label="Breadcrumb"]')!;
      const links = Array.from(nav.querySelectorAll("a")).map((a) => a.textContent);
      expect(links).toEqual(["Home", "img.png"]);
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
