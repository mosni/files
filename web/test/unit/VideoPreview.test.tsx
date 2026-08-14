(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VideoPreview } from "../../src/components/VideoPreview.tsx";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";

// 1.15.6 (E5.1 live-testing round 4 upgrade) has no shadow DOM at all - the real <video> is a plain light-
// DOM descendant of a `<div data-media-provider>` (no more `<media-player>`/`<media-outlet>` custom
// element tags either - see the `[data-media-player]` selector below) - but this helper still walks any
// shadowRoot it finds, defensively, in case a future Vidstack version reintroduces one.
//
// jsdom has no real media pipeline (confirmed again against 1.15.6, same as 0.6.15): the provider attaches
// a real <video> element, but never populates its `src` attribute or `.src`/`.currentSrc` property at all,
// even after a long async wait - Vidstack's own loading path depends on real HTMLMediaElement network
// behaviour jsdom does not implement. Tests below therefore assert the <video> element EXISTS (proving
// MediaProvider selected and attached a provider for the given source/type), not its exact `src` value -
// that exact propagation is verified against a REAL browser instead, both via the throwaway harness
// documented in VideoPreview.tsx's own header comment and via `e2e/video-playback.spec.ts` (currently
// skipped pending Wave H's TLS fix for the e2e tier, see that file).
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
    canManage: false,
    canDelete: false,
    ancestors: [],
    ...overrides,
  };
}

// 1.15.6's default `load: "visible"` strategy waits for a REAL IntersectionObserver to report the player
// is on-screen before it attaches anything - jsdom provides no such API at all (verified, same class of
// gap as ResizeObserver elsewhere in this file's sibling tests). Reports every observed element as
// immediately, fully intersecting, matching what a real browser reports for an element already in the
// (jsdom-only, effectively infinite) viewport.
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

// 1.15.6's MediaPlayer also observes its own connected size via ResizeObserver internally (separate from
// VideoPreview's OWN D2 readiness check, which uses a real one via `web/test/unit/VideoPreview.readiness.
// test.tsx`'s FakeResizeObserver) - jsdom has none at all. A no-op stub is enough here: this file never
// asserts on layout/sizing, only on DOM shape and the readiness state machine.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let container: HTMLDivElement;
let root: Root;

