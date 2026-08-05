// E6 Wave E: recursive folder-drop ingest, via the (webkit-prefixed at the DataTransferItem entry point,
// but universally supported) File and Directory Entries API. Mirrors web/src/lib/archive.ts's own walk
// guards exactly (§1.4 of the hand-off) - same constants, same shape, walking the opposite direction (INTO
// the app, instead of back out of it as a zip).

const MAX_FOLDER_DEPTH = 20; // == archive.ts's DEFAULT_MAX_ARCHIVE_DEPTH
const MAX_FOLDER_ENTRIES = 20_000; // == archive.ts's DEFAULT_MAX_ARCHIVE_ENTRIES
const FOLDER_WALK_CONCURRENCY = 4; // == archive.ts's WALK_CONCURRENCY

export type WalkedFile = { file: File; relativePath: string[] }; // ["photos","2026","a.jpg"] -> dirs + name
export type WalkResult = { files: WalkedFile[]; truncated: boolean; rejected: string[] };

type QueuedEntry = { entry: FileSystemEntry; path: string[]; depth: number };

// §0.5/E1: readEntries() returns AT MOST 100 entries per call and must be called repeatedly until it
// returns an empty array - the single most common way a directory walk silently truncates a large folder.
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

export async function walkDroppedEntries(items: DataTransferItem[]): Promise<WalkResult> {
  const files: WalkedFile[] = [];
  const rejected: string[] = [];
  let truncated = false;
  let entryCount = 0;

  let queue: QueuedEntry[] = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry !== null && entry !== undefined) queue.push({ entry, path: [], depth: 0 });
  }

  // Bounded-concurrency BFS, exactly archive.ts's own shape (§1.4/collectArchiveEntries) - process the
  // queue in batches of at most FOLDER_WALK_CONCURRENCY, waiting for each batch (which may itself discover
  // and enqueue child entries) before starting the next.
  while (queue.length > 0) {
    const batch = queue.splice(0, FOLDER_WALK_CONCURRENCY);
    const discovered: QueuedEntry[] = [];

    await Promise.all(
      batch.map(async ({ entry, path, depth }) => {
        if (depth > MAX_FOLDER_DEPTH) {
          truncated = true;
          return;
        }

        if (entry.isDirectory) {
          const reader = (entry as FileSystemDirectoryEntry).createReader();
          const children = await readAllEntries(reader);
          for (const child of children) {
            discovered.push({ entry: child, path: [...path, entry.name], depth: depth + 1 });
          }
          return;
        }

        if (entryCount >= MAX_FOLDER_ENTRIES) {
          truncated = true;
          return;
        }

        const file = await fileFromEntry(entry as FileSystemFileEntry);
        // The same storm guard DropZone's flat drop path already applies (0-byte File) - the folder-drop
        // case where the file itself is genuinely empty, not a folder mistaken for one, since a directory
        // never reaches this branch at all.
        if (file.size === 0) {
          rejected.push(file.name);
          return;
        }

        entryCount++;
        files.push({ file, relativePath: [...path, entry.name] });
      }),
    );

    queue = queue.concat(discovered);
  }

  return { files, truncated, rejected };
}
