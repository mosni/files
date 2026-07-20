// F4: the fast path is "drop a file -> click to copy a link" (D-1) - so this renders exactly one
// prominent action (copy the preview link) plus a smaller, secondary control for the direct link. The
// two must never read as equal-weight choices; that would add a decision to the fast path.

type CopyLinkProps = {
  previewUrl: string;
  directUrl?: string;
};

export function CopyLink({ previewUrl, directUrl }: CopyLinkProps) {
  async function handleCopy() {
    await navigator.clipboard.writeText(previewUrl);
    // Guarded: the design-system chrome's toast is a confirmation nicety, not a requirement for the
    // copy to have worked - a missing or not-yet-loaded SDK must never break the copy action itself.
    if (typeof window.mosni !== "undefined") {
      window.mosni.toast("Link copied", { variant: "success" });
    }
  }

  return (
    <div>
      <button type="button" className="btn" onClick={() => void handleCopy()}>
        Copy link
      </button>
      {directUrl && (
        <a href={directUrl} className="direct-link">
          Direct link
        </a>
      )}
    </div>
  );
}
