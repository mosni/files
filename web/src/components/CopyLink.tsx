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

  // The class names stay as behavioural hooks (tests and e2e bind to them). Session 011 found the
  // `.panel`-wrapped field read as unstyled and detached (padding:2rem; margin:2rem auto meant for a
  // whole panel, not an inline field) - so this is now one bordered input+button unit, built from
  // mosni-chrome tokens rather than `.panel`/`.btn` (this repo ships no stylesheet - D-31's spirit).
  return (
    <div className={primary ? "copy-field copy-field-primary" : "copy-field copy-field-secondary"}>
      <label style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.35rem", color: "var(--mosni-text-muted)" }}>
        {label}
      </label>
      <div
        className="copy-field-row"
        style={{
          display: "flex",
          alignItems: "stretch",
          border: `1px solid ${primary ? "var(--mosni-purple)" : "var(--mosni-border-muted)"}`,
          borderRadius: "6px",
          background: "var(--mosni-surface-input)",
          overflow: "hidden",
        }}
      >
        <input
          ref={inputRef}
          type="text"
          readOnly
          value={value}
          style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", color: "var(--mosni-white)", padding: "0.55rem 0.65rem", font: "inherit" }}
          onFocus={(event) => event.currentTarget.select()}
        />
        {/* D-1: the preview link is the ONE prominent action; the direct link stays deliberately
            quieter - both share the same control shape, primary just gets the accent border/fill and
            a "Copy" label. */}
        <button
          type="button"
          className={primary ? "copy-field-btn copy-field-btn-primary" : "copy-field-btn"}
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => void copy()}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.35rem",
            border: "none",
            borderLeft: `1px solid ${primary ? "var(--mosni-purple)" : "var(--mosni-border-muted)"}`,
            background: primary ? "var(--mosni-purple)" : "transparent",
            color: primary ? "var(--mosni-white)" : "inherit",
            padding: "0 0.75rem",
            cursor: "pointer",
          }}
        >
          <CopyIcon />
          {primary && <span style={{ fontSize: "0.85rem" }}>Copy</span>}
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
