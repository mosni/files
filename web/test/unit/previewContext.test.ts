import { afterEach, describe, expect, it } from "vitest";
import { readEmbeddedTarget } from "../../src/lib/previewContext.ts";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";

// D-160/Wave B: the server stamps the path its embedded #preview-context script was rendered for
// (`embeddedFor`), so the client can compare against the path it actually arrived at rather than trusting
// whatever pathname it happened to mount with (finding 3). readEmbeddedTarget() is the one place that
// unwraps the embedded JSON, so this is the only place that needs to know the wrapper shape.

function makeCtx(overrides: Partial<PreviewContext> = {}): PreviewContext {
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

function embed(json: unknown) {
  const script = document.createElement("script");
  script.type = "application/json";
  script.id = "preview-context";
  script.textContent = JSON.stringify(json);
  document.head.appendChild(script);
}

describe("readEmbeddedTarget()", () => {
  afterEach(() => {
    document.getElementById("preview-context")?.remove();
  });

  it("returns null when no embedded script exists", () => {
    expect(readEmbeddedTarget()).toBeNull();
  });

  it("surfaces embeddedFor for a file target, alongside the context", () => {
    embed({ ...makeCtx(), embeddedFor: "/f/photo.png" });
    const target = readEmbeddedTarget();
    expect(target).not.toBeNull();
    expect(target!.kind).toBe("file");
    expect(target!.embeddedFor).toBe("/f/photo.png");
  });

  it("surfaces embeddedFor for a collection target", () => {
    embed({ kind: "collection", collectionId: "coll-abc", embeddedFor: "/f/Photos" });
    const target = readEmbeddedTarget();
    expect(target).not.toBeNull();
    expect(target!.kind).toBe("collection");
    if (target!.kind === "collection") expect(target!.collectionId).toBe("coll-abc");
    expect(target!.embeddedFor).toBe("/f/Photos");
  });

  it("strips embeddedFor out of the returned file context - it is a property of the embedding, not the file", () => {
    embed({ ...makeCtx(), embeddedFor: "/f/photo.png" });
    const target = readEmbeddedTarget();
    expect(target!.kind).toBe("file");
    if (target!.kind === "file") {
      expect(target!.context).not.toHaveProperty("embeddedFor");
      expect(target!.context.name).toBe("photo.png");
    }
  });
});
