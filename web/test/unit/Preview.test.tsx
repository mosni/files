// React's act() only suppresses its "not configured for act" console warning when this flag is set.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { PreviewPage } from "../../src/pages/Preview.tsx";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";

function makeContext(overrides: Partial<PreviewContext> = {}): PreviewContext {
  return {
    name: "photo.png",
    path: "photo.png",
    bytes: 2_400_000,
    sizeLabel: "2.4 MB",
    protection: "public",
    createdAt: "2026-07-21T00:00:00.000Z",
    previewUrl: "https://files.mosni.dev/f/photo.png",
    directUrl: "https://dl.mosni.dev/photo.png",
    kind: "image",
    mimeType: "image/png",
    inline: true,
    width: 800,
    height: 600,
    durationSeconds: null,
    textPreview: null,
    isOwner: false,
    ...overrides,
  };
}

function embedContext(ctx: PreviewContext) {
  const script = document.createElement("script");
  script.type = "application/json";
  script.id = "preview-context";
  script.textContent = JSON.stringify(ctx);
  document.head.appendChild(script);
}

// Flushes every pending microtask (fetch → res.json() → setState is two awaits deep) by yielding to a
// real macrotask - more robust than a fixed number of `await Promise.resolve()` hops.
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderAt(path: string) {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/f/*" element={<PreviewPage />} />
          <Route path="/t/:token" element={<PreviewPage />} />
        </Routes>
      </MemoryRouter>,
    );
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
    (window as unknown as { mosni: unknown }).mosni = { token: () => "test-token" };
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
    (window as unknown as { mosni: unknown }).mosni = { token: () => "test-token" };
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
    (window as unknown as { mosni: unknown }).mosni = { token: () => "test-token" };
    embedContext(makeContext({ isOwner: false }));
    const refreshed = makeContext({ isOwner: true });
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(refreshed) });
    vi.stubGlobal("fetch", fetchSpy);

    renderAt("/f/photo.png");
    expect(container.textContent).not.toContain("You own this file");

    await flush();

    expect(container.textContent).toContain("You own this file");
  });

  it("renders a plain <video controls> for kind video (not Vidstack)", () => {
    embedContext(makeContext({ kind: "video", mimeType: "video/mp4", name: "clip.mp4", width: 1920, height: 1080 }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/clip.mp4");

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.hasAttribute("controls")).toBe(true);
  });

  it("renders an iframe for kind text", () => {
    embedContext(makeContext({ kind: "text", mimeType: "text/plain", name: "notes.txt" }));
    vi.stubGlobal("fetch", vi.fn());

    renderAt("/f/notes.txt");

    expect(container.querySelector("iframe")).not.toBeNull();
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
});
