(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VideoPreview } from "../../src/components/VideoPreview.tsx";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";

// Vidstack's real <video> lives inside <media-outlet>'s shadow root - plain querySelector never pierces a
// shadow boundary, so the player's own `error` event (which maverick's Player listens for on the actual
// provider element and re-dispatches at the player level) has to be triggered from there, not by faking an
// event directly on the outer custom element.
function findVideoElement(root: Element | ShadowRoot): HTMLVideoElement | null {
  const direct = root.querySelector("video");
  if (direct) return direct as HTMLVideoElement;
  for (const el of root.querySelectorAll("*")) {
    if (el.shadowRoot) {
      const found = findVideoElement(el.shadowRoot);
      if (found) return found;
    }
  }
  return null;
}

function makeContext(overrides: Partial<PreviewContext> = {}): PreviewContext {
  return {
    id: "file0000000000id",
    collectionId: "coll000000000000",
    name: "clip.mp4",
    path: "clip.mp4",
    bytes: 5_000_000,
    sizeLabel: "5.0 MB",
    protection: "public",
    createdAt: "2026-07-21T00:00:00.000Z",
    previewUrl: "https://files.mosni.dev/f/clip.mp4",
    directUrl: "https://dl.mosni.dev/clip.mp4",
    thumbUrl: null,
    kind: "video",
    mimeType: "video/mp4",
    inline: true,
    width: 1920,
    height: 1080,
    durationSeconds: 12,
    textPreview: null,
    uploaderName: null,
    uploaderAvatarUrl: null,
    isOwner: false,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

describe("VideoPreview (E5 Wave F, D-144 'plays where it plays')", () => {
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
    vi.restoreAllMocks();
  });

  it("mounts the Vidstack player when the browser reports it can play the container", () => {
    vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");

    act(() => {
      root.render(<VideoPreview ctx={makeContext()} />);
    });

    const player = container.querySelector("media-player");
    expect(player).not.toBeNull();
    const video = findVideoElement(player!);
    expect(video?.getAttribute("src")).toBe("https://dl.mosni.dev/clip.mp4");
    expect(container.querySelector(".panel")).toBeNull();
  });

  it("skips mounting the player and shows the download card when canPlayType reports '' (authoritative no)", () => {
    vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");

    act(() => {
      root.render(
        <VideoPreview
          ctx={makeContext({
            kind: "video",
            mimeType: "video/x-matroska",
            name: "clip.mkv",
            directUrl: "https://dl.mosni.dev/clip.mkv",
          })}
        />,
      );
    });

    expect(container.querySelector("media-player")).toBeNull();
    // Inline-styled, not `.panel`/`.btn` (D-79 finding: the embeddable route never loads mosni-chrome's
    // stylesheet, so a class-based fallback rendered invisibly there) - just a real, findable link.
    const link = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === "Download");
    expect(link?.getAttribute("href")).toBe("https://dl.mosni.dev/clip.mkv");
    expect(container.textContent).toContain("This video can't play in this browser.");
  });

  // NOT automated, and deliberately not chased further: maverick.js/react wires `onError` through its OWN
  // internal event bus (`this.g.addEventListener` in maverick.js's react runtime - a private instance, not
  // a DOM `addEventListener` call), which only fires once maverick's internal state manager has classified
  // real decode progress off the actual media element. jsdom has no real media pipeline, so that
  // classification never happens (confirmed empirically: a spy on `HTMLElement.prototype.addEventListener`
  // never observes an "error" registration on `<media-player>` at all - it is not a DOM-level listener to
  // begin with), and there is no supported, non-private way to trigger it from outside. This exact
  // transition - a mounted player later reporting a real playback error - is on
  // verification-concept.md's manual-check list ("a genuinely unsupported codec falling back to the
  // download card"), exercised there against a real browser. The canPlayType()==="" fast path above IS
  // automated and reaches the identical fallback UI.

  it("re-derives playability fresh for a new file rather than carrying over a stale fallback", () => {
    const canPlayType = vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType");

    canPlayType.mockReturnValue("");
    act(() => {
      root.render(<VideoPreview ctx={makeContext({ name: "first.mkv", directUrl: "https://dl.mosni.dev/first.mkv" })} />);
    });
    expect(container.querySelector("media-player")).toBeNull();

    canPlayType.mockReturnValue("probably");
    act(() => {
      root.render(<VideoPreview ctx={makeContext({ name: "second.mp4", directUrl: "https://dl.mosni.dev/second.mp4" })} />);
    });
    expect(container.querySelector("media-player")).not.toBeNull();
  });
});
