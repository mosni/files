import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectArchiveEntries, downloadArchive, isArchiveSupported, type ArchiveWalkLevel } from "../../src/lib/archive.ts";

describe("isArchiveSupported() (E5 Wave G)", () => {
  // jsdom does not implement the Service Worker API at all, so `navigator.serviceWorker` must be stubbed
  // explicitly rather than assumed present - a real browser without support behaves exactly like this.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is true when the browser exposes navigator.serviceWorker", () => {
    vi.stubGlobal("navigator", { ...navigator, serviceWorker: {} });
    expect(isArchiveSupported()).toBe(true);
  });

  it("is false when navigator.serviceWorker is absent", () => {
    vi.stubGlobal("navigator", {});
    expect(isArchiveSupported()).toBe(false);
  });
});

describe("downloadArchive() (D-133)", () => {
  let originalServiceWorker: unknown;
  let messageListeners: ((event: MessageEvent) => void)[];
  let controllerPostMessage: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalServiceWorker = (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    messageListeners = [];
    controllerPostMessage = vi.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(),
        controller: { postMessage: controllerPostMessage },
        addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
          messageListeners.push(listener);
        },
        removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
          messageListeners = messageListeners.filter((l) => l !== listener);
        },
      },
    });
    vi.stubGlobal("crypto", { ...crypto, randomUUID: () => "fixed-archive-id" });
  });

  afterEach(() => {
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: originalServiceWorker });
    vi.unstubAllGlobals();
    document.querySelectorAll("a[href^='/__archive/']").forEach((el) => el.remove());
  });

  it("posts the manifest to the controller and clicks a same-origin archive link", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await downloadArchive("My Photos", [{ name: "a.jpg", url: "https://dl.mosni.dev/a.jpg" }]);

    expect(controllerPostMessage).toHaveBeenCalledWith({
      type: "archive-manifest",
      id: "fixed-archive-id",
      name: "My Photos",
      files: [{ name: "a.jpg", url: "https://dl.mosni.dev/a.jpg" }],
    });
    expect(clickSpy).toHaveBeenCalledTimes(1);

    clickSpy.mockRestore();
  });

  it("throws (never touches the DOM) when there is no active controller yet", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: Promise.resolve(), controller: null },
    });

    await expect(downloadArchive("name", [])).rejects.toThrow(/isn't controlling this page/);
  });

  // Review session 034, from a defect Hannah hit on a real phone: the archive sat on "Archiving 0/N…"
  // forever. `navigator.serviceWorker.ready` resolves only once a registration becomes ACTIVE - when
  // registration FAILED it never settles at all, so awaiting it bare hung indefinitely with no error and
  // no way back. G1 requires "degrade to archive unavailable", which means this has to be a bounded wait.
  it("rejects rather than hanging forever when registration failed and `ready` never settles", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      // The exact shape of a failed registration: the API exists, so isArchiveSupported() is true, but
      // `ready` is a promise that will never resolve.
      value: { ready: new Promise(() => {}), controller: null },
    });

    const pending = downloadArchive("name", []);
    const assertion = expect(pending).rejects.toThrow(/isn't available in this browser/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    vi.useRealTimers();
  });

  it("throws when service workers are unsupported, without touching navigator.serviceWorker at all", async () => {
    // `delete`, not a defined-but-undefined value - isArchiveSupported()'s `"serviceWorker" in navigator`
    // check would otherwise still see the (undefined-valued) property and report true.
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;

    await expect(downloadArchive("name", [])).rejects.toThrow(/not supported/);
  });

  it("forwards progress-message events matching this archive's id to onProgress, and unsubscribes at completion", async () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const onProgress = vi.fn();

    await downloadArchive("name", [{ name: "a", url: "https://dl.mosni.dev/a" }], onProgress);
    expect(messageListeners).toHaveLength(1);

    messageListeners[0]({
      data: { type: "archive-progress", id: "fixed-archive-id", completed: 1, total: 2, failed: [] },
    } as MessageEvent);
    expect(onProgress).toHaveBeenCalledWith({ completed: 1, total: 2, failed: [] });
    expect(messageListeners).toHaveLength(1); // not done yet - still subscribed

    messageListeners[0]({
      data: { type: "archive-progress", id: "fixed-archive-id", completed: 2, total: 2, failed: [] },
    } as MessageEvent);
    expect(onProgress).toHaveBeenLastCalledWith({ completed: 2, total: 2, failed: [] });
    expect(messageListeners).toHaveLength(0); // done - unsubscribed itself
  });

  it("ignores a progress message for a DIFFERENT archive id", async () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const onProgress = vi.fn();

    await downloadArchive("name", [], onProgress);
    messageListeners[0]({ data: { type: "archive-progress", id: "some-other-id", completed: 1, total: 1, failed: [] } } as MessageEvent);

    expect(onProgress).not.toHaveBeenCalled();
  });
});

