// React's act() only suppresses its "not configured for act" console warning when this flag is set.
// There's no vitest setupFiles wired up for web/ tests yet (out of scope for this wave - see the
// implementation report), so it's set locally in each spec file instead.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// E6 (D-171, Wave 0): all tus orchestration now lives in web/src/lib/uploads.ts (see uploads.test.ts for
// its own thorough coverage) - DropZone only ever collects files and calls startBatch(). Mocking the
// controller module (rather than tus-js-client directly, as this file used to) is what lets these tests
// assert DropZone's OWN behaviour - which files, which destination, which IngestSource - without caring
// how the controller turns that into HTTP requests.
const { startBatchCalls } = vi.hoisted(() => ({
  startBatchCalls: [] as Array<{ files: File[]; options: { destinationCollectionId: string | null; source: string } }>,
}));

vi.mock("../../src/lib/uploads.ts", () => ({
  startBatch: vi.fn((files: File[], options: { destinationCollectionId: string | null; source: string }) => {
    startBatchCalls.push({ files, options });
    return `batch-${startBatchCalls.length}`;
  }),
  setUploadChunkSize: vi.fn(),
}));

// E6 Wave E: DropZone's folder branch calls walkDroppedEntries directly - stubbed here so a "drop a
// directory" test can control exactly what it returns without needing a real FileSystemEntry.
const { walkDroppedEntriesMock } = vi.hoisted(() => ({ walkDroppedEntriesMock: vi.fn() }));
vi.mock("../../src/lib/folderWalk.ts", () => ({ walkDroppedEntries: walkDroppedEntriesMock }));

import { DropZone } from "../../src/components/DropZone.tsx";
import { UploadStack } from "../../src/components/UploadStack.tsx";
import { __resetJobsStoreForTests } from "../../src/lib/jobs.ts";
import { __resetCollectionPathCacheForTests } from "../../src/lib/collections.ts";

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

