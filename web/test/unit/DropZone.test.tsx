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
  });

  it("renders the login button when signed out (F5)", () => {
    installMockMosni(null);

    act(() => {
      root.render(<DropZone />);
    });

    expect(container.querySelector("mosni-login-button")).not.toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
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

  it("reflects a simulated onProgress event as the row's --progress custom property (F2)", () => {
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
  });

  it("hands off to CopyLink once an upload completes, using previewUrl as primary (F1/F4)", () => {
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
    const copyButton = container.querySelector("button.btn");
    expect(copyButton).not.toBeNull();
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
});
