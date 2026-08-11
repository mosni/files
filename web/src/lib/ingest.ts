// E6 Wave D (D-177): clipboard-paste ingest. Pure helpers with no DOM listeners, so the branching logic
// (file wins over image, image wins over text, text only when the clipboard carries neither) is
// unit-testable without a real paste event. DropZone.tsx's paste listener (D2) is the only caller.

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

// "pasted-2026-08-05-143052" - sortable, filesystem-safe, matches the format `nameForPastedBlob` and its
// test fix the clock against.
function timestampFor(now: Date): string {
  const date = [now.getFullYear(), pad2(now.getMonth() + 1), pad2(now.getDate())].join("-");
  const time = [pad2(now.getHours()), pad2(now.getMinutes()), pad2(now.getSeconds())].join("");
  return `${date}-${time}`;
}

/** D-177: pasted-2026-08-05-143052.<ext>, extension derived from the blob's own MIME type - an image type
 *  this app does not recognise falls back to `bin` rather than guessing. Files pasted from the filesystem
 *  never go through this - filesFromClipboard keeps their own real name instead. */
export function nameForPastedBlob(blob: Blob, now: Date): string {
  const ext = IMAGE_EXTENSIONS[blob.type] ?? "bin";
  return `pasted-${timestampFor(now)}.${ext}`;
}

// ⚠ Measured in real Chromium, not assumed (E6 review, session 042): pasting a SCREENSHOT populates
// `clipboardData.files` too, with a File the browser names `image.png` - it is not confined to
// `clipboardData.items`. So "is it in .files?" cannot tell a screenshot from a file copied in the file
// manager, and returning `.files` untouched (as this did) meant every pasted image uploaded as
// `image.png`, never D-177's `pasted-<timestamp>.png` - with a second paste colliding into `image(2).png`.
// The unit tests missed it because their synthetic DataTransfer left `.files` empty, which is not what a
// browser produces (verification-concept.md's H5 lesson: a fixture that is not a real one proves nothing).
//
// What DOES distinguish them is the name: a clipboard bitmap carries no filename, so the browser
// synthesises a fixed placeholder (`image.png` in Chromium and Firefox), while a copied file carries its
// own real name. Anything matching that placeholder shape is treated as a pasted bitmap and timestamped.
// The cost of a wrong guess is small and one-directional: a genuine file that happens to be named
// `image.png` gets the timestamped name D-177 asks for anyway.
const PLACEHOLDER_IMAGE_NAME = /^image\.(png|jpe?g|webp|gif)$/i;

function isPastedBitmap(file: File): boolean {
  return file.type.startsWith("image/") && (file.name === "" || PLACEHOLDER_IMAGE_NAME.test(file.name));
}

// Live-testing report (2026-08-06, Hannah): "I copied 5 files from the windows explorer and it only
// uploaded one when I hit ctrl+v". This module was verified NOT to be the cause - it maps over the whole
// of `data.files`, and uploads.ts's startBatch queues every file it is handed (both proven by test).
//
// A union of `.files` and `.items` was tried here as defensive hardening and DELIBERATELY REJECTED, which
// is worth recording so it is not "fixed" that way later: a clipboard can legitimately carry the same
// image as BOTH a real file (CF_HDROP) and a bitmap rendition (CF_DIB), and Windows Explorer does exactly
// that when copying an image file. Unioning the two sources uploads that image twice - so the hardening
// trades a hypothetical loss for a guaranteed duplicate, and breaks the deliberate precedence below
// ("a real file wins over an image blob"). The precedence is the correct behaviour; the union is not.
//
// The leading real candidate is no longer in this file at all: until 2026-08-06 the server rejected an
// entire upload with a 422 for any audio file (storage/strip.ts misread embedded cover art as video) and
// for any video in a .avi/.wmv/.flv/.ts/.ogv container. A five-file paste containing music or such a video
// would land exactly one success and four errors - "only uploaded one". That is fixed; if it recurs after
// the fix deploys, the one-step check is `event.clipboardData.files.length` in a real Windows Chromium.

/** Extract uploadable files from a paste event's DataTransfer: a real file copied from the filesystem
 *  wins first (kept under its own name), then an image blob (renamed via nameForPastedBlob), then plain
 *  text - and ONLY plain text, only when the clipboard carried neither a file nor an image, as
 *  `pasted-<timestamp>.txt`. Whitespace-only text produces nothing. */
export function filesFromClipboard(data: DataTransfer, now: Date): File[] {
  const realFiles = Array.from(data.files);
  if (realFiles.length > 0) {
    return realFiles.map((file) =>
      isPastedBitmap(file) ? new File([file], nameForPastedBlob(file, now), { type: file.type }) : file,
    );
  }

  const items = Array.from(data.items ?? []);
  const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
  if (imageItem) {
    const blob = imageItem.getAsFile();
    if (blob === null) return [];
    return [new File([blob], nameForPastedBlob(blob, now), { type: blob.type })];
  }

  // A copied file's clipboard payload is sometimes ALSO carried as plain text (its path, or its name) -
  // the two branches above already returned by the time execution reaches here, so plain text is only ever
  // considered when there was neither a file nor an image to begin with.
  const text = data.getData("text/plain");
  if (text.trim().length === 0) return [];
  return [new File([text], `pasted-${timestampFor(now)}.txt`, { type: "text/plain" })];
}
