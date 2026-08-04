(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// D2 (E5.1 Wave D): the readiness gate (deadline timer, progress-resets-deadline, post-ready height check)
// is VideoPreview's OWN logic, wired to Vidstack's onCanPlay/onLoadedData/onLoadStart/onProgress/onError
// React props. VideoPreview.test.tsx (the sibling file) proves the wiring exists and the DOM shape is
// correct against the REAL @vidstack/react library - but maverick.js/react routes those events through an
// internal event bus that only real HTMLMediaElement readyState/buffered behaviour drives (confirmed
// empirically for `onError` in that file, and re-confirmed here for onCanPlay/onLoadedData: dispatching a
// real 'canplay'/'loadeddata' DOM event on the found <video> element does not reach these props in jsdom -
// there is no real media pipeline to classify it). So THIS file mocks @vidstack/react's MediaPlayer to
// capture the props VideoPreview actually passes it, and invokes them directly as plain function calls -
// the only way to drive VideoPreview's own state machine deterministically. It never touches the real
// Vidstack rendering, which is exactly why it lives in a separate file from VideoPreview.test.tsx rather
// than sharing a module-mock scope with it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";

type CapturedProps = {
  src?: string;
  type?: string;
  onCanPlay?: () => void;
  onLoadedData?: () => void;
  onLoadStart?: () => void;
  onProgress?: () => void;
  onError?: () => void;
};

let captured: CapturedProps = {};

vi.mock("@vidstack/react", () => ({
  MediaPlayer: (props: CapturedProps & { children?: React.ReactNode }) => {
    captured = props;
    return <div data-testid="media-player-stub">{props.children}</div>;
  },
  MediaOutlet: () => <div data-testid="media-outlet-stub" />,
  MediaCommunitySkin: () => <div data-testid="media-skin-stub" />,
}));

// Controllable stand-in for the browser's ResizeObserver, which jsdom does not provide at all (verified -
// see technical-baseline.md). Captures the callback so a test can report an arbitrary height on demand;
// `observe`/`disconnect` are recorded so a test can assert the observer is torn down after its one
// reading, matching VideoPreview's own "only ever needs one reading" contract.
let lastResizeCallback: ResizeObserverCallback | undefined;
let observeCalls = 0;
let disconnectCalls = 0;

class FakeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    lastResizeCallback = callback;
  }
  observe() {
    observeCalls++;
  }
  disconnect() {
    disconnectCalls++;
  }
  unobserve() {}
}

