import { describe, expect, it } from "vitest";
import {
  buildPreviewContext,
  describeFile,
  humanSize,
  previewKindFor,
  type PreviewContext,
} from "../../src/lib/previewContext.ts";
import type { ResolvedFile } from "../../src/storage/files.ts";

// A ResolvedFile, not a bare FileRecord: buildPreviewContext reports the EFFECTIVE level (D-96), so the
// type system refuses a caller that has not resolved the ancestor chain first. `effectiveProtection`
// defaults to the same value as `protection` here, which is the ordinary case (nothing above the file is
// stricter); the tests below that care about the landmine set them apart deliberately.
function makeRecord(overrides: Partial<ResolvedFile> = {}): ResolvedFile {
  const protection = overrides.protection ?? "public";
  return {
    id: "file0000000000id",
    collectionId: "coll000000000000",
    name: "photo.png",
    diskDir: "2026/07",
    diskName: "file0000000000id-photo.png",
    bytes: 2_400_000,
    protection,
    effectiveProtection: protection,
    linkToken: "abcde",
    ownerSub: "user-1",
    uploaderSub: "user-1",
    createdAt: "2026-07-21T12:00:00.000Z",
    width: 800,
    height: 600,
    durationSeconds: null,
    textPreview: null,
    uploaderName: null,
    thumbName: null,
    uploaderIsOwner: false,
    ...overrides,
  };
}

const displayPath = "dir/photo.png";
const urls = {
  previewUrl: "https://files.mosni.dev/f/dir/photo.png",
  directUrl: "https://dl.mosni.dev/dir/photo.png",
  thumbUrl: null as string | null,
  uploaderAvatarUrl: "https://files.mosni.dev/api/avatar/file0000000000id",
};

describe("humanSize() - binary units, 1 decimal place", () => {
  it("renders plain bytes below 1 KiB with no decimal", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(999)).toBe("999 B");
    expect(humanSize(1023)).toBe("1023 B");
  });

  it("crosses into KB at 1024", () => {
    expect(humanSize(1024)).toBe("1.0 KB");
    expect(humanSize(1536)).toBe("1.5 KB");
  });

  it("crosses into MB at 1024*1024", () => {
    expect(humanSize(1024 * 1024)).toBe("1.0 MB");
    expect(humanSize(2_400_000)).toBe("2.3 MB");
  });

  it("crosses into GB at 1024^3", () => {
    expect(humanSize(1024 * 1024 * 1024)).toBe("1.0 GB");
  });
});

describe("previewKindFor()", () => {
  it.each([
    ["photo.png", "image"],
    ["photo.PNG", "image"],
    ["clip.mp4", "video"],
    ["clip.webm", "video"],
    ["doc.pdf", "pdf"],
    ["notes.txt", "text"],
    ["archive.zip", "other"],
    ["README", "other"],
  ] as const)("classifies %s as %s", (filename, kind) => {
    expect(previewKindFor(filename)).toBe(kind);
  });
});

