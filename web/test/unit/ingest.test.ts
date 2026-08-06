// E6 Wave D (D-177): pure clipboard-ingest helpers - every branch (file wins over image, image wins over
// text, text only when the clipboard carries neither, whitespace-only text yields nothing).

import { describe, expect, it } from "vitest";
import { filesFromClipboard, nameForPastedBlob } from "../../src/lib/ingest.ts";

const FIXED_NOW = new Date(2026, 7, 5, 14, 30, 52); // 2026-08-05 14:30:52 local

function dataTransfer(overrides: Partial<DataTransfer>): DataTransfer {
  return {
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    getData: () => "",
    ...overrides,
  } as DataTransfer;
}

describe("nameForPastedBlob (D-177)", () => {
  it("formats pasted-YYYY-MM-DD-HHmmss.<ext> from a fixed clock", () => {
    const blob = new Blob(["x"], { type: "image/png" });
    expect(nameForPastedBlob(blob, FIXED_NOW)).toBe("pasted-2026-08-05-143052.png");
  });

  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"],
    ["image/gif", "gif"],
  ])("maps %s to .%s", (type, ext) => {
    const blob = new Blob(["x"], { type });
    expect(nameForPastedBlob(blob, FIXED_NOW)).toBe(`pasted-2026-08-05-143052.${ext}`);
  });

  it("falls back to .bin for an unrecognised image type, rather than guessing", () => {
    const blob = new Blob(["x"], { type: "image/heic" });
    expect(nameForPastedBlob(blob, FIXED_NOW)).toBe("pasted-2026-08-05-143052.bin");
  });
});

describe("filesFromClipboard", () => {
  it("a real file copied from the filesystem wins and keeps its own name", () => {
    const file = new File(["hello"], "report.pdf", { type: "application/pdf" });
    const item = { kind: "file", type: "image/png", getAsFile: () => new File(["x"], "img.png") } as unknown as DataTransferItem;
    const data = dataTransfer({ files: [file] as unknown as FileList, items: [item] as unknown as DataTransferItemList });

    const result = filesFromClipboard(data, FIXED_NOW);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("report.pdf");
  });

  // ⚠ The fixture that matters, added by the E6 review session (042) after measuring a real Chromium
  // paste: a pasted SCREENSHOT arrives in `clipboardData.files` too, as a File the browser names
  // `image.png`. Every case above leaves `files` empty, which is not what a browser produces - so the
  // suite was green while every pasted image uploaded as `image.png` instead of D-177's timestamped name,
  // and a second paste collided into `image(2).png`. See ingest.ts's own note.
  it("a pasted screenshot arriving in .files (the real Chromium shape) still gets the D-177 name", () => {
    const pasted = new File(["png bytes"], "image.png", { type: "image/png" });
    const data = dataTransfer({ files: [pasted] as unknown as FileList });

    const result = filesFromClipboard(data, FIXED_NOW);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("pasted-2026-08-05-143052.png");
    expect(result[0].type).toBe("image/png");
  });

  it("a real image file copied from the filesystem keeps its own name, screenshot rule notwithstanding", () => {
    const photo = new File(["jpg bytes"], "holiday.jpg", { type: "image/jpeg" });
    const data = dataTransfer({ files: [photo] as unknown as FileList });

    const result = filesFromClipboard(data, FIXED_NOW);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("holiday.jpg");
  });

  it("an image blob wins over plain text when there is no real file", () => {
    const blob = new File(["img"], "whatever.png", { type: "image/png" });
    const item = { kind: "file", type: "image/png", getAsFile: () => blob } as unknown as DataTransferItem;
    const data = dataTransfer({ items: [item] as unknown as DataTransferItemList, getData: () => "some text too" });

    const result = filesFromClipboard(data, FIXED_NOW);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("pasted-2026-08-05-143052.png");
    expect(result[0].type).toBe("image/png");
  });

  it("plain text is used ONLY when there is no file and no image", () => {
    const data = dataTransfer({ items: [] as unknown as DataTransferItemList, getData: () => "hello world" });

    const result = filesFromClipboard(data, FIXED_NOW);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("pasted-2026-08-05-143052.txt");
    expect(result[0].type).toBe("text/plain");
  });

  it("whitespace-only text produces nothing", () => {
    const data = dataTransfer({ getData: () => "   \n\t  " });
    expect(filesFromClipboard(data, FIXED_NOW)).toEqual([]);
  });

  it("no file, no image, no text produces nothing", () => {
    const data = dataTransfer({});
    expect(filesFromClipboard(data, FIXED_NOW)).toEqual([]);
  });

  it("an unreadable image item (getAsFile returns null) produces nothing rather than throwing", () => {
    const item = { kind: "file", type: "image/png", getAsFile: () => null } as unknown as DataTransferItem;
    const data = dataTransfer({ items: [item] as unknown as DataTransferItemList });
    expect(filesFromClipboard(data, FIXED_NOW)).toEqual([]);
  });
});
