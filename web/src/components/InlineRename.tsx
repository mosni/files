// C8 (E4.1 Wave E findings), extracted for E5.1 Wave G (finding 8): the shared inline-rename interaction -
// a small icon trigger swaps a name into an editable input with confirm/cancel icon buttons alongside it.
// Originally lived only in FileBrowser.tsx's table rows; extracted here, exactly as ProtectionControl was
// extracted in E4, so the file-detail page (ManageControls.tsx) can reuse the identical interaction rather
// than reimplementing it with its own always-visible input+button form.

export function IconConfirmCancel({
  onConfirm,
  onCancel,
  confirmDisabled,
  confirmLabel,
  cancelLabel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  confirmDisabled?: boolean;
  confirmLabel: string;
  cancelLabel: string;
}) {
  return (
    <>
      <button type="button" className="btn-icon" aria-label={confirmLabel} disabled={confirmDisabled} onClick={onConfirm}>
        <mosni-icon name="check" size={16} />
      </button>
      <button type="button" className="btn-icon" aria-label={cancelLabel} onClick={onCancel}>
        <mosni-icon name="x" size={16} />
      </button>
    </>
  );
}

// The shared inline-rename input. Enter submits, Escape cancels - there is no <form> spanning the input
// and its confirm/cancel pair, since FileBrowser.tsx's table layout puts them in separate cells.
export function RenameInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  ariaLabel = "New name",
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  ariaLabel?: string;
}) {
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <input
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        // eslint-disable-next-line jsx-a11y/no-autofocus -- opening rename should focus the field it just revealed
        autoFocus
      />
    </div>
  );
}
