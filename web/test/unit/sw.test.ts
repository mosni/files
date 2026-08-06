// web/src/sw.ts runs its top-level `self.addEventListener(...)` calls against the global object at import
// time - in Vitest's jsdom environment, `self` IS `window`, a real EventTarget, so dispatching real Event
// objects (augmented with the extra properties a real ServiceWorkerGlobalScope event would carry) exercises
// the exact same listener code a real browser would run. `window.skipWaiting`/`window.clients` are stubbed
// before import since jsdom's `window` has neither.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } from "@zip.js/zip.js";

type FetchEventLike = Event & { request: Request; respondWith: (response: Response | Promise<Response>) => void };
type ExtendableEventLike = Event & { waitUntil: (p: Promise<unknown>) => void };
type MessageEventLike = Event & { data: unknown; source: { postMessage(message: unknown): void } | null };

beforeAll(async () => {
  (window as unknown as { skipWaiting: () => Promise<void> }).skipWaiting = vi.fn().mockResolvedValue(undefined);
  (window as unknown as { clients: { claim: () => Promise<void> } }).clients = {
    claim: vi.fn().mockResolvedValue(undefined),
  };
  await import("../../src/sw.ts");
});

function dispatchFetch(url: string): { event: FetchEventLike; respondWith: ReturnType<typeof vi.fn> } {
  const event = new Event("fetch") as unknown as FetchEventLike;
  const respondWith = vi.fn();
  Object.assign(event, { request: new Request(url), respondWith });
  window.dispatchEvent(event);
  return { event, respondWith };
}

function dispatchMessage(data: unknown, source: { postMessage(message: unknown): void } | null = null): void {
  const event = new Event("message") as unknown as MessageEventLike;
  Object.assign(event, { data, source });
  window.dispatchEvent(event);
}

async function readZipEntries(response: Response): Promise<{ filename: string; text: string }[]> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  const entries = await reader.getEntries();
  const out: { filename: string; text: string }[] = [];
  for (const entry of entries) {
    if (entry.directory) continue;
    const data = await entry.getData(new Uint8ArrayWriter());
    out.push({ filename: entry.filename, text: new TextDecoder().decode(data) });
  }
  await reader.close();
  return out;
}

describe("service worker install/activate (E5 Wave G)", () => {
  it("calls skipWaiting on install", () => {
    window.dispatchEvent(new Event("install"));
    expect((window as unknown as { skipWaiting: () => Promise<void> }).skipWaiting).toHaveBeenCalled();
  });

  it("waits on clients.claim() on activate", () => {
    const event = new Event("activate") as unknown as ExtendableEventLike;
    const waitUntil = vi.fn();
    Object.assign(event, { waitUntil });
    window.dispatchEvent(event);
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });
});

