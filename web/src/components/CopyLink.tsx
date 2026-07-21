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

  return (
    <div className={primary ? "copy-field copy-field-primary" : "copy-field copy-field-secondary"}>
      <label>{label}</label>
      <div className="copy-field-row">
        <input
          ref={inputRef}
          type="text"
          readOnly
          value={value}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className={primary ? "btn" : ""}
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => void copy()}
        >
          <CopyIcon />
        </button>
      </div>
    </div>
  );
}

export function CopyLink({ previewUrl, directUrl }: { previewUrl: string; directUrl?: string }) {
  return (
    <div className="copy-links">
      <CopyField label="Share link" value={previewUrl} primary />
      {directUrl && <CopyField label="Direct link" value={directUrl} />}
    </div>
  );
}
