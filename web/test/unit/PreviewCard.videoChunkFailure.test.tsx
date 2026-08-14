(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// D6 (E5.1 Wave D, D-166): found while investigating finding 5 - aborting the VideoPreview-*.css/js
// request leaves only the site header rendered, because React.lazy()'s rejection has no error boundary,
// so the WHOLE preview unmounts. A transient CDN/network failure on one lazy asset must cost the video,
// not the page.
//
// This mocks VideoPreview itself to THROW synchronously on render, rather than trying to make the dynamic
// import() promise reject - React treats both identically (a lazy chunk's rejection surfaces to the
// nearest error boundary as a thrown value during render, exactly like any other render-time throw), and
// forcing a genuine import() rejection through vi.mock's hoisting fights the module graph rather than
// testing the thing this file actually needs to prove: that an error ANYWHERE in this subtree is caught
// by PreviewCard's own boundary, not that a network fetch specifically failed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PreviewCard } from "../../src/components/PreviewCard.tsx";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";

vi.mock("../../src/components/VideoPreview.tsx", () => ({
  VideoPreview: () => {
    throw new Error("simulated failed lazy chunk");
  },
  DownloadFallback: ({ directUrl }: { directUrl: string }) => (
    <div>
      <p>This video can&apos;t play in this browser.</p>
      <a href={directUrl}>Download</a>
    </div>
  ),
}));

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

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

let container: HTMLDivElement;
let root: Root;

describe("PreviewCard - a failed video lazy chunk (D6, D-166)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("costs the video, not the rest of the preview card, when the lazy chunk fails to load", async () => {
    const ctx = makeContext();

    act(() => {
      root.render(<PreviewCard context={ctx} />);
    });
    await flush();

    // The rest of the card (name, copy link) survives - proof the whole component tree did not unmount.
    expect(container.textContent).toContain("clip.mp4");
    expect(container.querySelector(".copy-field-primary, input")).not.toBeNull();
    // Never a bare crash / blank region.
    expect(container.textContent).not.toBe("");
  });
});
