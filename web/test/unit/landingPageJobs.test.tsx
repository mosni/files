// E5.1 Wave E (findings 4 + 12, D-161): the landing page's own regression coverage for the shared job
// stack - mounts the EXACT composition main.tsx renders on "/" (DropZone, FileBrowser, UploadStack, all
// three) and drives a real upload completion through the shared store, the way a real drop would.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

const { uploadInstances } = vi.hoisted(() => ({
  uploadInstances: [] as Array<{
    options: {
      onSuccess?: (payload: { lastResponse: { getBody(): string } }) => void;
    };
  }>,
}));

vi.mock("tus-js-client", () => {
  class MockUpload {
    options: (typeof uploadInstances)[number]["options"];
    start = vi.fn();
    constructor(_file: File, options: (typeof uploadInstances)[number]["options"]) {
      this.options = options;
      uploadInstances.push(this as unknown as (typeof uploadInstances)[number]);
    }
  }
  return { Upload: MockUpload };
});

import { DropZone } from "../../src/components/DropZone.tsx";
import { FileBrowser } from "../../src/components/FileBrowser.tsx";
import { UploadStack } from "../../src/components/UploadStack.tsx";
import { __resetJobsStoreForTests } from "../../src/lib/jobs.ts";

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function dropFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

let container: HTMLDivElement;
let root: Root;

describe("the landing page's shared job stack (E5.1 Wave E)", () => {
  beforeEach(() => {
    uploadInstances.length = 0;
    __resetJobsStoreForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as unknown as { mosni?: unknown }).mosni;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Finding 4: main.tsx never wired DropZone's completion to FileBrowser's listing at all on "/" - the
  // collection-page case (via the old onUploadComplete prop) worked, but the root mount never had a
  // listing to tell. Regression coverage for that gap, proved against the SHARED signal (D-161) rather
  // than a component-specific callback.
  it("completing an upload on the LANDING PAGE refreshes the listing beneath it, with no manual action (AC-E1)", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => ({ sub: "user:a", roles: ["files:write"] }),
      token: () => "tok",
      onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write"] }),
    };
    const fetchSpy = vi
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ breadcrumb: [], collections: [], files: [], nextOffset: null }) });
    vi.stubGlobal("fetch", fetchSpy);

    act(() => {
      root.render(
        <MemoryRouter>
          <DropZone />
          <FileBrowser />
          <UploadStack />
        </MemoryRouter>,
      );
    });
    await flush();

    const browseCallsBefore = fetchSpy.mock.calls.filter((call) => (call[0] as string).includes("/api/browse")).length;
    expect(browseCallsBefore).toBe(1); // the initial cold load

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    dropFile(input, new File(["hello"], "hello.txt", { type: "text/plain" }));
    await act(async () => {
      uploadInstances[0]!.options.onSuccess?.({
        lastResponse: {
          getBody: () => JSON.stringify({ previewUrl: "https://files.mosni.dev/hello", directUrl: "https://dl.mosni.dev/hello" }),
        },
      });
      await flush();
    });

    const browseCallsAfter = fetchSpy.mock.calls.filter((call) => (call[0] as string).includes("/api/browse")).length;
    expect(browseCallsAfter).toBe(2); // refetched once, automatically, with no manual refresh
  });

  it("exactly one job stack renders, even with a drop zone and a browser both mounted (AC-E3)", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => ({ sub: "user:a", roles: ["files:write"] }),
      token: () => "tok",
      onChange: (cb: (u: unknown) => void) => cb({ sub: "user:a", roles: ["files:write"] }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ breadcrumb: [], collections: [], files: [], nextOffset: null }) }),
    );

    act(() => {
      root.render(
        <MemoryRouter>
          <DropZone />
          <FileBrowser />
          <UploadStack />
        </MemoryRouter>,
      );
    });
    await flush();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    dropFile(input, new File(["hello"], "hello.txt", { type: "text/plain" }));
    await flush();

    expect(container.querySelectorAll(".job-stack")).toHaveLength(1);
    // Both files it could ever hold - only one upload was started, so only one item, but the point is
    // there is exactly one CONTAINER, not one per mounted component.
    expect(container.querySelectorAll(".job-stack .panel")).toHaveLength(1);
  });
});
