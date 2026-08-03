// web/src/sw.ts runs its top-level `self.addEventListener(...)` calls against the global object at import
// time - in Vitest's jsdom environment, `self` IS `window`, a real EventTarget, so dispatching real Event
// objects (augmented with the extra properties a real ServiceWorkerGlobalScope event would carry) exercises
// the exact same listener code a real browser would run. `window.skipWaiting`/`window.clients` are stubbed
// before import since jsdom's `window` has neither.
import { beforeAll, describe, expect, it, vi } from "vitest";
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
