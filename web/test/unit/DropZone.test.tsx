// React's act() only suppresses its "not configured for act" console warning when this flag is set.
// There's no vitest setupFiles wired up for web/ tests yet (out of scope for this wave - see the
// implementation report), so it's set locally in each spec file instead.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// tus.Upload performs a real network round-trip; jsdom has no server to upload to, so we stub the whole
// module and capture each constructed instance to drive its callbacks (onProgress/onSuccess/onError)
// directly from the test, exactly like the real server would drive them via XHR events.
const { uploadInstances } = vi.hoisted(() => ({
  uploadInstances: [] as Array<{
    file: File;
    options: {
      endpoint?: string;
      chunkSize?: number;
      metadata?: Record<string, string>;
      headers?: Record<string, string>;
      onProgress?: (bytesSent: number, bytesTotal: number) => void;
      onSuccess?: (payload: { lastResponse: { getBody(): string } }) => void;
      onError?: (error: Error) => void;
    };
    start: () => void;
  }>,
}));

vi.mock("tus-js-client", () => {
  class MockUpload {
    file: File;
    options: (typeof uploadInstances)[number]["options"];
    start = vi.fn();

    constructor(file: File, options: (typeof uploadInstances)[number]["options"]) {
      this.file = file;
      this.options = options;
      uploadInstances.push(this as unknown as (typeof uploadInstances)[number]);
    }
  }

  return { Upload: MockUpload };
});

import { DropZone } from "../../src/components/DropZone.tsx";

// Flushes every pending microtask (fetch → res.json() → setState is two awaits deep) by yielding to a
// real macrotask - more robust than a fixed number of `await Promise.resolve()` hops.
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// React installs its own instance-level `value` setter on a mounted input/select (to track "did the
// browser see this value already" for its onChange comparison). Assigning `.value` directly goes through
// THAT setter too, so React's tracker silently updates right along with the DOM - and a subsequently
// dispatched "input"/"change" event then finds nothing changed and never calls onChange. Using the
// PROTOTYPE's native setter bypasses React's override, leaving the tracker stale so the event is seen as
// a real change.
function setNativeInputValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(input, value);
}

type MockClaims = { sub: string; roles?: string[]; mosni_owner?: boolean } | null;

function installMockMosni(user: MockClaims) {
  (window as unknown as { mosni: unknown }).mosni = {
    user: () => user,
    token: () => "test-token",
    // Real onChange fires immediately with current state, then again on every change - the immediate
    // call is what this mock exercises since these tests don't need to simulate a live sign-in/out.
    onChange: (cb: (u: MockClaims) => void) => cb(user),
    login: vi.fn(),
    logout: vi.fn(),
    toast: vi.fn(),
  };
}

function dropFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("DropZone", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    uploadInstances.length = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    delete (window as unknown as { mosni?: unknown }).mosni;
    vi.restoreAllMocks();
    // restoreAllMocks does NOT undo vi.stubGlobal, and vitest.config.ts doesn't set `unstubGlobals` -
    // so without this a failing assertion in a fetch-stubbing test leaks that stub into every test
    // after it (review session 013).
    vi.unstubAllGlobals();
  });

  it("renders a login-only panel when signed out - the login button and nothing else (D-120)", () => {
    installMockMosni(null);

    act(() => {
      root.render(<DropZone />);
    });

    expect(container.querySelector("mosni-login-button")).not.toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    // D-120: "dedicated log in panel that's only for log in, no other text" - no heading, no drop
    // target, no copy of any kind. <mosni-login-button> is the ONLY sign-in affordance in the app, so
    // the panel must never be emptied down to nothing (§0.4.1 of the hand-off).
    expect(container.querySelector("h1")).toBeNull();
    expect(container.textContent).not.toContain("Send a file");
    expect(container.textContent).not.toContain("Sign in to upload");
    const panel = container.querySelector(".panel");
    expect(panel).not.toBeNull();
    expect(panel?.children).toHaveLength(1);
    expect(panel?.firstElementChild?.tagName.toLowerCase()).toBe("mosni-login-button");
  });

  it("renders a plain no-access message when signed in without files:write (F5)", () => {
    installMockMosni({ sub: "user:1", roles: [] });

    act(() => {
      root.render(<DropZone />);
    });

    // Copy reworded in session 010 (the branch now renders a titled .panel rather than a bare <p>);
    // the assertion that matters is unchanged - no login button and no drop zone in this branch.
    expect(container.textContent).toContain("No upload access");
    expect(container.querySelector("mosni-login-button")).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it("renders the drop zone when signed in with files:write, starting one tus.Upload per file (F1)", () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });

    act(() => {
      root.render(<DropZone />);
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    dropFile(input, new File(["hello"], "hello.txt", { type: "text/plain" }));

    expect(uploadInstances).toHaveLength(1);
    expect(uploadInstances[0].options.metadata).toEqual({ filename: "hello.txt" });
    expect(uploadInstances[0].options.headers).toEqual({ Authorization: "Bearer test-token" });
    expect(uploadInstances[0].options.chunkSize).toBe(5 * 1024 * 1024);
  });

  it("reflects a simulated onProgress event as the row's --progress custom property and MB/% readout (F2)", () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });

    act(() => {
      root.render(<DropZone />);
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    dropFile(input, new File(["hello"], "hello.txt", { type: "text/plain" }));

    act(() => {
      uploadInstances[0].options.onProgress?.(50, 100);
    });

    const progressEl = container.querySelector(".progress") as HTMLElement;
    expect(progressEl).not.toBeNull();
    expect(progressEl.style.getPropertyValue("--progress")).toBe("50%");
    expect(container.textContent).toContain("50%");
    expect(container.textContent).toContain("50 B / 100 B");
  });

  it("rejects a dropped folder (0-byte File) - no upload starts, and an error toast fires", () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });

    act(() => {
      root.render(<DropZone />);
    });

    const dropArea = container.querySelector('[role="button"]') as HTMLElement;
    const folder = new File([], "testfolder");
    const dropEvent = new Event("drop", { bubbles: true, cancelable: true }) as Event & {
      dataTransfer: { files: File[] };
    };
    dropEvent.dataTransfer = { files: [folder] };

    act(() => {
      dropArea.dispatchEvent(dropEvent);
    });

    expect(uploadInstances).toHaveLength(0);
    const mosni = (window as unknown as { mosni: { toast: ReturnType<typeof vi.fn> } }).mosni;
    expect(mosni.toast).toHaveBeenCalledWith(expect.stringContaining("testfolder"), { variant: "error" });
  });

  // D-122 (E4.1 live-testing findings, Wave E, findings 1/2): completion is a floating stack element, not
  // a compact PreviewCard - no /api/preview round trip happens any more (fetchPreviewContext is gone).
  it("a completed upload renders a 'view' link and a copy-direct-link button, never a PreviewCard (D-122)", () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });

    act(() => {
      root.render(<DropZone />);
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    dropFile(input, new File(["hello"], "hello.txt", { type: "text/plain" }));

    act(() => {
      uploadInstances[0].options.onSuccess?.({
        lastResponse: {
          getBody: () =>
            JSON.stringify({
              previewUrl: "https://files.mosni.dev/abc",
              directUrl: "https://dl.mosni.dev/abc",
            }),
        },
      });
    });

    expect(container.querySelector(".progress")).toBeNull();
    // No PreviewCard: no <h1> title, no CopyLink share-field markup.
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector(".copy-field-primary")).toBeNull();

    const viewLink = container.querySelector("a") as HTMLAnchorElement;
    expect(viewLink).not.toBeNull();
    expect(viewLink.textContent).toBe("view");
    expect(viewLink.getAttribute("href")).toBe("https://files.mosni.dev/abc");
    expect(container.textContent).toContain("hello.txt");
  });

  it("the copy-direct-link button writes directUrl to the clipboard and toasts", async () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    act(() => {
      root.render(<DropZone />);
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    dropFile(input, new File(["hello"], "hello.txt", { type: "text/plain" }));
    act(() => {
      uploadInstances[0].options.onSuccess?.({
        lastResponse: {
          getBody: () =>
            JSON.stringify({ previewUrl: "https://files.mosni.dev/abc", directUrl: "https://dl.mosni.dev/abc" }),
        },
      });
    });

    const copyButton = container.querySelector('button[aria-label^="Copy direct link"]') as HTMLButtonElement;
    expect(copyButton).not.toBeNull();
    await act(async () => {
      copyButton.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("https://dl.mosni.dev/abc");
    const mosni = (window as unknown as { mosni: { toast: ReturnType<typeof vi.fn> } }).mosni;
    expect(mosni.toast).toHaveBeenCalledWith("Link copied", { variant: "success" });
  });

  it("dismissing a completed upload's stack element removes only that element", () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });

    act(() => {
      root.render(<DropZone />);
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    dropFile(input, new File(["one"], "one.txt", { type: "text/plain" }));
    dropFile(input, new File(["two"], "two.txt", { type: "text/plain" }));
    expect(uploadInstances).toHaveLength(2);

    act(() => {
      uploadInstances[0].options.onSuccess?.({
        lastResponse: {
          getBody: () => JSON.stringify({ previewUrl: "https://files.mosni.dev/one", directUrl: "https://dl.mosni.dev/one" }),
        },
      });
      uploadInstances[1].options.onSuccess?.({
        lastResponse: {
          getBody: () => JSON.stringify({ previewUrl: "https://files.mosni.dev/two", directUrl: "https://dl.mosni.dev/two" }),
        },
      });
    });

    expect(container.textContent).toContain("one.txt");
    expect(container.textContent).toContain("two.txt");

    const dismissButtons = container.querySelectorAll('button[aria-label^="Dismiss"]');
    expect(dismissButtons).toHaveLength(2);
    act(() => {
      (dismissButtons[0] as HTMLButtonElement).click();
    });

    expect(container.textContent).not.toContain("one.txt");
    expect(container.textContent).toContain("two.txt");
  });

  // A2's guard (hand-off acceptance criterion 2) shipped in session 012 with no test at all. The failure
  // it exists for is real: the file is already stored server-side and the audit notification already
  // sent, so a row stuck on `uploading` forever is a lie about state that the user cannot clear. An
  // nginx 502 page or any non-JSON body reaches this path.
  it("puts the row in error when the completion body is unreadable, never a permanent uploading (A2)", () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });

    act(() => {
      root.render(<DropZone />);
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    dropFile(input, new File(["hello"], "hello.txt", { type: "text/plain" }));

    act(() => {
      uploadInstances[0].options.onSuccess?.({
        lastResponse: { getBody: () => "<html><body>502 Bad Gateway</body></html>" },
      });
    });

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain("Upload failed");
    expect(container.querySelector(".progress")).toBeNull();
    expect(container.querySelector("button.copy-field-btn-primary")).toBeNull();
  });

  it("shows an error state for a file whose upload fails, without affecting other files (F1)", () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });

    act(() => {
      root.render(<DropZone />);
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    dropFile(input, new File(["hello"], "hello.txt", { type: "text/plain" }));

    act(() => {
      uploadInstances[0].options.onError?.(new Error("network down"));
    });

    expect(container.textContent).toContain("Upload failed");
  });

  it("each dropped file gets its own independent tus.Upload instance (F1: no grouping in this epic)", () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });

    act(() => {
      root.render(<DropZone />);
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const fileA = new File(["a"], "a.txt", { type: "text/plain" });
    const fileB = new File(["b"], "b.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { value: [fileA, fileB], configurable: true });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(uploadInstances).toHaveLength(2);
    expect(uploadInstances[0].options.metadata).toEqual({ filename: "a.txt" });
    expect(uploadInstances[1].options.metadata).toEqual({ filename: "b.txt" });
  });

  it("clicking the drop area opens the native file picker (click-to-choose, not drag-only)", () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });

    act(() => {
      root.render(<DropZone />);
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    const dropArea = container.querySelector('[role="button"]') as HTMLElement;

    act(() => {
      dropArea.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(clickSpy).toHaveBeenCalled();
  });

  it("pressing Enter or Space on the drop area also opens the file picker (keyboard access)", () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });

    act(() => {
      root.render(<DropZone />);
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    const dropArea = container.querySelector('[role="button"]') as HTMLElement;

    act(() => {
      dropArea.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(clickSpy).not.toHaveBeenCalled();

    act(() => {
      dropArea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(clickSpy).toHaveBeenCalledTimes(1);

    act(() => {
      dropArea.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    });
    expect(clickSpy).toHaveBeenCalledTimes(2);
  });

  it("dragging and dropping a file onto the drop area starts an upload (not just click-to-choose)", () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });

    act(() => {
      root.render(<DropZone />);
    });

    const dropArea = container.querySelector('[role="button"]') as HTMLElement;
    const file = new File(["hello"], "dropped.txt", { type: "text/plain" });
    const dropEvent = new Event("drop", { bubbles: true, cancelable: true }) as Event & {
      dataTransfer: { files: File[] };
    };
    dropEvent.dataTransfer = { files: [file] };

    act(() => {
      dropArea.dispatchEvent(dropEvent);
    });

    expect(uploadInstances).toHaveLength(1);
    expect(uploadInstances[0].options.metadata).toEqual({ filename: "dropped.txt" });
  });

  it("polls until window.mosni becomes available before rendering gated content", () => {
    vi.useFakeTimers();
    try {
      // window.mosni is deliberately absent at mount - the auth SDK's <script> tag can still be loading.
      act(() => {
        root.render(<DropZone />);
      });

      expect(container.querySelector("mosni-login-button")).toBeNull();
      expect(container.textContent).not.toContain("You do not have upload access.");

      installMockMosni(null);
      act(() => {
        vi.advanceTimersByTime(60);
      });

      expect(container.querySelector("mosni-login-button")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("destination picker (G1/G2, D-42/D-86, presentation amended by D-114)", () => {
    it("the drop zone and Options render as a single panel, Options expanded with no disclosure", () => {
      installMockMosni({ sub: "user:1", roles: ["files:write"] });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));

      act(() => {
        root.render(<DropZone />);
      });

      expect(container.querySelector("details")).toBeNull();
      const panels = container.querySelectorAll(".panel");
      expect(panels).toHaveLength(1);
      // Both the drop target and the destination select live in that one panel.
      expect(panels[0]!.querySelector('[role="button"]')).not.toBeNull();
      expect(panels[0]!.querySelector("#destination-select")).not.toBeNull();
    });

    it("Options data loads once on mount for an eligible user, with no toggle to trigger it (D2)", async () => {
      installMockMosni({ sub: "user:1", roles: ["files:write"] });
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ id: "coll1", name: "vacation" }]),
      });
      vi.stubGlobal("fetch", fetchSpy);

      act(() => {
        root.render(<DropZone />);
      });
      await flush();

      expect(fetchSpy).toHaveBeenCalledWith("/api/collections", { headers: { Authorization: "Bearer test-token" } });
      const options = Array.from(container.querySelectorAll("#destination-select option")).map((o) => o.textContent);
      expect(options).toContain("vacation");
    });

    it("no upload access: collections are never fetched (D2 only fires for an eligible signed-in user)", async () => {
      installMockMosni({ sub: "user:1", roles: [] });
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
      vi.stubGlobal("fetch", fetchSpy);

      act(() => {
        root.render(<DropZone />);
      });
      await flush();

      expect(fetchSpy).not.toHaveBeenCalledWith("/api/collections", expect.anything());
    });

    it("uploading with a selected destination passes destinationCollectionId in tus metadata", () => {
      installMockMosni({ sub: "user:1", roles: ["files:write"] });

      act(() => {
        root.render(<DropZone />);
      });

      const select = container.querySelector("#destination-select") as HTMLSelectElement;
      act(() => {
        const option = document.createElement("option");
        option.value = "coll-chosen";
        select.appendChild(option);
        setNativeInputValue(select, "coll-chosen");
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });

      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      dropFile(input, new File(["hello"], "hello.txt", { type: "text/plain" }));

      expect(uploadInstances[0].options.metadata).toEqual({
        filename: "hello.txt",
        destinationCollectionId: "coll-chosen",
      });
    });

    it("typing a new collection name creates it, then uploads use its returned id", async () => {
      installMockMosni({ sub: "user:1", roles: ["files:write"] });
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "coll-new" }) });
      vi.stubGlobal("fetch", fetchSpy);

      act(() => {
        root.render(<DropZone />);
      });

      const nameInput = container.querySelector("#new-collection-name") as HTMLInputElement;
      act(() => {
        setNativeInputValue(nameInput, "vacation photos");
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      });

      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      await act(async () => {
        dropFile(input, new File(["hello"], "hello.txt", { type: "text/plain" }));
        await flush();
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/collections",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "vacation photos" }),
        }),
      );
      expect(uploadInstances[0].options.metadata).toEqual({
        filename: "hello.txt",
        destinationCollectionId: "coll-new",
      });
    });

    // D-128 (E4.1 live-testing findings, Wave F/E2 item 4): a 400 specifically now toasts why, instead of
    // the fully-silent fallback every other failure keeps (D-1: a drop must never become an error dialog).
    it("a 400 rejecting the new-collection name toasts the reason, still falls back to the default", async () => {
      installMockMosni({ sub: "user:1", roles: ["files:write"] });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 400, json: () => Promise.resolve({ error: "invalid_name" }) }),
      );

      act(() => {
        root.render(<DropZone />);
      });

      const nameInput = container.querySelector("#new-collection-name") as HTMLInputElement;
      act(() => {
        setNativeInputValue(nameInput, "a/b");
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      });

      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      await act(async () => {
        dropFile(input, new File(["hello"], "hello.txt", { type: "text/plain" }));
        await flush();
      });

      expect(uploadInstances).toHaveLength(1);
      expect(uploadInstances[0].options.metadata).toEqual({ filename: "hello.txt" });
      const mosni = (window as unknown as { mosni: { toast: ReturnType<typeof vi.fn> } }).mosni;
      expect(mosni.toast).toHaveBeenCalledWith(expect.stringContaining("can't be used"), { variant: "error" });
    });

    it("a failed new-collection creation falls back to the default rather than blocking the upload", async () => {
      installMockMosni({ sub: "user:1", roles: ["files:write"] });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

      act(() => {
        root.render(<DropZone />);
      });

      const nameInput = container.querySelector("#new-collection-name") as HTMLInputElement;
      act(() => {
        setNativeInputValue(nameInput, "will fail");
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      });

      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      await act(async () => {
        dropFile(input, new File(["hello"], "hello.txt", { type: "text/plain" }));
        await flush();
      });

      expect(uploadInstances).toHaveLength(1);
      expect(uploadInstances[0].options.metadata).toEqual({ filename: "hello.txt" });
    });
  });
});