describe("archive fetch interception (D-133)", () => {
  it("ignores a request outside the /__archive/ prefix - leaves it to the browser", () => {
    const { respondWith } = dispatchFetch("https://files.mosni.dev/api/browse");
    expect(respondWith).not.toHaveBeenCalled();
  });

  it("ignores an unknown archive id (no manifest was ever posted for it)", () => {
    const { respondWith } = dispatchFetch("https://files.mosni.dev/__archive/never-registered/name.zip");
    expect(respondWith).not.toHaveBeenCalled();
  });

  it("builds a real store-mode zip from the posted manifest, streaming the response immediately", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://dl.mosni.dev/a.txt") return new Response("contents of a");
      if (url === "https://dl.mosni.dev/b.txt") return new Response("contents of b");
      return new Response(null, { status: 404 });
    });

    dispatchMessage({
      type: "archive-manifest",
      id: "archive-1",
      name: "My Photos",
      files: [
        { name: "a.txt", url: "https://dl.mosni.dev/a.txt" },
        { name: "b.txt", url: "https://dl.mosni.dev/b.txt" },
      ],
    });

    const { respondWith } = dispatchFetch("https://files.mosni.dev/__archive/archive-1/My%20Photos.zip");
    expect(respondWith).toHaveBeenCalledTimes(1);
    const response = await respondWith.mock.calls[0][0];

    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="My Photos.zip"');

    const entries = await readZipEntries(response);
    expect(entries.sort((a, b) => a.filename.localeCompare(b.filename))).toEqual([
      { filename: "a.txt", text: "contents of a" },
      { filename: "b.txt", text: "contents of b" },
    ]);

    fetchSpy.mockRestore();
  });

  it("skips a file that fails every retry rather than aborting the whole archive (G2)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://dl.mosni.dev/good.txt") return new Response("good content");
      return new Response(null, { status: 500 });
    });

    let lastProgress: { type: string; id: string; completed: number; total: number; failed: string[] } | undefined;
    const source = { postMessage: vi.fn((message: unknown) => { lastProgress = message as typeof lastProgress; }) };

    dispatchMessage(
      {
        type: "archive-manifest",
        id: "archive-2",
        name: "Mixed",
        files: [
          { name: "bad.txt", url: "https://dl.mosni.dev/bad.txt" },
          { name: "good.txt", url: "https://dl.mosni.dev/good.txt" },
        ],
      },
      source,
    );

    const { respondWith } = dispatchFetch("https://files.mosni.dev/__archive/archive-2/Mixed.zip");
    const response = await respondWith.mock.calls[0][0];

    const entries = await readZipEntries(response);
    expect(entries).toEqual([{ filename: "good.txt", text: "good content" }]);
    expect(lastProgress).toMatchObject({ completed: 2, total: 2, failed: ["bad.txt"] });

    fetchSpy.mockRestore();
  }, 10000);

  // Review session 034. fetchWithRetries only guards the FETCH; a body that fails part-way through
  // (dropped connection mid-file) rejected inside the writer loop, so zipStream.close() never ran and the
  // response stream never terminated - the browser's download hung at "in progress" forever instead of
  // ending short. The archive must still close, with the broken file reported as failed.
  it("closes the archive when a file's body fails MID-STREAM, rather than hanging forever", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://dl.mosni.dev/ok.txt") return new Response("fine");
      // A response whose body errors after the headers have already been handed over.
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            controller.error(new Error("connection reset mid-file"));
          },
        }),
      );
    });

    let lastProgress: { failed: string[]; completed: number; total: number } | undefined;
    const source = {
      postMessage: vi.fn((message: unknown) => {
        lastProgress = message as typeof lastProgress;
      }),
    };

    dispatchMessage(
      {
        type: "archive-manifest",
        id: "archive-midstream",
        name: "Midstream",
        files: [
          { name: "broken.txt", url: "https://dl.mosni.dev/broken.txt" },
          { name: "ok.txt", url: "https://dl.mosni.dev/ok.txt" },
        ],
      },
      source,
    );

    const { respondWith } = dispatchFetch("https://files.mosni.dev/__archive/archive-midstream/Midstream.zip");
    const response = await respondWith.mock.calls[0][0];

    // The decisive assertion: this resolves at all. Before the fix it never settled.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(lastProgress).toMatchObject({ completed: 2, total: 2, failed: ["broken.txt"] });

    fetchSpy.mockRestore();
  }, 15000);

  it("does not retry a settled 404 - only 429/5xx are worth another attempt", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 404 }));

    dispatchMessage({
      type: "archive-manifest",
      id: "archive-404",
      name: "Gone",
      files: [{ name: "gone.txt", url: "https://dl.mosni.dev/gone.txt" }],
    });

    const { respondWith } = dispatchFetch("https://files.mosni.dev/__archive/archive-404/Gone.zip");
    const response = await respondWith.mock.calls[0][0];
    await response.arrayBuffer();

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
  }, 15000);

  it("consumes the manifest exactly once - a repeat request for the same id is not ours any more", () => {
    dispatchMessage({ type: "archive-manifest", id: "archive-3", name: "Once", files: [] });

    const first = dispatchFetch("https://files.mosni.dev/__archive/archive-3/Once.zip");
    expect(first.respondWith).toHaveBeenCalledTimes(1);

    const second = dispatchFetch("https://files.mosni.dev/__archive/archive-3/Once.zip");
    expect(second.respondWith).not.toHaveBeenCalled();
  });
});