describe("buildPreviewContext()", () => {
  it("maps a FileRecord + display path + urls into a PreviewContext with isOwner always false", () => {
    // uploaderSub is set (the default), so per C1/C4 the avatar shows even with no captured name -
    // uploaderName stays null (not the owner, so no sub fallback either).
    const record = makeRecord();
    const ctx = buildPreviewContext(record, displayPath, urls);
    expect(ctx).toEqual<PreviewContext>({
      id: "file0000000000id",
      collectionId: "coll000000000000",
      name: "photo.png",
      path: "dir/photo.png",
      bytes: 2_400_000,
      sizeLabel: "2.3 MB",
      protection: "public",
      createdAt: "2026-07-21T12:00:00.000Z",
      previewUrl: urls.previewUrl,
      directUrl: urls.directUrl,
      thumbUrl: null,
      kind: "image",
      mimeType: "image/png",
      inline: true,
      width: 800,
      height: 600,
      durationSeconds: null,
      textPreview: null,
      uploaderName: null,
      uploaderAvatarUrl: urls.uploaderAvatarUrl,
      isOwner: false,
    });
  });

  // D-96, the landmine (technical-baseline.md §3): a row stored looser than an ancestor collection is
  // legitimate - D-97 deliberately rewrites nothing when a collection is raised - so the context this
  // builder produces must report the EFFECTIVE level. Reporting the stored column instead tells the
  // owner's own preview page ("You own this file (public)." - PreviewCard.tsx) and the anonymous
  // /api/preview/t/<token> body that a collection-gated file is public, which is false.
  it("reports the EFFECTIVE protection, never the stored column (D-96)", () => {
    const ctx = buildPreviewContext(
      makeRecord({ protection: "public", effectiveProtection: "private" }),
      displayPath,
      urls,
    );
    expect(ctx.protection).toBe("private");
  });

  it("isOwner is false even when the record has an ownerSub", () => {
    const ctx = buildPreviewContext(makeRecord({ ownerSub: "someone" }), displayPath, urls);
    expect(ctx.isOwner).toBe(false);
  });

  it("maps thumbUrl straight through from urls (D-137)", () => {
    const withThumb = { ...urls, thumbUrl: "https://dl.mosni.dev/thumb/dir/photo.png" };
    const ctx = buildPreviewContext(makeRecord(), displayPath, withThumb);
    expect(ctx.thumbUrl).toBe("https://dl.mosni.dev/thumb/dir/photo.png");
  });

  it("maps uploaderName straight through, and uploaderAvatarUrl alongside it (D-136)", () => {
    const ctx = buildPreviewContext(makeRecord({ uploaderName: "Hannah" }), displayPath, urls);
    expect(ctx.uploaderName).toBe("Hannah");
    expect(ctx.uploaderAvatarUrl).toBe(urls.uploaderAvatarUrl);
  });

  // C1/D-154 (E5.1 Wave C): the avatar is gated on uploaderSub, NOT on uploaderName - a file with a
  // captured sub but no name still shows an avatar (with no name line, per PreviewCard.tsx).
  it("uploaderAvatarUrl is present even when uploaderName is null, as long as uploaderSub is set (C1)", () => {
    const ctx = buildPreviewContext(makeRecord({ uploaderName: null, uploaderSub: "user-1" }), displayPath, urls);
    expect(ctx.uploaderName).toBeNull();
    expect(ctx.uploaderAvatarUrl).toBe(urls.uploaderAvatarUrl);
  });

  it("uploaderAvatarUrl is null when there is no uploaderSub at all - nothing to proxy (C1)", () => {
    const ctx = buildPreviewContext(makeRecord({ uploaderName: null, uploaderSub: null }), displayPath, urls);
    expect(ctx.uploaderAvatarUrl).toBeNull();
  });

  // C4 (D-154/D-155): the structural fallback table. A non-owner account's sub must NEVER appear as the
  // name (D-92) - only the owner's, gated on the claim captured at upload, never on "the name is missing".
  describe("uploaderName fallback (C4)", () => {
    it("shows the captured name when present, regardless of the owner flag", () => {
      const ctx = buildPreviewContext(
        makeRecord({ uploaderName: "Hannah", uploaderIsOwner: false }),
        displayPath,
        urls,
      );
      expect(ctx.uploaderName).toBe("Hannah");
    });

    it("shows the sub as the name for the OWNER when no name was captured", () => {
      const ctx = buildPreviewContext(
        makeRecord({ uploaderName: null, uploaderSub: "hannah", uploaderIsOwner: true }),
        displayPath,
        urls,
      );
      expect(ctx.uploaderName).toBe("hannah");
    });

    it("shows NO name (avatar only) for a non-owner with no captured name - never the sub", () => {
      const ctx = buildPreviewContext(
        makeRecord({ uploaderName: null, uploaderSub: "google:12345", uploaderIsOwner: false }),
        displayPath,
        urls,
      );
      expect(ctx.uploaderName).toBeNull();
      // The sub never appears anywhere in the produced context, serialized or not.
      expect(JSON.stringify(ctx)).not.toContain("google:12345");
    });
  });

  it("carries a non-allowlisted extension through as kind other, inline false", () => {
    const ctx = buildPreviewContext(
      makeRecord({ name: "archive.zip", width: null, height: null }),
      "dir/archive.zip",
      urls,
    );
    expect(ctx.kind).toBe("other");
    expect(ctx.inline).toBe(false);
    expect(ctx.mimeType).toBe("application/octet-stream");
  });
});

describe("describeFile()", () => {
  it("describes a non-text file as '<Kind label> · <sizeLabel> · uploaded <D Mon YYYY>'", () => {
    const ctx = buildPreviewContext(makeRecord(), displayPath, urls);
    expect(describeFile(ctx)).toBe("PNG image · 2.3 MB · uploaded 21 Jul 2026");
  });

  it("describes a video similarly", () => {
    const ctx = buildPreviewContext(
      makeRecord({ name: "clip.mp4", bytes: 1024, width: 1920, height: 1080 }),
      "dir/clip.mp4",
      urls,
    );
    expect(describeFile(ctx)).toBe("MP4 video · 1.0 KB · uploaded 21 Jul 2026");
  });

  it("uses the textPreview snippet instead of size/date for a .txt file that has one", () => {
    const ctx = buildPreviewContext(
      makeRecord({
        name: "notes.txt",
        width: null,
        height: null,
        textPreview: "Hello from the notes file.",
      }),
      "dir/notes.txt",
      urls,
    );
    expect(describeFile(ctx)).toBe("Hello from the notes file.");
  });

  it("truncates a long textPreview to 200 chars with an ellipsis", () => {
    const longText = "x".repeat(400);
    const ctx = buildPreviewContext(
      makeRecord({ name: "notes.txt", width: null, height: null, textPreview: longText }),
      "dir/notes.txt",
      urls,
    );
    const description = describeFile(ctx);
    expect(description.length).toBe(201); // 200 chars + ellipsis
    expect(description.startsWith("x".repeat(200))).toBe(true);
    expect(description.endsWith("…")).toBe(true);
  });

  it("falls back to the size/date description for a .txt with no textPreview", () => {
    const ctx = buildPreviewContext(
      makeRecord({ name: "notes.txt", width: null, height: null, textPreview: null }),
      "dir/notes.txt",
      urls,
    );
    expect(describeFile(ctx)).toBe("Text file · 2.3 MB · uploaded 21 Jul 2026");
  });

  it("falls back to a generic label for an unrecognised type", () => {
    const ctx = buildPreviewContext(
      makeRecord({ name: "archive.zip", width: null, height: null }),
      "dir/archive.zip",
      urls,
    );
    expect(describeFile(ctx)).toBe("File · 2.3 MB · uploaded 21 Jul 2026");
  });
});
