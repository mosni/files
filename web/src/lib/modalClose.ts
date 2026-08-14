// E7-QA1 §1.4 (F7): the one place that reconciles <mosni-modal>'s OWN close - backdrop click, ESC, its own
// close control - with React's `open` prop. A real <mosni-modal> can close itself without React knowing;
// `open` then stays `true` while the element is shut, so setting it `true` again is a no-op and the modal
// never reopens. Four instances share the identical bug (ShareDialog.tsx, FileBrowser.tsx's two inline
// Delete modals, MoveModal) - this hook is the single fix all four apply.
//
// ⚠ The exact event contract could not be verified against mosni-chrome's own source (not in this
// session's repository scope, per the waves hand-off's §1.4 warning and open question #2). What IS known
// from this app's own code (ShareDialog.tsx's load-bearing wrapper comment, e2e/share.spec.ts's
// `dialog.modal` assertion): MosniModal re-parents its light-DOM children into a real `<dialog>` element it
// builds and appends to itself. A native `<dialog>` fires a non-bubbling `close` event on ITSELF whenever
// it is dismissed - via `.close()`, a `method="dialog"` form submit, or the browser's own ESC handling -
// which covers backdrop/ESC/close-button dismissal without this app needing to know which one fired.
// Listening with `capture: true` on the OUTER `<mosni-modal>` element still observes that inner event: the
// capturing phase runs top-down regardless of an event's `bubbles` flag, so a capturing listener on an
// ancestor fires even for a non-bubbling event dispatched on a descendant. This hook ALSO listens for a
// `mosni-modal-close` custom event on the element itself, matching this app's own naming convention for
// other mosni-chrome custom events (`mosni-dropdown-select`, `mosni-tab-change`) - if MosniModal emits
// something differently named instead, that listener is a harmless no-op and the native `close` capture
// still catches every dismissal route that goes through the internal `<dialog>`.
//
// Safe when the element has not upgraded (jsdom without the design system registered): the listeners are
// attached but simply never fire, since nothing ever dispatches `close` or `mosni-modal-close` on a plain
// unknown element.

import { useCallback, useRef } from "react";

export function useModalClose(onClose: () => void): React.RefCallback<HTMLElement> {
  const cleanupRef = useRef<(() => void) | null>(null);

  return useCallback(
    (element: HTMLElement | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (element === null) return;

      const handleClose = () => onClose();
      // capture: true so this also observes the internal, non-bubbling `close` event a real <dialog>
      // fires on ITSELF once MosniModal re-parents this element's children into one.
      element.addEventListener("close", handleClose, { capture: true });
      element.addEventListener("mosni-modal-close", handleClose);
      cleanupRef.current = () => {
        element.removeEventListener("close", handleClose, { capture: true });
        element.removeEventListener("mosni-modal-close", handleClose);
      };
    },
    [onClose],
  );
}