function dropOnto(target: Element | Window, dataTransfer: unknown) {
  const dropEvent = new Event("drop", { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
  dropEvent.dataTransfer = dataTransfer;
  act(() => {
    target.dispatchEvent(dropEvent);
  });
}

describe("DropZone", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    startBatchCalls.length = 0;
    walkDroppedEntriesMock.mockReset();
    __resetJobsStoreForTests();
    __resetCollectionPathCacheForTests();
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
      root.render(
        <>
          <DropZone />
          <UploadStack />
        </>,
      );
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
      root.render(
        <>
          <DropZone />
          <UploadStack />
        </>,
      );
    });

    expect(container.textContent).toContain("No upload access");
    expect(container.querySelector("mosni-login-button")).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it("renders the drop zone when signed in with files:write, and calls startBatch with source picker (F1)", async () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });

    act(() => {
      root.render(
        <>
          <DropZone />
          <UploadStack />
        </>,
      );
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    dropFile(input, new File(["hello"], "hello.txt", { type: "text/plain" }));
    // resolveDestination() is async (Wave 0 shares it across every ingest path), so startBatch always
    // lands a microtask later now, even on the no-op destination path that used to complete synchronously.
    await flush();

    expect(startBatchCalls).toHaveLength(1);
    expect(startBatchCalls[0].files.map((f) => f.name)).toEqual(["hello.txt"]);
    expect(startBatchCalls[0].options).toEqual({ destinationCollectionId: null, source: "picker" });
  });

  it("rejects a genuinely empty (0-byte) dropped file - no batch starts, and an error toast fires", () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });

    act(() => {
      root.render(
        <>
          <DropZone />
          <UploadStack />
        </>,
      );
    });

    const dropArea = container.querySelector('[role="button"]') as HTMLElement;
    const empty = new File([], "empty.txt");
    dropOnto(dropArea, { files: [empty], items: undefined });

    expect(startBatchCalls).toHaveLength(0);
    const mosni = (window as unknown as { mosni: { toast: ReturnType<typeof vi.fn> } }).mosni;
    expect(mosni.toast).toHaveBeenCalledWith(expect.stringContaining("empty.txt"), { variant: "error" });
  });

  it("each dropped file is passed through in the SAME startBatch call (F1: no grouping in this epic beyond D-175's opt-in)", async () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });

    act(() => {
      root.render(
        <>
          <DropZone />
          <UploadStack />
        </>,
      );
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const fileA = new File(["a"], "a.txt", { type: "text/plain" });
    const fileB = new File(["b"], "b.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { value: [fileA, fileB], configurable: true });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(startBatchCalls).toHaveLength(1);
    expect(startBatchCalls[0].files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("clicking the drop area opens the native file picker (click-to-choose, not drag-only)", () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });

    act(() => {
      root.render(
        <>
          <DropZone />
          <UploadStack />
        </>,
      );
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
      root.render(
        <>
          <DropZone />
          <UploadStack />
        </>,
      );
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

  it("dragging and dropping a flat file onto the drop area calls startBatch with source drop", async () => {
    installMockMosni({ sub: "user:1", roles: ["files:write"] });

    act(() => {
      root.render(
        <>
          <DropZone />
          <UploadStack />
        </>,
      );
    });

    const dropArea = container.querySelector('[role="button"]') as HTMLElement;
    const droppedFile = new File(["hello"], "dropped.txt", { type: "text/plain" });
    dropOnto(dropArea, { files: [droppedFile], items: undefined });
    await flush();

    expect(startBatchCalls).toHaveLength(1);
    expect(startBatchCalls[0].files.map((f) => f.name)).toEqual(["dropped.txt"]);
    expect(startBatchCalls[0].options.source).toBe("drop");
  });

  it("polls until window.mosni becomes available before rendering gated content", () => {
    vi.useFakeTimers();
    try {
      // window.mosni is deliberately absent at mount - the auth SDK's <script> tag can still be loading.
      act(() => {
        root.render(
        <>
          <DropZone />
          <UploadStack />
        </>,
      );
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

  describe("E6 D2: clipboard paste", () => {
    function pasteWith(dataTransfer: Partial<DataTransfer>, target: EventTarget = document.body) {
      const pasteEvent = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(pasteEvent, "clipboardData", { value: dataTransfer });
      Object.defineProperty(pasteEvent, "target", { value: target });
      act(() => {
        target.dispatchEvent(pasteEvent);
      });
    }

    it("pasting an image blob on the document starts a batch with source paste", async () => {
      installMockMosni({ sub: "user:1", roles: ["files:write"] });
      act(() => {
        root.render(
          <>
            <DropZone />
            <UploadStack />
          </>,
        );
      });

      const blob = new File(["img"], "clip.png", { type: "image/png" });
      const item = { kind: "file", type: "image/png", getAsFile: () => blob } as unknown as DataTransferItem;
      pasteWith({ files: [] as unknown as FileList, items: [item] as unknown as DataTransferItemList, getData: () => "" });
      await flush();

      expect(startBatchCalls).toHaveLength(1);
      expect(startBatchCalls[0].options.source).toBe("paste");
      expect(startBatchCalls[0].files[0].type).toBe("image/png");
    });

    it("pasting inside a text input pastes text, never triggers an upload", () => {
      installMockMosni({ sub: "user:1", roles: ["files:write"] });
      act(() => {
        root.render(
          <>
            <DropZone />
            <UploadStack />
          </>,
        );
      });

      const textInput = document.createElement("input");
      document.body.appendChild(textInput);
      const blob = new File(["img"], "clip.png", { type: "image/png" });
      const item = { kind: "file", type: "image/png", getAsFile: () => blob } as unknown as DataTransferItem;
      pasteWith({ files: [] as unknown as FileList, items: [item] as unknown as DataTransferItemList, getData: () => "" }, textInput);

      expect(startBatchCalls).toHaveLength(0);
      textInput.remove();
    });

    it("a signed-out visitor's paste never triggers an upload", () => {
      installMockMosni(null);
      act(() => {
        root.render(
          <>
            <DropZone />
            <UploadStack />
          </>,
        );
      });

      const blob = new File(["img"], "clip.png", { type: "image/png" });
      const item = { kind: "file", type: "image/png", getAsFile: () => blob } as unknown as DataTransferItem;
      pasteWith({ files: [] as unknown as FileList, items: [item] as unknown as DataTransferItemList, getData: () => "" });

      expect(startBatchCalls).toHaveLength(0);
    });
  });

  describe("E6 E3/E4: folder ingest", () => {
    it("dropping a directory walks it and calls startBatch per resolved destination, not the old 'not supported yet' rejection", async () => {
      installMockMosni({ sub: "user:1", roles: ["files:write"] });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string, init?: RequestInit) => {
          if (url === "/api/collections" && init?.method === "POST") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: "coll-photos" }) });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
        }),
      );
      const fileA = new File(["a"], "a.jpg", { type: "image/jpeg" });
      walkDroppedEntriesMock.mockResolvedValue({
        files: [{ file: fileA, relativePath: ["photos", "a.jpg"] }],
        truncated: false,
        rejected: [],
      });

      act(() => {
        root.render(
          <>
            <DropZone />
            <UploadStack />
          </>,
        );
      });

      const dropArea = container.querySelector('[role="button"]') as HTMLElement;
      const dirEntry = { isDirectory: true, isFile: false, name: "photos" };
      const item = { webkitGetAsEntry: () => dirEntry } as unknown as DataTransferItem;
      await act(async () => {
        dropOnto(dropArea, { files: [] as unknown as FileList, items: [item] as unknown as DataTransferItemList });
        await flush();
      });

      const mosni = (window as unknown as { mosni: { toast: ReturnType<typeof vi.fn> } }).mosni;
      expect(mosni.toast).not.toHaveBeenCalledWith(expect.stringContaining("not supported"), expect.anything());
      expect(startBatchCalls).toHaveLength(1);
      expect(startBatchCalls[0].options).toEqual({ destinationCollectionId: "coll-photos", source: "folder" });
      expect(startBatchCalls[0].files.map((f) => f.name)).toEqual(["a.jpg"]);
    });

    it("a folder walk that reports truncation still uploads what it found and toasts once", async () => {
      installMockMosni({ sub: "user:1", roles: ["files:write"] });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));
      const fileA = new File(["a"], "a.jpg");
      walkDroppedEntriesMock.mockResolvedValue({
        files: [{ file: fileA, relativePath: ["a.jpg"] }],
        truncated: true,
        rejected: [],
      });

      act(() => {
        root.render(
          <>
            <DropZone />
            <UploadStack />
          </>,
        );
      });

      const dropArea = container.querySelector('[role="button"]') as HTMLElement;
      const dirEntry = { isDirectory: true, isFile: false, name: "photos" };
      const item = { webkitGetAsEntry: () => dirEntry } as unknown as DataTransferItem;
      await act(async () => {
        dropOnto(dropArea, { files: [] as unknown as FileList, items: [item] as unknown as DataTransferItemList });
        await flush();
      });

      expect(startBatchCalls).toHaveLength(1);
      const mosni = (window as unknown as { mosni: { toast: ReturnType<typeof vi.fn> } }).mosni;
      expect(mosni.toast).toHaveBeenCalledWith(expect.stringContaining("too large"), { variant: "error" });
    });
  });

  describe("E6 F1/F3: whole-page drop", () => {
    it("a drop on the page body (outside the zone) also uploads", async () => {
      installMockMosni({ sub: "user:1", roles: ["files:write"] });
      act(() => {
        root.render(
          <>
            <DropZone />
            <UploadStack />
          </>,
        );
      });

      const droppedFile = new File(["hello"], "page-drop.txt", { type: "text/plain" });
      dropOnto(window, { types: ["Files"], files: [droppedFile], items: undefined });
      await flush();

      expect(startBatchCalls).toHaveLength(1);
      expect(startBatchCalls[0].files.map((f) => f.name)).toEqual(["page-drop.txt"]);
    });

    it("a drop on the zone itself produces exactly ONE batch, not two (the zone's own handler plus the window handler)", async () => {
      installMockMosni({ sub: "user:1", roles: ["files:write"] });
      act(() => {
        root.render(
          <>
            <DropZone />
            <UploadStack />
          </>,
        );
      });

      const dropArea = container.querySelector('[role="button"]') as HTMLElement;
      const droppedFile = new File(["hello"], "zone-drop.txt", { type: "text/plain" });
      dropOnto(dropArea, { types: ["Files"], files: [droppedFile], items: undefined });
      await flush();

      expect(startBatchCalls).toHaveLength(1);
    });
  });

  describe("destination picker (G1/G2, D-42/D-86, presentation amended by D-114)", () => {
    it("the drop zone and Options render as a single panel, Options expanded with no disclosure", () => {
      installMockMosni({ sub: "user:1", roles: ["files:write"] });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }));

      act(() => {
        root.render(
        <>
          <DropZone />
          <UploadStack />
        </>,
      );
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
        root.render(
        <>
          <DropZone />
          <UploadStack />
        </>,
      );
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
        root.render(
        <>
          <DropZone />
          <UploadStack />
        </>,
      );
      });
      await flush();

      expect(fetchSpy).not.toHaveBeenCalledWith("/api/collections", expect.anything());
    });

    it("uploading with a selected destination passes destinationCollectionId to startBatch", async () => {
      installMockMosni({ sub: "user:1", roles: ["files:write"] });

      act(() => {
        root.render(
        <>
          <DropZone />
          <UploadStack />
        </>,
      );
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
      await flush();

      expect(startBatchCalls[0].options).toEqual({ destinationCollectionId: "coll-chosen", source: "picker" });
    });

    it("typing a new collection name creates it, then uploads use its returned id", async () => {
      installMockMosni({ sub: "user:1", roles: ["files:write"] });
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "coll-new" }) });
      vi.stubGlobal("fetch", fetchSpy);

      act(() => {
        root.render(
        <>
          <DropZone />
          <UploadStack />
        </>,
      );
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
      expect(startBatchCalls[0].options).toEqual({ destinationCollectionId: "coll-new", source: "picker" });
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
        root.render(
        <>
          <DropZone />
          <UploadStack />
        </>,
      );
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

      expect(startBatchCalls).toHaveLength(1);
      expect(startBatchCalls[0].options.destinationCollectionId).toBeNull();
      const mosni = (window as unknown as { mosni: { toast: ReturnType<typeof vi.fn> } }).mosni;
      expect(mosni.toast).toHaveBeenCalledWith(expect.stringContaining("can't be used"), { variant: "error" });
    });

    it("a failed new-collection creation falls back to the default rather than blocking the upload", async () => {
      installMockMosni({ sub: "user:1", roles: ["files:write"] });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

      act(() => {
        root.render(
        <>
          <DropZone />
          <UploadStack />
        </>,
      );
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

      expect(startBatchCalls).toHaveLength(1);
      expect(startBatchCalls[0].options.destinationCollectionId).toBeNull();
    });
  });
});
