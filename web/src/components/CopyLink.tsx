// Preliminary-review P9: read-only link inputs with an inline copy icon, not two rival buttons. The
// preview link (which unfurls) is the primary field; the direct link is a smaller secondary field below
// it - never equal weight, so the fast path keeps one obvious action (D-1).

import { useRef } from "react";

const CopyIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

function CopyField({ value, label, primary }: { value: string; label: string; primary?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);

  async function copy() {
    await navigator.clipboard.writeText(value);
    inputRef.current?.select();
    // Guarded: the toast is a confirmation nicety, not a requirement for the copy to have worked.
    if (typeof window.mosni !== "undefined" && window.mosni.toast) {
      window.mosni.toast("Link copied", { variant: "success" });
    }
  }

  // The class names stay as behavioural hooks (tests and e2e bind to them), but the LOOK comes entirely
  // from mosni-chrome: `.panel` styles the inputs it contains (see the design system's panel-input
  // example) and `.btn` styles the button. Session 007 invented `.copy-field*` and styled none of it -
  // and since this repo ships no stylesheet at all, the field rendered as a raw browser input with the
  // URL clipped. Reuse the system rather than adding a first stylesheet here (D-31's spirit).
  return (
    <div className={primary ? "copy-field copy-field-primary" : "copy-field copy-field-secondary"}>
      <label>{label}</label>
      <div className="panel copy-field-row" style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <input
          ref={inputRef}
          type="text"
          readOnly
          value={value}
          style={{ flex: 1, minWidth: 0 }}
          onFocus={(event) => event.currentTarget.select()}
        />
        {/* D-1: the preview link is the ONE prominent action; the direct link stays deliberately
            quieter, so only the primary gets `.btn` (mosni-chrome ships no secondary variant). The
            secondary still gets enough inline styling not to read as an unstyled browser default. */}
        <button
          type="button"
          className={primary ? "btn" : undefined}
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => void copy()}
          style={
            primary
              ? undefined
              : {
                  background: "transparent",
                  border: "1px solid currentColor",
                  borderRadius: "0.4rem",
                  color: "inherit",
                  opacity: 0.7,
                  padding: "0.4rem 0.6rem",
                  cursor: "pointer",
                }
          }
        >
          <CopyIcon />
        </button>
      </div>
    </div>
  );
}

export function CopyLink({ previewUrl, directUrl }: { previewUrl: string; directUrl?: string }) {
  return (
    // minmax(0, 1fr): see Preview.tsx - a grid item's automatic minimum size is its content, and a long
    // URL in a non-shrinking input would push the page wider than the viewport.
    <div className="copy-links" style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <CopyField label="Share link" value={previewUrl} primary />
      {directUrl && <CopyField label="Direct link" value={directUrl} />}
    </div>
  );
}
