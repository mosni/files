(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useModalClose } from "../../src/lib/modalClose.ts";

// E7-QA1 §1.4/F7: the hook that reconciles a real <mosni-modal>'s own close (backdrop/ESC/its own control)
// with React's `open` prop. Exercised against a bare element that dispatches each close route by hand -
// this hook must not assume the design system is registered (jsdom never registers it), so a plain
// HTMLElement dispatching the events it claims to listen for is a faithful enough double here. No React
// hook-testing library is a dependency of this repo (working-conventions.md §6), so this mounts a tiny
// host component the same way ShareDialog.customElement.test.tsx does, rather than adding one.

let container: HTMLDivElement;
let root: Root;

function Host({ onClose, onRef }: { onClose: () => void; onRef: (fn: (el: HTMLElement | null) => void) => void }) {
  const ref = useModalClose(onClose);
  onRef(ref);
  return null;
}

afterEach(async () => {
  if (root !== undefined) await act(async () => root.unmount());
  container?.remove();
});

function mount(onClose: () => void): (el: HTMLElement | null) => void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  let capturedRef: ((el: HTMLElement | null) => void) | undefined;
  act(() => {
    root.render(<Host onClose={onClose} onRef={(fn) => (capturedRef = fn)} />);
  });
  return capturedRef!;
}

describe("useModalClose", () => {
  it("calls onClose when the element dispatches a native, non-bubbling close event (the internal <dialog>'s route)", () => {
    const onClose = vi.fn();
    const attach = mount(onClose);
    const el = document.createElement("div");
    document.body.appendChild(el);
    act(() => attach(el));

    el.dispatchEvent(new Event("close", { bubbles: false }));

    expect(onClose).toHaveBeenCalledTimes(1);
    el.remove();
  });

  it("calls onClose when the element dispatches a mosni-modal-close custom event", () => {
    const onClose = vi.fn();
    const attach = mount(onClose);
    const el = document.createElement("div");
    document.body.appendChild(el);
    act(() => attach(el));

    el.dispatchEvent(new CustomEvent("mosni-modal-close"));

    expect(onClose).toHaveBeenCalledTimes(1);
    el.remove();
  });

  it("does nothing when passed null (unmount) and never throws", () => {
    const onClose = vi.fn();
    const attach = mount(onClose);
    expect(() => act(() => attach(null))).not.toThrow();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("detaches its listeners from the previous element when the ref callback runs again", () => {
    const onClose = vi.fn();
    const attach = mount(onClose);
    const first = document.createElement("div");
    const second = document.createElement("div");
    document.body.append(first, second);

    act(() => attach(first));
    act(() => attach(second)); // re-attach - must detach from `first`

    first.dispatchEvent(new Event("close"));
    expect(onClose).not.toHaveBeenCalled();

    second.dispatchEvent(new Event("close"));
    expect(onClose).toHaveBeenCalledTimes(1);

    first.remove();
    second.remove();
  });

  it("is safe when the element never dispatches anything (an unregistered custom element)", () => {
    const onClose = vi.fn();
    const attach = mount(onClose);
    const el = document.createElement("div");
    document.body.appendChild(el);
    expect(() => act(() => attach(el))).not.toThrow();
    expect(onClose).not.toHaveBeenCalled();
    el.remove();
  });
});
