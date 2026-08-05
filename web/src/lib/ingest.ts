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

/** Extract uploadable files from a paste event's DataTransfer: a real file copied from the filesystem
 *  wins first (kept under its own name), then an image blob (renamed via nameForPastedBlob), then plain
 *  text - and ONLY plain text, only when the clipboard carried neither a file nor an image, as
 *  `pasted-<timestamp>.txt`. Whitespace-only text produces nothing. */
export function filesFromClipboard(data: DataTransfer, now: Date): File[] {
  const realFiles = Array.from(data.files);
  if (realFiles.length > 0) return realFiles;

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