// E6 Wave G5: the share-target handoff. jsdom does not implement IndexedDB at all, and adding a dependency
// for it is out of scope for a single test file (working-conventions.md §6's vetting gate) - this fakes
// exactly the surface sw.ts actually calls (open/onupgradeneeded, one object store, put/get/delete/
// openCursor), backed by a plain in-memory Map, async via queueMicrotask the same way the real API is.
type FakeRequest<T> = { onsuccess: (() => void) | null; onerror: (() => void) | null; result: T };
type FakeCursor = { value: unknown; delete: () => void; continue: () => void };

function makeFakeIndexedDb() {
  const dbs = new Map<string, Map<string, Map<string, unknown>>>();

  function makeStoreApi(storeMap: Map<string, unknown>, scheduleComplete: () => void) {
    return {
      put: (value: { id: string }) => {
        storeMap.set(value.id, value);
        scheduleComplete();
        return {} as FakeRequest<undefined>;
      },
      get: (key: string) => {
        const req: FakeRequest<unknown> = { onsuccess: null, onerror: null, result: undefined };
        queueMicrotask(() => {
          req.result = storeMap.get(key);
          req.onsuccess?.();
          scheduleComplete();
        });
        return req;
      },
      delete: (key: string) => {
        storeMap.delete(key);
        return {} as FakeRequest<undefined>;
      },
      openCursor: () => {
        const req: FakeRequest<FakeCursor | null> = { onsuccess: null, onerror: null, result: null };
        const keys = Array.from(storeMap.keys());
        let i = 0;
        function step() {
          if (i >= keys.length) {
            req.result = null;
            req.onsuccess?.();
            scheduleComplete();
            return;
          }
          const key = keys[i];
          req.result = {
            get value() {
              return storeMap.get(key);
            },
            delete: () => storeMap.delete(key),
            continue: () => {
              i++;
              queueMicrotask(step);
            },
          };
          req.onsuccess?.();
        }
        queueMicrotask(step);
        return req;
      },
    };
  }

  return {
    open: (name: string, _version: number) => {
      const request: { onupgradeneeded: (() => void) | null; onsuccess: (() => void) | null; onerror: (() => void) | null; result: unknown } = {
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        result: null,
      };
      let stores = dbs.get(name);
      const isNew = stores === undefined;
      if (stores === undefined) {
        stores = new Map();
        dbs.set(name, stores);
      }
      const storesRef = stores;
      const db = {
        createObjectStore: (storeName: string) => {
          if (!storesRef.has(storeName)) storesRef.set(storeName, new Map());
        },
        transaction: (storeName: string) => {
          const tx: { oncomplete: (() => void) | null; onerror: (() => void) | null; objectStore: (n: string) => ReturnType<typeof makeStoreApi> } = {
            oncomplete: null,
            onerror: null,
            objectStore: () => makeStoreApi(storesRef.get(storeName)!, () => {
              // Two microtask ticks is enough headroom for every call site in sw.ts, which always
              // assigns tx.oncomplete synchronously right after the triggering store call.
              queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
            }),
          };
          return tx;
        },
        close: () => {},
      };
      request.result = db;
      queueMicrotask(() => {
        if (isNew) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

describe("share-target handoff (E6 Wave G5)", () => {
  // A FRESH fake per test, not just per file - a prior test's fire-and-forget sweepExpiredShareTargets()
  // call (mirroring the real code's own "never blocks the redirect" contract) can still be resolving its
  // own microtask chain after that test function returns; sharing one backing store across tests let it
  // interfere with a later test's data. Isolating per test removes the hazard regardless of timing.
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = makeFakeIndexedDb();
  });

  // Builds the FormData directly and hands it back via a stubbed .formData() rather than round-tripping
  // it through a real multipart-encoded Request body: Vitest's jsdom environment parses that back with a
  // File implementation from a DIFFERENT realm than this file's global `File` (confirmed directly -
  // `entry instanceof File` comes back false, and the parsed name/size do not even match what was sent),
  // which is a gap in that environment's Fetch API support, not a defect in sw.ts's own
  // `entry instanceof File` filter - a real browser round-trips this correctly. Handing over the SAME
  // FormData object (built in-process, never serialized) sidesteps the broken step entirely without
  // weakening the real filter to accommodate a test-environment artifact.
  function shareTargetRequest(files: { name: string; type: string; content: string }[]): Request {
    const formData = new FormData();
    for (const f of files) formData.append("files", new File([f.content], f.name, { type: f.type }));
    return {
      url: "https://files.mosni.dev/share-target",
      method: "POST",
      formData: () => Promise.resolve(formData),
    } as unknown as Request;
  }

  function dispatchSharePost(files: { name: string; type: string; content: string }[]) {
    const event = new Event("fetch") as unknown as FetchEventLike;
    const respondWith = vi.fn();
    Object.assign(event, { request: shareTargetRequest(files), respondWith });
    window.dispatchEvent(event);
    return respondWith;
  }

  it("POST /share-target stores the files and redirects to /?share-target=<id>", async () => {
    const respondWith = dispatchSharePost([{ name: "photo.jpg", type: "image/jpeg", content: "img" }]);

    expect(respondWith).toHaveBeenCalledTimes(1);
    const response = await respondWith.mock.calls[0][0];
    expect(response.status).toBe(303);
    const location = response.headers.get("Location");
    expect(location).toMatch(/^https:\/\/files\.mosni\.dev\/\?share-target=[0-9a-f-]+$/);
  });

  it("a claim message returns the stored files and deletes the entry - a second claim gets nothing", async () => {
    const respondWith = dispatchSharePost([{ name: "a.txt", type: "text/plain", content: "hello" }]);
    const response = await respondWith.mock.calls[0][0];
    const id = new URL(response.headers.get("Location")!).searchParams.get("share-target")!;

    const source = { postMessage: vi.fn() };
    dispatchMessage({ type: "share-target-claim", id }, source);
    await vi.waitFor(() => expect(source.postMessage).toHaveBeenCalledTimes(1));
    const [claimPayload] = source.postMessage.mock.calls[0];
    expect(claimPayload.type).toBe("share-target-files");
    expect(claimPayload.id).toBe(id);
    expect(claimPayload.files).toHaveLength(1);
    expect(claimPayload.files[0].name).toBe("a.txt");

    const secondSource = { postMessage: vi.fn() };
    dispatchMessage({ type: "share-target-claim", id }, secondSource);
    await vi.waitFor(() => expect(secondSource.postMessage).toHaveBeenCalledTimes(1));
    expect(secondSource.postMessage.mock.calls[0][0].files).toEqual([]);
  });

  it("claiming an unknown id returns an empty file list rather than throwing", async () => {
    const source = { postMessage: vi.fn() };
    dispatchMessage({ type: "share-target-claim", id: "never-existed" }, source);
    await vi.waitFor(() => expect(source.postMessage).toHaveBeenCalledTimes(1));
    expect(source.postMessage).toHaveBeenCalledWith({ type: "share-target-files", id: "never-existed", files: [] });
  });

  it("a share-target POST with no files still redirects, storing nothing", async () => {
    const respondWith = dispatchSharePost([]);
    const response = await respondWith.mock.calls[0][0];
    expect(response.status).toBe(303);
  });

  // 30 minutes since 2026-08-06: a shared file now waits for the viewer to be signed in, and on a cold
  // PWA start that can include a full sign-in round-trip, which a 5-minute sweep outlived. See sw.ts.
  it("sweeps an entry older than the TTL, triggered as a side effect of the next POST", async () => {
    vi.useFakeTimers();
    try {
      const firstRespond = dispatchSharePost([{ name: "old.txt", type: "text/plain", content: "x" }]);
      await vi.advanceTimersByTimeAsync(0);
      const firstResponse = await firstRespond.mock.calls[0][0];
      const oldId = new URL(firstResponse.headers.get("Location")!).searchParams.get("share-target")!;

      await vi.advanceTimersByTimeAsync(31 * 60 * 1000); // past SHARE_TARGET_TTL_MS

      const secondRespond = dispatchSharePost([{ name: "new.txt", type: "text/plain", content: "y" }]);
      await vi.advanceTimersByTimeAsync(0); // lets both the redirect AND the fire-and-forget sweep settle

      const source = { postMessage: vi.fn() };
      dispatchMessage({ type: "share-target-claim", id: oldId }, source);
      await vi.advanceTimersByTimeAsync(0);

      expect(source.postMessage).toHaveBeenCalledWith({ type: "share-target-files", id: oldId, files: [] });
      void secondRespond;
    } finally {
      vi.useRealTimers();
    }
  });
});
