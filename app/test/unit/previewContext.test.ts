import { describe, expect, it } from "vitest";
import {
  buildPreviewContext,
  describeFile,
  humanSize,
  previewKindFor,
  type PreviewContext,
} from "../../src/lib/previewContext.ts";
import type { FileRecord } from "../../src/storage/files.ts";

function makeRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    path: "dir/photo.png",
    name: "photo.png",
    bytes: 2_400_000,
    protection: "public",
    linkToken: "abcde",
    ownerSub: "user-1",
    uploaderSub: "user-1",
    createdAt: "2026-07-21T12:00:00.000Z",
    width: 800,
    height: 600,
    durationSeconds: null,
    textPreview: null,
    ...overrides,
  };
}

const urls = { previewUrl: "https://files.mosni.dev/f/dir/photo.png", directUrl: "https://dl.mosni.dev/dir/photo.png" };

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
  it("maps a FileRecord + urls into a PreviewContext with isOwner always false", () => {
    const record = makeRecord();
    const ctx = buildPreviewContext(record, urls);
    expect(ctx).toEqual<PreviewContext>({
      name: "photo.png",
      path: "dir/photo.png",
      bytes: 2_400_000,
      sizeLabel: "2.3 MB",
      protection: "public",
      createdAt: "2026-07-21T12:00:00.000Z",
      previewUrl: urls.previewUrl,
      directUrl: urls.directUrl,
      kind: "image",
      mimeType: "image/png",
      inline: true,
      width: 800,
      height: 600,
      durationSeconds: null,
      textPreview: null,
      isOwner: false,
    });
  });

  it("isOwner is false even when the record has an ownerSub", () => {
    const ctx = buildPreviewContext(makeRecord({ ownerSub: "someone" }), urls);
    expect(ctx.isOwner).toBe(false);
  });

  it("carries a non-allowlisted extension through as kind other, inline false", () => {
    const ctx = buildPreviewContext(
      makeRecord({ name: "archive.zip", path: "dir/archive.zip", width: null, height: null }),
      urls,
    );
    expect(ctx.kind).toBe("other");
    expect(ctx.inline).toBe(false);
    expect(ctx.mimeType).toBe("application/octet-stream");
  });
});

describe("describeFile()", () => {
  it("describes a non-text file as '<Kind label> · <sizeLabel> · uploaded <D Mon YYYY>'", () => {
    const ctx = buildPreviewContext(makeRecord(), urls);
    expect(describeFile(ctx)).toBe("PNG image · 2.3 MB · uploaded 21 Jul 2026");
  });

  it("describes a video similarly", () => {
    const ctx = buildPreviewContext(
      makeRecord({ name: "clip.mp4", path: "dir/clip.mp4", bytes: 1024, width: 1920, height: 1080 }),
      urls,
    );
    expect(describeFile(ctx)).toBe("MP4 video · 1.0 KB · uploaded 21 Jul 2026");
  });

  it("uses the textPreview snippet instead of size/date for a .txt file that has one", () => {
    const ctx = buildPreviewContext(
      makeRecord({
        name: "notes.txt",
        path: "dir/notes.txt",
        width: null,
        height: null,
        textPreview: "Hello from the notes file.",
      }),
      urls,
    );
    expect(describeFile(ctx)).toBe("Hello from the notes file.");
  });

  it("truncates a long textPreview to 200 chars with an ellipsis", () => {
    const longText = "x".repeat(400);
    const ctx = buildPreviewContext(
      makeRecord({ name: "notes.txt", path: "dir/notes.txt", width: null, height: null, textPreview: longText }),
      urls,
    );
    const description = describeFile(ctx);
    expect(description.length).toBe(201); // 200 chars + ellipsis
    expect(description.startsWith("x".repeat(200))).toBe(true);
    expect(description.endsWith("…")).toBe(true);
  });

  it("falls back to the size/date description for a .txt with no textPreview", () => {
    const ctx = buildPreviewContext(
      makeRecord({ name: "notes.txt", path: "dir/notes.txt", width: null, height: null, textPreview: null }),
      urls,
    );
    expect(describeFile(ctx)).toBe("Text file · 2.3 MB · uploaded 21 Jul 2026");
  });

  it("falls back to a generic label for an unrecognised type", () => {
    const ctx = buildPreviewContext(
      makeRecord({ name: "archive.zip", path: "dir/archive.zip", width: null, height: null }),
      urls,
    );
    expect(describeFile(ctx)).toBe("File · 2.3 MB · uploaded 21 Jul 2026");
  });
});
