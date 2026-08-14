// E7-QA1 live-testing round 2: `<mosni-switch>` was reported unavailable ("could not be confirmed to exist
// upstream, mosni-chrome is not in this session's repository scope") and F4/F13 shipped as plain checkboxes
// instead - Hannah still saw plain checkboxes live and asked why. mosni-chrome's SOURCE is still out of
// this session's repository scope, but its BUILT, SERVED bundle is a public URL
// (https://ui.mosni.dev/mosnicat-core.js) - fetching and reading the real minified output directly settles
// what the source couldn't: `mosni-switch` IS registered (`p("mosni-switch",Te)`), with `observedAttributes:
// ["checked","disabled"]`. Its `render()` builds (or re-parents, if one already exists) a real
// `input[type=checkbox]` internally, listens for that checkbox's own native, BUBBLING `change` event, and
// reflects the result onto ITSELF as the `checked` ATTRIBUTE (`toggleAttribute("checked", s.checked)`) - no
// custom event is dispatched. That "checked" toggle runs during the event's target phase, strictly before a
// listener on an ANCESTOR sees the same event during its bubble phase - so by the time this hook's own
// (non-capturing, ordinary bubble) listener on the `<mosni-switch>` host runs, `hasAttribute("checked")`
// already reflects the user's actual click. Reading the attribute (not `event.target`, which is the
// internal checkbox mosni-switch owns, not this element) is what makes this correct regardless of whether
// mosni-switch found an existing light-DOM checkbox to re-parent or built its own from scratch.
//
// Safe when the element has not upgraded (jsdom without the design system registered): the listener is
// attached but never fires, since nothing ever dispatches `change` on a plain unknown element with no
// interactive children of its own.

import { useCallback, useRef } from "react";

export function useSwitchChange(onChange: (checked: boolean) => void): React.RefCallback<HTMLElement> {
  const cleanupRef = useRef<(() => void) | null>(null);

  return useCallback(
    (element: HTMLElement | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (element === null) return;

      const handleChange = () => onChange(element.hasAttribute("checked"));
      element.addEventListener("change", handleChange);
      cleanupRef.current = () => element.removeEventListener("change", handleChange);
    },
    [onChange],
  );
}
