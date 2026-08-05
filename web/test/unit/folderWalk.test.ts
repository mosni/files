// E6 Wave E1: the recursive folder-drop walk, driven against fake FileSystemEntry/FileSystemDirectoryEntry
// objects (the real File and Directory Entries API cannot be constructed in jsdom) - depth/entry-count
// guards, the readEntries() pagination loop, and the 0-byte rejection.

import { describe, expect, it } from "vitest";
import { walkDroppedEntries } from "../../src/lib/folderWalk.ts";

type FakeFileEntry = { isDirectory: false; isFile: true; name: string; file: (cb: (f: File) => void) => void };
type FakeDirEntry = {
  isDirectory: true;
  isFile: false;
  name: string;
  createReader: () => { readEntries: (cb: (batch: FakeEntry[]) => void) => void };
};
type FakeEntry = FakeFileEntry | FakeDirEntry;

function fileEntry(name: string, size = 5): FakeFileEntry {
  return {
    isDirectory: false,
    isFile: true,
    name,
    file: (cb) => cb(new File([new Uint8Array(size)], name)),
  };
}

// A directory whose readEntries() delivers `children` across multiple 100-entry-max pages, exactly like a
// real FileSystemDirectoryReader - §0.5/E1's whole point is that a walk must call it repeatedly.
function dirEntry(name: string, children: FakeEntry[], pageSize = 100): FakeDirEntry {
  return {
    isDirectory: true,
    isFile: false,
    name,
    createReader: () => {
      let offset = 0;
      return {
        readEntries: (cb) => {
          const batch = children.slice(offset, offset + pageSize);
          offset += batch.length;
          cb(batch);
        },
      };
    },
  };
}

function itemFor(entry: FakeEntry): DataTransferItem {
  return { webkitGetAsEntry: () => entry as unknown as FileSystemEntry } as unknown as DataTransferItem;
}

describe("walkDroppedEntries (Wave E1)", () => {
  it("walks a nested directory, producing each file's directories-then-name relativePath", async () => {
    const tree = dirEntry("photos", [dirEntry("2026", [fileEntry("a.jpg")]), fileEntry("b.jpg")]);
    const result = await walkDroppedEntries([itemFor(tree)]);

    expect(result.truncated).toBe(false);
    expect(result.rejected).toEqual([]);
    const paths = result.files.map((f) => f.relativePath.join("/")).sort();
    expect(paths).toEqual(["photos/2026/a.jpg", "photos/b.jpg"]);
  });

  it("drains a directory with more than 100 entries via readEntries()'s pagination loop", async () => {
    const children = Array.from({ length: 150 }, (_, i) => fileEntry(`f${i}.bin`));
    const tree = dirEntry("bigfolder", children);
    const result = await walkDroppedEntries([itemFor(tree)]);

    expect(result.files).toHaveLength(150);
    expect(result.truncated).toBe(false);
  });

  it("rejects a genuinely empty (0-byte) file, without truncating the rest", async () => {
    const tree = dirEntry("mix", [fileEntry("empty.txt", 0), fileEntry("real.txt", 10)]);
    const result = await walkDroppedEntries([itemFor(tree)]);

    expect(result.rejected).toEqual(["empty.txt"]);
    expect(result.files.map((f) => f.file.name)).toEqual(["real.txt"]);
  });

  it("stops descending past MAX_FOLDER_DEPTH and reports truncated", async () => {
    // Build a chain 25 directories deep - past the 20-deep guard.
    let leaf: FakeEntry = fileEntry("deepest.txt");
    for (let i = 24; i >= 0; i--) leaf = dirEntry(`d${i}`, [leaf]);
    const result = await walkDroppedEntries([itemFor(leaf)]);

    expect(result.truncated).toBe(true);
  });

  it("stops after MAX_FOLDER_ENTRIES files and reports truncated", async () => {
    const children = Array.from({ length: 20_010 }, (_, i) => fileEntry(`f${i}.bin`));
    const tree = dirEntry("huge", children);
    const result = await walkDroppedEntries([itemFor(tree)]);

    expect(result.files.length).toBeLessThanOrEqual(20_000);
    expect(result.truncated).toBe(true);
  }, 20_000);

  it("a loose file dropped alongside a folder gets a single-element relativePath (no directory)", async () => {
    const loose = fileEntry("loose.txt");
    const folder = dirEntry("photos", [fileEntry("a.jpg")]);
    const result = await walkDroppedEntries([itemFor(loose), itemFor(folder)]);

    const loosePath = result.files.find((f) => f.file.name === "loose.txt");
    expect(loosePath?.relativePath).toEqual(["loose.txt"]);
  });

  it("returns nothing for items with no entry (webkitGetAsEntry unsupported/null)", async () => {
    const item = { webkitGetAsEntry: () => null } as unknown as DataTransferItem;
    const result = await walkDroppedEntries([item]);
    expect(result.files).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
