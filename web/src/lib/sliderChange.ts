// E7-QA2 §1.3: the slider's sibling to switchChange.ts. mosni-chrome's `<mosni-slider>` (D-207) wraps a
// real `<input type=range>` internally, listens for that input's own native, BUBBLING `change` event, and
// reflects the selected stop INDEX onto ITSELF as the `value` ATTRIBUTE before the same event continues
// bubbling past the host - the identical reflect-then-bubble contract mosni-switch already uses (see
// switchChange.ts's header comment for the full mechanism). Reading the attribute (not `event.target`,
// which is the internal range input this element owns, not the host) is what makes this correct.
//
// Safe when the element has not upgraded (jsdom without the design system registered): the listener is
// attached but never fires, since nothing ever dispatches `change` on a plain unknown element with no
// interactive children of its own.

import { useCallback, useRef } from "react";

export function useSliderChange(onChange: (index: number) => void): React.RefCallback<HTMLElement> {
  const cleanupRef = useRef<(() => void) | null>(null);

  return useCallback(
    (element: HTMLElement | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (element === null) return;

      // Review session 052: `useSwitchChange` reads `hasAttribute`, which is a well-defined boolean for
      // EVERY possible DOM state, so it has no failure mode here. This hook reads a string, and `Number()`
      // silently turns "the element did something we did not predict" into a wrong answer three different
      // ways - `Number(null)` and `Number("")` are **0**, a valid stop index, so a missing attribute would
      // select the FIRST stop (the shortest link) as though the user had chosen it; `Number("abc")` is NaN
      // and an out-of-range index is `undefined` at the consumer, whose `.label` read then throws in
      // React's render phase and unmounts the whole root. A garbage value is not a user selection, so it
      // is not reported at all: the consumer keeps whatever it last had.
      const handleChange = () => {
        const raw = element.getAttribute("value");
        // `""` is checked separately from `null` on purpose: `Number("")` is **0**, not NaN, so an
        // empty attribute would otherwise pass every check below and report the first stop.
        if (raw === null || raw.trim() === "") return;
        const index = Number(raw);
        if (!Number.isInteger(index) || index < 0) return;
        onChange(index);
      };
      element.addEventListener("change", handleChange);
      cleanupRef.current = () => element.removeEventListener("change", handleChange);
    },
    [onChange],
  );
}
