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
