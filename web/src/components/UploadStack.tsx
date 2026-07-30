// D-122 (E4.1 live-testing findings, Wave E, findings 1/2): upload progress/completion becomes a
// floating, toast-like stack instead of inline panels in the drop zone. ⚠ Reverses two prior decisions
// on purpose (E2's AC5, D-89's compact-card-on-completion, and session 013's amended AC4 as it applied to
// upload completion) - a legitimate change of mind after living with the result, not a regression. Do NOT
// "restore" PreviewCard here in a later cleanup; it stays the preview page's own renderer (AC6 stands).
//
// One floating element per file, stacked bottom-right, dismissible - stays until dismissed or its "view"
// link is clicked. D-100: the copy button copies `directUrl`, which the tus completion response already
// carries - nothing here constructs a URL.

import { humanSize } from "../../../app/src/lib/previewContext.ts";

export type UploadState =
  | { status: "uploading"; progress: number; loaded: number; total: number }
  | { status: "done"; previewUrl: string; directUrl?: string }
  | { status: "error"; message: string };

export type FileUpload = {
  id: string;
  name: string;
  state: UploadState;
};

async function copyDirectLink(url: string): Promise<void> {
  await navigator.clipboard.writeText(url);
  if (typeof window.mosni !== "undefined" && window.mosni.toast) {
    window.mosni.toast("Link copied", { variant: "success" });
  }
}

function UploadStackItem({ upload, onDismiss }: { upload: FileUpload; onDismiss: () => void }) {
  return (
    <div
      className="panel"
      style={{ display: "grid", gap: "0.5rem", padding: "0.85rem 1rem", position: "relative" }}
    >
      {/* D-111: mosni-chrome's bare `button` element selector is a filled purple primary with no
          opt-out - every button here needs an explicit variant. */}
      <button
        type="button"
        className="btn-icon"
        aria-label={`Dismiss ${upload.name}`}
        onClick={onDismiss}
        style={{ position: "absolute", top: "0.5rem", right: "0.5rem" }}
      >
        <mosni-icon name="x" size="14" />
      </button>
      <p style={{ margin: 0, paddingRight: "1.5rem", overflowWrap: "anywhere" }}>{upload.name}</p>
      {upload.state.status === "uploading" && (
        <>
          <div className="progress-label">
            <span>
              {humanSize(upload.state.loaded)} / {humanSize(upload.state.total)}
            </span>
            <span>{upload.state.progress}%</span>
          </div>
          <div className="progress" style={{ "--progress": `${upload.state.progress}%` } as React.CSSProperties} />
        </>
      )}
      {upload.state.status === "done" && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {/* A file's own name link is deliberately a full-page <a href> (Hannah: leave a file link as a
              full-page link) - opening a file is a full page load, matching FileRow's own choice. */}
          <a href={upload.state.previewUrl}>view</a>
          {upload.state.directUrl && (
            <button
              type="button"
              className="btn-icon"
              aria-label={`Copy direct link for ${upload.name}`}
              onClick={() => void copyDirectLink(upload.state.status === "done" ? (upload.state.directUrl ?? "") : "")}
            >
              <mosni-icon name="copy" size="14" />
            </button>
          )}
        </div>
      )}
      {upload.state.status === "error" && (
        <p role="alert" style={{ margin: 0 }}>
          Upload failed: {upload.state.message}
        </p>
      )}
    </div>
  );
}

export function UploadStack({ uploads, onDismiss }: { uploads: FileUpload[]; onDismiss: (id: string) => void }) {
  if (uploads.length === 0) return null;
  return (
    <div
      style={{
        position: "fixed",
        bottom: "1rem",
        right: "1rem",
        // Below the drag overlay (DropZone.tsx's overlay uses 1000) so a page-wide drag affordance is
        // never hidden behind an already-open stack item.
        zIndex: 900,
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        width: "min(22rem, calc(100vw - 2rem))",
        maxHeight: "80vh",
        overflowY: "auto",
      }}
    >
      {/* Newest at the bottom, closest to where a just-completed drop draws the eye. */}
      {uploads.map((upload) => (
        <UploadStackItem key={upload.id} upload={upload} onDismiss={() => onDismiss(upload.id)} />
      ))}
    </div>
  );
}
