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

      const handleChange = () => onChange(Number(element.getAttribute("value")));
      element.addEventListener("change", handleChange);
      cleanupRef.current = () => element.removeEventListener("change", handleChange);
    },
    [onChange],
  );
}
