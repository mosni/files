(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSwitchChange } from "../../src/lib/switchChange.ts";

// E7-QA1 live-testing round 2 (F4/F13): the hook that lets a real <mosni-switch> drive React state.
// Verified against the ACTUAL built https://ui.mosni.dev/mosnicat-core.js (fetched and read directly - the
// source repo is out of scope, but the served bundle is a public URL): mosni-switch's own internal
// `change` listener toggles the `checked` ATTRIBUTE on itself before any ancestor's bubble-phase listener
// runs, and dispatches no custom event of its own - so this hook listens for a plain, bubbling `change` and
// reads the host element's OWN `checked` attribute, never `event.target` (which is the internal checkbox
// mosni-switch owns, not this element). Exercised against a bare element that reproduces exactly that
// contract by hand, the same faithful-double approach modalClose.test.tsx already uses for mosni-modal.

let container: HTMLDivElement;
let root: Root;

function Host({
  onChange,
  onRef,
}: {
  onChange: (checked: boolean) => void;
  onRef: (fn: (el: HTMLElement | null) => void) => void;
}) {
  const ref = useSwitchChange(onChange);
  onRef(ref);
  return null;
}

afterEach(async () => {
  if (root !== undefined) await act(async () => root.unmount());
  container?.remove();
});

function mount(onChange: (checked: boolean) => void): (el: HTMLElement | null) => void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  let capturedRef: ((el: HTMLElement | null) => void) | undefined;
  act(() => {
    root.render(<Host onChange={onChange} onRef={(fn) => (capturedRef = fn)} />);
  });
  return capturedRef!;
}

describe("useSwitchChange", () => {
  it("calls onChange with true when the host's checked attribute is present at the time change bubbles", () => {
    const onChange = vi.fn();
    const attach = mount(onChange);
    const el = document.createElement("div");
    document.body.appendChild(el);
    act(() => attach(el));

    // Mirrors mosni-switch's own internal listener: it sets `checked` BEFORE the bubble reaches an
    // ancestor, so the fixture does the same rather than relying on event.target.
    el.setAttribute("checked", "");
    el.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
    el.remove();
  });

  it("calls onChange with false when the host's checked attribute is absent", () => {
    const onChange = vi.fn();
    const attach = mount(onChange);
    const el = document.createElement("div");
    document.body.appendChild(el);
    act(() => attach(el));

    el.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(false);
    el.remove();
  });

  it("reads the value from a change bubbling up from a nested child, not just the host itself", () => {
    const onChange = vi.fn();
    const attach = mount(onChange);
    const el = document.createElement("div");
    const inner = document.createElement("input");
    inner.type = "checkbox";
    el.appendChild(inner);
    document.body.appendChild(el);
    act(() => attach(el));

    el.setAttribute("checked", "");
    inner.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onChange).toHaveBeenCalledWith(true);
    el.remove();
  });

  it("does nothing when passed null (unmount) and never throws", () => {
    const onChange = vi.fn();
    const attach = mount(onChange);
    expect(() => act(() => attach(null))).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("detaches its listener from the previous element when the ref callback runs again", () => {
    const onChange = vi.fn();
    const attach = mount(onChange);
    const first = document.createElement("div");
    const second = document.createElement("div");
    document.body.append(first, second);

    act(() => attach(first));
    act(() => attach(second));

    first.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();

    second.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledTimes(1);

    first.remove();
    second.remove();
  });

  it("is safe when the element never dispatches anything (an unregistered custom element)", () => {
    const onChange = vi.fn();
    const attach = mount(onChange);
    const el = document.createElement("div");
    document.body.appendChild(el);
    expect(() => act(() => attach(el))).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
    el.remove();
  });
});
