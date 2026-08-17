// E7.5: jsdom does not implement HTMLDialogElement.showModal()/close() - both are simply absent from the
// prototype (confirmed by probing this exact jsdom version: `typeof dialog.showModal === "undefined"`).
// This is deliberate on jsdom's part (its own docs list dialog's imperative methods as requiring layout,
// which jsdom does not do) rather than a version gap to chase by upgrading. @mosni/react's <Modal> calls
// both directly in a useEffect, so every jsdom-rendered `<Modal open>` throws without this - the `open`
// IDL attribute itself DOES reflect correctly with no polyfill (verified separately), which is why only
// the two methods need one.
//
// This reproduces exactly what this app's own tests depend on - the `open` attribute flips and a `close`
// event fires - not full dialog semantics (focus trapping, the ::backdrop pseudo-element, `returnValue`,
// refusing a second showModal() while already open). If a future test needs one of those, extend this
// polyfill rather than reaching for a real-browser-only workaround.
if (typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}