function reportHeight(height: number) {
  lastResizeCallback?.(
    [{ contentRect: { height } } as ResizeObserverEntry],
    undefined as unknown as ResizeObserver,
  );
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

describe("VideoPreview readiness gate (D2, E5.1 Wave D)", () => {
  beforeEach(async () => {
    captured = {};
    lastResizeCallback = undefined;
    observeCalls = 0;
    disconnectCalls = 0;
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mount(ctx: PreviewContext = makeContext()) {
    const { VideoPreview } = await import("../../src/components/VideoPreview.tsx");
    act(() => {
      root.render(<VideoPreview ctx={ctx} />);
    });
  }

  it("stays mounted once ready and rendering at a sane height", async () => {
    await mount();
    expect(container.querySelector('[data-testid="media-player-stub"]')).not.toBeNull();

    act(() => {
      captured.onCanPlay?.();
    });
    act(() => {
      reportHeight(350);
    });

    expect(container.querySelector('[data-testid="media-player-stub"]')).not.toBeNull();
    expect(container.textContent).not.toContain("This video can't play in this browser.");
  });

  // AC-D3: this is what covers Hannah's case - a player collapsed to ~2px is indistinguishable, to the
  // user, from no player at all, and nothing detected that before D2.
  it("shows the download card when the player reports ready but renders below the minimum height (AC-D3)", async () => {
    await mount();

    act(() => {
      captured.onCanPlay?.();
    });
    act(() => {
      reportHeight(2);
    });

    expect(container.querySelector('[data-testid="media-player-stub"]')).toBeNull();
    expect(container.textContent).toContain("This video can't play in this browser.");
  });

  it("the height observer disconnects itself after its one reading", async () => {
    await mount();
    act(() => {
      captured.onCanPlay?.();
    });
    expect(observeCalls).toBe(1);
    act(() => {
      reportHeight(350);
    });
    expect(disconnectCalls).toBe(1);
  });

  // AC-D4/regression: onError still shows the download card, unchanged by D2.
  it("shows the download card when the player errors (AC-D4, no regression)", async () => {
    await mount();
    act(() => {
      captured.onError?.();
    });
    expect(container.querySelector('[data-testid="media-player-stub"]')).toBeNull();
    expect(container.textContent).toContain("This video can't play in this browser.");
  });

  it("a slow-but-progressing source is not dumped to the card while the deadline keeps getting reset (AC-D5)", async () => {
    vi.useFakeTimers();
    try {
      await mount();

      // Real load activity every 5s, under the 8s deadline - each call resets it, so 20s of elapsed
      // wall-clock time with steady progress must never trip the fallback.
      for (let i = 0; i < 4; i++) {
        act(() => {
          vi.advanceTimersByTime(5000);
        });
        act(() => {
          captured.onProgress?.();
        });
      }

      expect(container.querySelector('[data-testid="media-player-stub"]')).not.toBeNull();
      expect(container.textContent).not.toContain("This video can't play in this browser.");
    } finally {
      vi.useRealTimers();
    }
  });

  // D-167 (E5.1 live-testing round 2): a `private` file's owner gets an EXTENSIONLESS signed URL
  // (`dl.mosni.dev/s/<id>?exp=...&sig=...`, controllers/preview.ts's withSignedDirectUrl) - Vidstack's own
  // VideoProviderLoader.canPlay() decides whether to attach a <video> at all by testing the URL STRING
  // against a fixed extension regex (`/\.(mp4|og[gv]|webm|mov|m4v)($|\?)/i`) OR the declared `type` against
  // its own allowlist - with neither an extension NOR a type, it picks no provider, no <video> ever
  // attaches, and D2's readiness gate times out to the download card every time. Confirmed empirically
  // against `node_modules/vidstack`. Vidstack's allowlist includes "video/mp4"/"video/webm" but EXCLUDES
  // "video/quicktime"/"video/x-m4v"/"video/x-matroska" outright (D1's original finding) - so the type hint
  // must be passed for the two SAFE types (fixing the extensionless-URL gap) and stay omitted for the three
  // exotic ones (preserving D1's fix).
  it("passes a type hint for mp4/webm (D-167) but omits it for mov/m4v/mkv (D1, unchanged)", async () => {
    await mount(makeContext({ directUrl: "https://dl.mosni.dev/s/file0000000000id?exp=1&sig=abc", mimeType: "video/mp4" }));
    expect(captured.type).toBe("video/mp4");

    await mount(makeContext({ mimeType: "video/webm" }));
    expect(captured.type).toBe("video/webm");

    await mount(makeContext({ mimeType: "video/quicktime" }));
    expect(captured.type).toBeUndefined();

    await mount(makeContext({ mimeType: "video/x-m4v" }));
    expect(captured.type).toBeUndefined();

    await mount(makeContext({ mimeType: "video/x-matroska" }));
    expect(captured.type).toBeUndefined();
  });

  it("stops resetting the deadline once ready - a later onProgress after onCanPlay does not reopen the window", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      act(() => {
        captured.onCanPlay?.();
      });
      act(() => {
        reportHeight(350);
      });
      expect(container.querySelector('[data-testid="media-player-stub"]')).not.toBeNull();

      // Confirmed and visible - the deadline no longer governs anything, and the player stays regardless
      // of time passing.
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(container.querySelector('[data-testid="media-player-stub"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