// E5.1 Wave F (finding 10, D-159): "Download all" walks nested collections, preserving subtree paths.
// §1.5 binds throughout: every level is fetched through the SAME injected `fetchLevel` the real
// FileBrowser.tsx feeds with the exact GET /api/browse call the UI itself uses - this module never
// invents a second authorization path or a "list everything under here" endpoint.
describe("collectArchiveEntries() (E5.1 Wave F, D-159)", () => {
  function level(overrides: Partial<ArchiveWalkLevel> = {}): ArchiveWalkLevel {
    return { collections: [], files: [], nextOffset: null, ...overrides };
  }

  it("returns a flat collection's files unchanged, with no directory prefix", async () => {
    const fetchLevel = vi.fn().mockResolvedValue(
      level({ files: [{ name: "a.jpg", directUrl: "https://dl.mosni.dev/a.jpg" }] }),
    );

    const { entries, omitted } = await collectArchiveEntries("root", fetchLevel);

    expect(entries).toEqual([{ name: "a.jpg", url: "https://dl.mosni.dev/a.jpg" }]);
    expect(omitted).toEqual([]);
    expect(fetchLevel).toHaveBeenCalledWith("root", 0, null);
  });

  it("walks into a nested collection and preserves its subtree path in the entry name (D-159, AC-F1/F2)", async () => {
    const fetchLevel = vi.fn(async (collectionId: string) => {
      if (collectionId === "root") {
        return level({ collections: [{ id: "vacation", name: "Vacation" }] });
      }
      if (collectionId === "vacation") {
        return level({ files: [{ name: "beach.jpg", directUrl: "https://dl.mosni.dev/beach.jpg" }] });
      }
      return null;
    });

    const { entries } = await collectArchiveEntries("root", fetchLevel);

    expect(entries).toEqual([{ name: "Vacation/beach.jpg", url: "https://dl.mosni.dev/beach.jpg" }]);
  });

  it("a collection containing only nested collections still archives every one of their files (AC-F1)", async () => {
    const fetchLevel = vi.fn(async (collectionId: string) => {
      if (collectionId === "root") {
        return level({
          collections: [
            { id: "a", name: "A" },
            { id: "b", name: "B" },
          ],
        });
      }
      if (collectionId === "a") return level({ files: [{ name: "1.txt", directUrl: "https://dl.mosni.dev/1" }] });
      if (collectionId === "b") return level({ files: [{ name: "2.txt", directUrl: "https://dl.mosni.dev/2" }] });
      return null;
    });

    const { entries } = await collectArchiveEntries("root", fetchLevel);

    expect(entries.map((e) => e.name).sort()).toEqual(["A/1.txt", "B/2.txt"]);
  });

  it("preserves nesting more than one level deep", async () => {
    const fetchLevel = vi.fn(async (collectionId: string) => {
      if (collectionId === "root") return level({ collections: [{ id: "a", name: "A" }] });
      if (collectionId === "a") return level({ collections: [{ id: "b", name: "B" }] });
      if (collectionId === "b") return level({ files: [{ name: "deep.txt", directUrl: "https://dl.mosni.dev/deep" }] });
      return null;
    });

    const { entries } = await collectArchiveEntries("root", fetchLevel);

    expect(entries).toEqual([{ name: "A/B/deep.txt", url: "https://dl.mosni.dev/deep" }]);
  });

  it("follows pagination (nextOffset) within a single level, root included", async () => {
    const fetchLevel = vi.fn(async (collectionId: string, offset: number) => {
      if (collectionId !== "root") return null;
      if (offset === 0) {
        return level({ files: [{ name: "page1.txt", directUrl: "https://dl.mosni.dev/1" }], nextOffset: 100 });
      }
      expect(offset).toBe(100);
      return level({ files: [{ name: "page2.txt", directUrl: "https://dl.mosni.dev/2" }], nextOffset: null });
    });

    const { entries } = await collectArchiveEntries("root", fetchLevel);

    expect(entries.map((e) => e.name).sort()).toEqual(["page1.txt", "page2.txt"]);
    expect(fetchLevel).toHaveBeenCalledWith("root", 0, null);
    expect(fetchLevel).toHaveBeenCalledWith("root", 100, null);
  });

  // Session 039 (review): the walk used to pass NO token below its own root, so every level of a
  // link-shared (`secret`) subtree 404d and vanished from the zip with nothing in the omitted tail.
  it("hands each level the token its OWN parent's response carried for it, and the root the caller's", async () => {
    const seen: [string, string | null][] = [];
    const fetchLevel = vi.fn(async (collectionId: string, _offset: number, token: string | null) => {
      seen.push([collectionId, token]);
      if (collectionId === "root" && token === "roottok") {
        return level({ collections: [{ id: "sub", name: "Sub", token: "subtok" }] });
      }
      if (collectionId === "sub" && token === "subtok") {
        return level({ files: [{ name: "inside.txt", directUrl: "https://dl.mosni.dev/inside" }] });
      }
      return null; // any other token (or none) is not authorized for that level
    });

    const { entries } = await collectArchiveEntries("root", fetchLevel, {}, "roottok");

    expect(entries).toEqual([{ name: "Sub/inside.txt", url: "https://dl.mosni.dev/inside" }]);
    expect(seen).toEqual([
      ["root", "roottok"],
      ["sub", "subtok"],
    ]);
  });

  it("passes null (not the root's token) for a child whose own listing carried none", async () => {
    const seen: (string | null)[] = [];
    const fetchLevel = vi.fn(async (collectionId: string, _offset: number, token: string | null) => {
      seen.push(token);
      if (collectionId === "root") return level({ collections: [{ id: "sub", name: "Sub" }] });
      return level({ files: [{ name: "a.txt", directUrl: "https://dl.mosni.dev/a" }] });
    });

    await collectArchiveEntries("root", fetchLevel, {}, "roottok");

    expect(seen).toEqual(["roottok", null]);
  });

  it("stops paginating rather than looping forever when nextOffset does not advance (F3)", async () => {
    // A backstop against a buggy or hostile response, not an expected branch - the server always advances.
    const fetchLevel = vi.fn(async () =>
      level({ files: [{ name: "a.txt", directUrl: "https://dl.mosni.dev/a" }], nextOffset: 0 }),
    );

    const { entries } = await collectArchiveEntries("root", fetchLevel);

    expect(fetchLevel).toHaveBeenCalledTimes(1);
    expect(entries).toEqual([{ name: "a.txt", url: "https://dl.mosni.dev/a" }]);
  });

  it("a nested collection the viewer cannot browse (fetchLevel returns null) contributes nothing, with no error (AC-F3)", async () => {
    const fetchLevel = vi.fn(async (collectionId: string) => {
      if (collectionId === "root") {
        return level({
          collections: [{ id: "secret", name: "Secret" }],
          files: [{ name: "visible.txt", directUrl: "https://dl.mosni.dev/visible" }],
        });
      }
      return null; // the viewer is not authorized on "secret" - §1.5: this level's own response says so
    });

    const { entries, omitted } = await collectArchiveEntries("root", fetchLevel);

    expect(entries).toEqual([{ name: "visible.txt", url: "https://dl.mosni.dev/visible" }]);
    expect(omitted).toEqual([]);
  });

  it("sanitises a name so no entry can escape the archive root (AC-F4)", async () => {
    const fetchLevel = vi.fn(async (collectionId: string) => {
      if (collectionId === "root") {
        return level({ collections: [{ id: "evil", name: "../../etc" }] });
      }
      if (collectionId === "evil") {
        return level({ files: [{ name: "../../passwd", directUrl: "https://dl.mosni.dev/x" }] });
      }
      return null;
    });

    const { entries } = await collectArchiveEntries("root", fetchLevel);

    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry!.name.startsWith("..")).toBe(false);
    expect(entry!.name).not.toContain("/..");
    expect(entry!.name.split("/")).not.toContain("..");
  });

  it("de-duplicates a name collision within the same directory", async () => {
    const fetchLevel = vi.fn().mockResolvedValue(
      level({
        files: [
          { name: "dup.txt", directUrl: "https://dl.mosni.dev/1" },
          { name: "dup.txt", directUrl: "https://dl.mosni.dev/2" },
        ],
      }),
    );

    const { entries } = await collectArchiveEntries("root", fetchLevel);

    expect(entries.map((e) => e.name).sort()).toEqual(["dup(2).txt", "dup.txt"]);
  });

  it("a depth guard omits anything past it into the visible tail rather than hanging (AC-F5)", async () => {
    // A chain deeper than the (deliberately small, for this test) guard - a real, if pathological, tree,
    // never a cycle: parent_id makes a true cycle structurally impossible (§F3's own comment).
    const fetchLevel = vi.fn(async (collectionId: string) => {
      const depth = collectionId === "root" ? 0 : Number(collectionId.slice("c".length));
      return level({ collections: [{ id: `c${depth + 1}`, name: `L${depth + 1}` }] });
    });

    const { entries, omitted } = await collectArchiveEntries("root", fetchLevel, { maxDepth: 3 });

    expect(entries).toEqual([]);
    expect(omitted.length).toBeGreaterThan(0);
  });

  it("an entry-count guard stops adding files but still completes, reporting the rest as omitted (AC-F5)", async () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, directUrl: `https://dl.mosni.dev/${i}` }));
    const fetchLevel = vi.fn().mockResolvedValue(level({ files }));

    const { entries, omitted } = await collectArchiveEntries("root", fetchLevel, { maxEntries: 3 });

    expect(entries).toHaveLength(3);
    expect(omitted).toHaveLength(2);
  });

  it("bounds concurrency rather than firing every fetch at once (F5)", async () => {
    let active = 0;
    let maxActive = 0;
    const fetchLevel = vi.fn(async (collectionId: string) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (collectionId === "root") {
        return level({ collections: Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `C${i}` })) });
      }
      return level({ files: [{ name: "f.txt", directUrl: "https://dl.mosni.dev/f" }] });
    });

    await collectArchiveEntries("root", fetchLevel);

    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
  });
});
