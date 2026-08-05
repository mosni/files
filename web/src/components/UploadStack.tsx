// D-122 (E4.1 live-testing findings, Wave E, findings 1/2): upload progress/completion is a floating,
// toast-like stack instead of inline panels in the drop zone. ⚠ Reverses two prior decisions on purpose
// (E2's AC5, D-89's compact-card-on-completion, and session 013's amended AC4 as it applied to upload
// completion) - a legitimate change of mind after living with the result, not a regression. Do NOT
// "restore" PreviewCard here in a later cleanup; it stays the preview page's own renderer (AC6 stands).
//
// E5.1 Wave E (D-161): mounted exactly ONCE, in main.tsx, as a sibling of the routes - it no longer takes
// `uploads`/`onDismiss` props from DropZone. It reads directly from the shared job store
// (web/src/lib/jobs.ts) and renders BOTH kinds of job (upload and, since this wave, archive) in one
// stack - previously the archive had its own separate progress readout inside FileBrowser's toolbar. See
// jobs.ts's header comment for why the store lives outside any one component.
//
// One floating element per job, stacked bottom-right, dismissible - stays until dismissed. D-100: an
// upload's copy button copies `directUrl`, which the tus completion response already carries - nothing
// here constructs a URL.

import { humanSize } from "../../../app/src/lib/previewContext.ts";
import { pluralize } from "../lib/format.ts";
import { dismissJob, useJobs, type ArchiveJob, type Job, type UploadJob } from "../lib/jobs.ts";

async function copyDirectLink(url: string): Promise<void> {
  await navigator.clipboard.writeText(url);
  if (typeof window.mosni !== "undefined" && window.mosni.toast) {
    window.mosni.toast("Link copied", { variant: "success" });
  }
}

function DismissButton({ label, onDismiss }: { label: string; onDismiss: () => void }) {
  return (
    // D-111: mosni-chrome's bare `button` element selector is a filled purple primary with no opt-out -
    // every button here needs an explicit variant.
    <button
      type="button"
      className="btn-icon"
      aria-label={label}
      onClick={onDismiss}
      style={{ position: "absolute", top: "0.5rem", right: "0.5rem" }}
    >
      <mosni-icon name="x" size="14" />
    </button>
  );
}

function UploadStackItem({ upload, onDismiss }: { upload: UploadJob; onDismiss: () => void }) {
  return (
    <div className="panel" style={{ display: "grid", gap: "0.5rem", padding: "0.85rem 1rem", position: "relative" }}>
      <DismissButton label={`Dismiss ${upload.name}`} onDismiss={onDismiss} />
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

// E5.1 Wave F: `archive.total`/`completed` already include any entries the walk itself omitted (a depth or
// count guard tripping, or a nested collection the viewer can't browse) - see FileBrowser.tsx's
// handleDownloadAll. This component only ever renders whatever the job says; it does not know or care
// which source (the walk or the service worker's own per-file fetch) produced a `failed` entry.
function ArchiveStackItem({ archive, onDismiss }: { archive: ArchiveJob; onDismiss: () => void }) {
  const percent = archive.total > 0 ? Math.round((archive.completed / archive.total) * 100) : 0;
  return (
    <div className="panel" style={{ display: "grid", gap: "0.5rem", padding: "0.85rem 1rem", position: "relative" }}>
      <DismissButton label={`Dismiss ${archive.name}`} onDismiss={onDismiss} />
      <p style={{ margin: 0, paddingRight: "1.5rem", overflowWrap: "anywhere" }}>{archive.name}.zip</p>
      {archive.status === "archiving" && (
        <>
          <div className="progress-label">
            <span>
              {archive.completed} / {archive.total}
            </span>
            <span>{percent}%</span>
          </div>
          <div className="progress" style={{ "--progress": `${percent}%` } as React.CSSProperties} />
        </>
      )}
      {archive.status === "error" && (
        <p role="alert" style={{ margin: 0 }}>
          Could not start the archive.
        </p>
      )}
      {archive.status === "done" && (
        <p style={{ margin: 0 }}>
          {archive.failed.length > 0
            ? `Done — ${pluralize(archive.failed.length, "file")} could not be included`
            : "Archive ready"}
        </p>
      )}
    </div>
  );
}

function StackItem({ job, onDismiss }: { job: Job; onDismiss: () => void }) {
  return job.kind === "upload" ? (
    <UploadStackItem upload={job} onDismiss={onDismiss} />
  ) : (
    <ArchiveStackItem archive={job} onDismiss={onDismiss} />
  );
}

export function UploadStack() {
  const jobs = useJobs();
  if (jobs.length === 0) return null;
  return (
    <div
      className="job-stack"
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
      {/* Newest at the bottom, closest to where a just-completed drop/download draws the eye. */}
      {jobs.map((job) => (
        <StackItem key={job.id} job={job} onDismiss={() => dismissJob(job.id)} />
      ))}
    </div>
  );
}
