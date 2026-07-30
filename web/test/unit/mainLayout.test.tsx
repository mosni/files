(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// D-1/D-93/D6: the browser must render BELOW the drop zone on "/", never above it and never with
// anything in between - this is the exact composition web/src/main.tsx uses for that route. main.tsx
// itself isn't imported here (it mounts eagerly against document#root, which would drag in that concern
// unrelated to this ordering guarantee) - this mounts the same two components in the same order main.tsx
// wires them in and asserts on the resulting DOM order. A MemoryRouter is still required as of E4.1 Wave
// C: FileBrowser now calls useNavigate() unconditionally (a collection click is a real navigation).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { DropZone } from "../../src/components/DropZone.tsx";
import { FileBrowser } from "../../src/components/FileBrowser.tsx";

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

let container: HTMLDivElement;
let root: Root;

describe("main.tsx's \"/\" composition: DropZone then FileBrowser, never reordered", () => {
  beforeEach(() => {
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

  it("signed out: the drop zone's panel is the first child, the browser's section comes after it", async () => {
    (window as unknown as { mosni: unknown }).mosni = {
      user: () => null,
      token: () => null,
      onChange: (cb: (u: unknown) => void) => cb(null),
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
        </MemoryRouter>,
      );
    });
    await flush();

    // A fragment mounts both components as direct sibling children of the container, in source order -
    // exactly what main.tsx's route element produces. Assert on that order directly rather than the two
    // components' internal markup, so this test survives either one's DOM changing shape later.
    expect(container.children.length).toBe(2);
    const [first, second] = Array.from(container.children);
    // D-120: signed out, the drop zone is a login-only panel - no heading, just the login control.
    expect(first!.querySelector("h1")).toBeNull();
    expect(first!.querySelector("mosni-login-button")).not.toBeNull();
    expect(second!.querySelector("h1")).toBeNull(); // the browser section has no heading of its own here
    expect(first!.compareDocumentPosition(second!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
