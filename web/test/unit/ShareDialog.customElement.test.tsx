(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../src/lib/share.ts", () => ({
  fetchShareState: vi.fn(),
  fetchAccounts: vi.fn(),
  grantShare: vi.fn(),
  revokeShare: vi.fn(),
  createInvite: vi.fn(),
}));

import { ShareDialog } from "../../src/components/ShareDialog.tsx";
import { fetchAccounts, fetchShareState } from "../../src/lib/share.ts";
import type { ShareState } from "../../../app/src/lib/shareContext.ts";

// Review session 045, live crash reported by Hannah. Every other web test renders `<mosni-modal>` as an
// UNKNOWN element, because the design system is never registered in jsdom - so React's children stay
// exactly where React put them and the whole failure mode below is structurally impossible to reproduce.
// That is why 11 green ShareDialog tests, a passing D-8 assertion and a passing H7 re-render assertion all
// missed a crash that happens on literally every open of the dialog.
//
// This fake is the load-bearing half of mosni-chrome's real MosniModal (`src/js/components/modal.ts` +
// `base-element.ts`): on connect it TAKES its light-DOM children out of itself (`takeSlot`/`takeDefault`
// both call `child.remove()`) and re-parents them into a `<dialog>` it builds and appends. It deliberately
// implements nothing else - no showModal, no close button, no icons - because the relocation alone is what
// breaks React: React still believes those nodes are direct children of <mosni-modal>, so the next time it
// tries to swap one it calls removeChild/insertBefore on the wrong parent and the DOM throws
// NotFoundError. That throw lands in React's commit phase, which cannot recover, and the whole root
// unmounts - the white screen, not a broken dialog.
class FakeMosniModal extends HTMLElement {
  private rendered = false;
  connectedCallback(): void {
    if (this.rendered) return;
    this.rendered = true;

    const footerNodes: Element[] = [];
    for (const child of Array.from(this.children)) {
      if (child.getAttribute("slot") === "footer") {
        child.remove();
        footerNodes.push(child);
      }
    }
    const bodyNodes = Array.from(this.childNodes);
    for (const node of bodyNodes) node.remove();

    const dialog = document.createElement("dialog");
    const body = document.createElement("div");
    body.className = "modal-body";
    body.append(...bodyNodes);
    const footer = document.createElement("div");
    footer.className = "modal-footer";
    footer.append(...footerNodes);
    dialog.append(body, footer);
    this.appendChild(dialog);
  }
}

const fetchShareStateMock = vi.mocked(fetchShareState);
const fetchAccountsMock = vi.mocked(fetchAccounts);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const SHAREABLE_STATE: ShareState = {
  type: "file",
  id: "f1",
  name: "photo.jpg",
  effectiveProtection: "private",
  shareable: true,
  grants: [],
};

const REFUSAL_STATE: ShareState = { ...SHAREABLE_STATE, effectiveProtection: "unlisted", shareable: false };

let container: HTMLDivElement;
let root: Root;
let errors: unknown[];

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ShareDialog against a REAL custom element that re-parents its children (D-8)", () => {
  beforeEach(() => {
    if (customElements.get("mosni-modal") === undefined) {
      customElements.define("mosni-modal", FakeMosniModal);
    }
    errors = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container, {
      // React reports a commit-phase DOM throw here rather than to the console. Without this the test
      // would still fail, but on a confusing "element not found" instead of naming the real cause.
      onUncaughtError: (error: unknown) => errors.push(error),
    });
    // A FRESH Response per call - a body can only be read once, and the reopen case below fetches twice
    // (the same trap ShareDialog.test.tsx's own helper comment already documents).
    fetchAccountsMock.mockImplementation(async () => jsonResponse([]));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  // The dialog opens showing a spinner and swaps it for real content the moment GET /api/shares answers.
  // That swap is a change to <mosni-modal>'s DIRECT child list, which is exactly the list the element
  // already moved somewhere else.
  it("survives the spinner -> shareable-content swap without tearing down the React root", async () => {
    fetchShareStateMock.mockImplementation(async () => jsonResponse(SHAREABLE_STATE));

    await act(async () => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open={true} onClose={() => {}} />);
    });
    await flush();

    expect(errors).toEqual([]);
    expect(container.textContent).toContain("Add people");
  });

  it("survives the spinner -> refusal-state swap too", async () => {
    fetchShareStateMock.mockImplementation(async () => jsonResponse(REFUSAL_STATE));

    await act(async () => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open={true} onClose={() => {}} />);
    });
    await flush();

    expect(errors).toEqual([]);
    expect(container.textContent).toContain("unlisted");
  });

  // Closing and reopening resets state to null, so the swap runs a second time in the opposite direction.
  it("survives a close/reopen cycle, where the swap runs in both directions", async () => {
    fetchShareStateMock.mockImplementation(async () => jsonResponse(SHAREABLE_STATE));

    await act(async () => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open={true} onClose={() => {}} />);
    });
    await flush();
    await act(async () => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open={false} onClose={() => {}} />);
    });
    await flush();
    await act(async () => {
      root.render(<ShareDialog type="file" id="f1" objectLabel="photo.jpg" open={true} onClose={() => {}} />);
    });
    await flush();

    expect(errors).toEqual([]);
    expect(container.textContent).toContain("Add people");
  });
});
