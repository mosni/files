import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadArchive, isArchiveSupported } from "../../src/lib/archive.ts";

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