describe("VideoPreview (E5 Wave F, D-144 'plays where it plays')", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", ImmediatelyIntersectingObserver);
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
    // jsdom provides no window.matchMedia at all (a long-standing, well-known gap) - 1.15.6 queries it for
    // responsive/orientation breakpoints. A minimal stub reporting "no match" is enough; nothing under
    // test here depends on a specific media-query result.
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mounts the Vidstack player when the browser reports it can play the container", () => {
    vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");

    act(() => {
      root.render(<VideoPreview ctx={makeContext()} />);
    });

    const player = container.querySelector("[data-media-player]");
    expect(player).not.toBeNull();
    expect(findVideoElement(player!)).not.toBeNull();
    expect(container.querySelector(".panel")).toBeNull();
  });

  // D1/AC-D1 (E5.1 Wave D): the old canDefinitelyNotPlay() pre-check is GONE. Vidstack refuses a source on
  // its declared MIME type alone (video/quicktime, video/x-m4v and video/x-matroska all rejected outright,
  // measured session 035) - which is exactly what D-144's own MIME widening produced for .mov/.m4v/.mkv,
  // so the pre-check was short-circuiting three of the five allowlisted containers to the download card
  // even when the BROWSER could have played the bytes. The source is now passed with no `type` hint at all
  // (D0/D1, the same edit), so the browser decides purely from the URL/bytes.
  //
  // `.mov` here, not `.mkv`: Vidstack's OWN provider loader also infers a provider from the URL extension
  // when given no explicit type - measured directly, `.mov`/`.m4v` resolve to the HTML5 video provider
  // that way (matching what D1 promises) but `.mkv` does not, on ANY of these three MIME types, because
  // Vidstack's extension table itself has no `.mkv` entry - an unrelated, pre-existing gap in Vidstack, not
  // a regression this change causes. It does not matter for `.mkv` in practice: no mainstream browser
  // decodes Matroska today (D-146), so it was always going to reach the download card either way - D2's
  // deadline (below) still delivers that outcome correctly, just without ever mounting a `<video>` element
  // for it specifically.
  it("reaches the player for an exotic MIME type instead of being short-circuited (D1, AC-D1)", () => {
    vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");

    act(() => {
      root.render(
        <VideoPreview
          ctx={makeContext({
            kind: "video",
            mimeType: "video/quicktime",
            name: "clip.mov",
            directUrl: "https://dl.mosni.dev/clip.mov",
          })}
        />,
      );
    });

    const player = container.querySelector("[data-media-player]");
    expect(player).not.toBeNull();
    // D0/D1: no `type` attribute/hint reaches the player - the browser decides purely from the bytes.
    expect(findVideoElement(player!)).not.toBeNull();
  });

  it(".mkv still degrades to the download card - via D2's deadline, since no browser decodes Matroska (D-146)", () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");

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

      act(() => {
        vi.advanceTimersByTime(8000);
      });

      expect(container.querySelector("[data-media-player]")).toBeNull();
      expect(container.textContent).toContain("This video can't play in this browser.");
    } finally {
      vi.useRealTimers();
    }
  });

  // D2/AC-D2 (E5.1 Wave D): this is the wave's core change, and it closes finding 5 without knowing its
  // cause. The player is optimistic no longer - it is shown only while it is affirmatively proving it
  // works (a can-play/loaded-data signal); nothing raises one in this environment (jsdom has no real media
  // pipeline - the same limitation documented below for `error`), so this exercises the genuine "nothing
  // ever confirms" path the deadline exists for.
  it("shows the download card after the deadline when the player never confirms it can play (AC-D2)", () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");

      act(() => {
        root.render(<VideoPreview ctx={makeContext()} />);
      });
      expect(container.querySelector("[data-media-player]")).not.toBeNull(); // mounted - still checking

      act(() => {
        vi.advanceTimersByTime(8000);
      });

      expect(container.querySelector("[data-media-player]")).toBeNull();
      const link = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === "Download");
      expect(link?.getAttribute("href")).toBe("https://dl.mosni.dev/clip.mp4");
      expect(container.textContent).toContain("This video can't play in this browser.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fall back before the deadline expires", () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");

      act(() => {
        root.render(<VideoPreview ctx={makeContext()} />);
      });

      act(() => {
        vi.advanceTimersByTime(7999);
      });

      expect(container.querySelector("[data-media-player]")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  // D0/AC-D0 (finding 5, D-164): a single re-render after the player mounts used to destroy it, because
  // the source was passed as an inline object literal - a NEW object every render, which Vidstack's React
  // wrapper compares by identity, tearing its provider down and never rebuilding it. The owner ALWAYS hits
  // this (Preview.tsx's Bearer re-fetch guarantees a render); a signed-out visitor never does, which is why
  // 874 tests and every anonymous check passed while this was broken.
  it("survives an unrelated re-render with unchanged props (AC-D0, finding 5, D-164)", () => {
    vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
    const ctx = makeContext();

    act(() => {
      root.render(<VideoPreview ctx={ctx} />);
    });
    const playerBefore = container.querySelector("[data-media-player]");
    expect(playerBefore).not.toBeNull();
    const videoBefore = findVideoElement(playerBefore!);
    expect(videoBefore).not.toBeNull();

    // Force a second render with unchanged props - e.g. the owner's Bearer re-fetch in Preview.tsx, which
    // calls setState with a value that renders identically but is a NEW reference every time.
    act(() => {
      root.render(<VideoPreview ctx={ctx} />);
    });

    const playerAfter = container.querySelector("[data-media-player]");
    expect(playerAfter).not.toBeNull();
    const videoAfter = findVideoElement(playerAfter!);
    expect(videoAfter).not.toBeNull();
    // The actual regression check: the SAME <video> DOM node survives the re-render - D-164's bug tore it
    // down and rebuilt a new one every time, which this identity comparison catches directly (a rebuilt
    // element would be a different object, even with identical resulting markup).
    expect(videoAfter).toBe(videoBefore);
  });

  // D2: readiness is keyed on `ctx.directUrl`, not carried in a bare boolean the way the old
  // canDefinitelyNotPlay()-only design was - a file that timed out must not leave a NEW file stuck showing
  // the download card too.
  it("re-derives readiness fresh for a new file rather than carrying over a stale fallback", () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(window.HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");

      act(() => {
        root.render(<VideoPreview ctx={makeContext({ name: "first.mkv", directUrl: "https://dl.mosni.dev/first.mkv" })} />);
      });
      act(() => {
        vi.advanceTimersByTime(8000);
      });
      expect(container.querySelector("[data-media-player]")).toBeNull(); // first file timed out - never confirmed

      act(() => {
        root.render(<VideoPreview ctx={makeContext({ name: "second.mp4", directUrl: "https://dl.mosni.dev/second.mp4" })} />);
      });
      expect(container.querySelector("[data-media-player]")).not.toBeNull(); // second file gets its OWN fresh check
    } finally {
      vi.useRealTimers();
    }
  });
});
