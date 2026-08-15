(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSliderChange } from "../../src/lib/sliderChange.ts";

// E7-QA2 §1.3/B5.7: the hook that lets a real <mosni-slider> drive React state - sliderChange.ts's sibling
// to switchChange.ts. mosni-chrome's mosni-slider (D-207) reflects the selected stop INDEX onto its own
// `value` ATTRIBUTE before any ancestor's bubble-phase listener runs, and dispatches no custom event of its
// own - so this hook listens for a plain, bubbling `change` and reads the host element's OWN `value`
// attribute, never `event.target` (which is the internal range input mosni-slider owns, not this element).
// Exercised against a bare element that reproduces exactly that contract by hand, mirroring
// switchChange.test.tsx's five cases. THIS FIXTURE IS A DOUBLE: it sets the `value` attribute itself before
// dispatching, so it can only prove this hook is correct, never that <mosni-slider> actually behaves this
// way - only Wave C's real-browser test can prove that (review session 049's lesson about
// switchChange.test.tsx, carried forward here on purpose).

let container: HTMLDivElement;
let root: Root;

function Host({
  onChange,
  onRef,
}: {
  onChange: (index: number) => void;
  onRef: (fn: (el: HTMLElement | null) => void) => void;
}) {
  const ref = useSliderChange(onChange);
  onRef(ref);
  return null;
}

afterEach(async () => {
  if (root !== undefined) await act(async () => root.unmount());
  container?.remove();
});

function mount(onChange: (index: number) => void): (el: HTMLElement | null) => void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  let capturedRef: ((el: HTMLElement | null) => void) | undefined;
  act(() => {
    root.render(<Host onChange={onChange} onRef={(fn) => (capturedRef = fn)} />);
  });
  return capturedRef!;
}

describe("useSliderChange", () => {
  it("reads the host's own value attribute (as a number) at the time change bubbles", () => {
    const onChange = vi.fn();
    const attach = mount(onChange);
    const el = document.createElement("div");
    document.body.appendChild(el);
    act(() => attach(el));

    // Mirrors mosni-slider's own internal listener: it sets `value` BEFORE the bubble reaches an
    // ancestor, so the fixture does the same rather than relying on event.target.
    el.setAttribute("value", "3");
    el.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(3);
    el.remove();
  });

  // Review session 052. `useSwitchChange`, the hook this was copied from, is safe by CONSTRUCTION: it
  // reads `hasAttribute`, which is a boolean for every possible DOM state. `useSliderChange` reads a
  // string and coerces it, so it inherits a trust boundary the switch never had - and `Number()` turns
  // three ordinary "the element did something we did not predict" states into three different wrong
  // answers. Measured: `Number(null)` and `Number("")` are **0**, a perfectly valid stop index, so a
  // missing attribute silently selects 30 minutes - the shortest possible link - without the user
  // choosing it. `Number("abc")` is NaN and `"99"`/`"-1"` are out of range, and `INVITE_DURATION_STOPS[i]`
  // is then `undefined`, so ShareDialog's `.label` read throws a TypeError **in React's render phase**,
  // which unmounts the whole root: the white-screen class this codebase has now been bitten by three
  // times (D-8, session 021's mosni-tab, session 045's F0).
  //
  // This is not a hypothetical about a badly-behaved element. `<mosni-slider>` is GENERIC - it is handed
  // a pipe-delimited `stops` string and reflects an index it computed against that string. The app's array
  // and the element's stop count are two separate things that must agree forever, and nothing enforces it.
  // A garbage or out-of-range value is not a user selection, so the hook must not report one.
  it("ignores a change whose value attribute is missing entirely, rather than reporting index 0", () => {
    const onChange = vi.fn();
    const attach = mount(onChange);
    const el = document.createElement("div");
    document.body.appendChild(el);
    act(() => attach(el));

    el.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onChange).not.toHaveBeenCalled();
    el.remove();
  });

  it("ignores a change whose value attribute is not a number, rather than reporting NaN", () => {
    const onChange = vi.fn();
    const attach = mount(onChange);
    const el = document.createElement("div");
    document.body.appendChild(el);
    act(() => attach(el));

    for (const garbage of ["", "abc", "1.5", "Infinity"]) {
      el.setAttribute("value", garbage);
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    expect(onChange).not.toHaveBeenCalled();
    el.remove();
  });

  it("reads a value of 0 correctly, not as falsy/missing", () => {
    const onChange = vi.fn();
    const attach = mount(onChange);
    const el = document.createElement("div");
    document.body.appendChild(el);
    act(() => attach(el));

    el.setAttribute("value", "0");
    el.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onChange).toHaveBeenCalledWith(0);
    el.remove();
  });

  it("reads the value from a change bubbling up from a nested child, not just the host itself", () => {
    const onChange = vi.fn();
    const attach = mount(onChange);
    const el = document.createElement("div");
    const inner = document.createElement("input");
    inner.type = "range";
    el.appendChild(inner);
    document.body.appendChild(el);
    act(() => attach(el));

    el.setAttribute("value", "5");
    inner.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onChange).toHaveBeenCalledWith(5);
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

    first.setAttribute("value", "2");
    first.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();

    second.setAttribute("value", "7");
    second.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(7);

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
