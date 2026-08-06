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

import { useEffect, useRef, useState } from "react";
import { humanSize } from "../../../app/src/lib/previewContext.ts";
import { UPLOAD_EXPIRY_MS } from "../../../app/src/lib/uploadConfig.ts";
import { pluralize } from "../lib/format.ts";
import { toastMutationFailure } from "../lib/mutationError.ts";
import { cancelUpload, matchPausedJob, resumeUpload } from "../lib/uploads.ts";
import {
  batchIsComplete,
  bumpReload,
  dismissJob,
  jobsInBatch,
  useJobs,
  type ArchiveJob,
  type Job,
  type UploadJob,
} from "../lib/jobs.ts";

// E6 Wave B8: the paused-job copy states the resumable window honestly, off the same server-owned
// constant §1.3 added rather than repeating "7 days" as a hardcoded string here too (§0.5's own warning
// about the two-places-saying-the-same-number trap).
const RESUMABLE_DAYS = Math.round(UPLOAD_EXPIRY_MS / (24 * 60 * 60 * 1000));

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function toastError(message: string): void {
  if (typeof window.mosni !== "undefined" && window.mosni.toast) {
    window.mosni.toast(message, { variant: "error" });
  }
}

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

// E6 Wave B8: the Resume control common to a `paused` job (needs the File re-offered via a picker) and a
// resumable `error` job (the module already holds the File - no picker needed). ⚠ The label is "Resume"
// in EVERY case, never "Retry" - D-173, Hannah: "retry sounds like it's starting fresh."
function ResumeButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="btn-secondary" aria-label={label} onClick={onClick}>
      Resume
    </button>
  );
}

function UploadStackItem({ upload, onDismiss }: { upload: UploadJob; onDismiss: () => void }) {
  const pausedInputRef = useRef<HTMLInputElement>(null);

  function handlePausedFile(file: File | null | undefined) {
    if (!file) return;
    if (matchPausedJob(file) !== upload.id) {
      toastError("That doesn't look like the same file - pick the original to resume it.");
      return;
    }
    resumeUpload(upload.id, file);
  }

  return (
    <div className="panel" style={{ display: "grid", gap: "0.5rem", padding: "0.85rem 1rem", position: "relative" }}>
      <DismissButton label={`Dismiss ${upload.name}`} onDismiss={onDismiss} />
      <p style={{ margin: 0, paddingRight: "1.5rem", overflowWrap: "anywhere" }}>{upload.name}</p>
      {upload.state.status === "queued" && (
        <p style={{ margin: 0, color: "var(--mosni-text-muted)" }}>Queued</p>
      )}
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
      {upload.state.status === "paused" && (
        <>
          <p style={{ margin: 0 }}>
            Paused — {humanSize(upload.state.loaded)} of {humanSize(upload.state.total)} uploaded
          </p>
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--mosni-text-muted)" }}>
            Drop {upload.name} again to finish. Resumable for {RESUMABLE_DAYS} more days.
          </p>
          <ResumeButton label={`Resume ${upload.name}`} onClick={() => pausedInputRef.current?.click()} />
          <input
            ref={pausedInputRef}
            type="file"
            style={{ display: "none" }}
            onChange={(event) => {
              handlePausedFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
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
        <>
          <p role="alert" style={{ margin: 0 }}>
            Upload failed: {upload.state.message}
          </p>
          {upload.state.resumable && (
            <ResumeButton label={`Resume ${upload.name}`} onClick={() => resumeUpload(upload.id)} />
          )}
        </>
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

// E6 Wave C4 (D-175): "Drop 5 Aug 2026" - the viewer's own locale decides day/month order and month
// spelling; the leading "Drop " plus the date is the whole default, never re-derived once the field is
// showing (only ever computed at expand time).
function defaultGroupName(now: Date): string {
  return `Drop ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(now)}`;
}

// D-175: offered once a batch has 2+ DONE uploads and nothing left in flight. Captures its own snapshot of
// `doneJobs` at construction (a `useState` lazy initializer) rather than re-deriving it from the live job
// list on every render - the parent (UploadStack) already decides ONCE when a batch first qualifies and
// never re-evaluates it, for the same reason: a successful group dismisses the batch's own per-file items,
// and re-deriving eligibility from the live list afterward would make this item's own "Grouped into X"
// result vanish once enough of the batch's items were gone.
function GroupingStackItem({ batchId, onDismiss }: { batchId: string; onDismiss: () => void }) {
  const [doneJobs] = useState<UploadJob[]>(() =>
    jobsInBatch(batchId).filter((job) => job.state.status === "done"),
  );
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState(() => defaultGroupName(new Date()));
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ name: string; previewUrl: string } | null>(null);

  async function confirmGroup() {
    if (submitting || name.trim().length === 0) return;
    setSubmitting(true);
    const token = typeof window.mosni !== "undefined" ? window.mosni.token() : null;

    try {
      const collectionRes = await fetch("/api/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders(token) },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!collectionRes.ok) {
        await toastMutationFailure(collectionRes);
        return;
      }
      const collection = (await collectionRes.json()) as { id: string; name: string; previewUrl?: string };

      // §"Grouping must never lose a file" - a partial failure below leaves every successful move in
      // place and reports how many moved; nothing here rolls a prior success back.
      let moved = 0;
      for (const job of doneJobs) {
        if (job.state.status !== "done") continue;
        const moveRes = await fetch(`/api/files/${encodeURIComponent(job.state.fileId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...authHeaders(token) },
          body: JSON.stringify({ collectionId: collection.id }),
        });
        if (moveRes.ok) {
          moved++;
          dismissJob(job.id);
        } else {
          await toastMutationFailure(moveRes);
        }
      }

      if (moved > 0) {
        setResult({ name: collection.name, previewUrl: collection.previewUrl ?? "" });
        bumpReload();
      }
      if (moved < doneJobs.length) {
        toastError(`${moved} of ${doneJobs.length} files were grouped — the rest stayed where they were.`);
      }
    } catch {
      toastError("Could not create the collection — the files stayed where they were.");
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <div className="panel" style={{ display: "grid", gap: "0.5rem", padding: "0.85rem 1rem", position: "relative" }}>
        <DismissButton label={`Dismiss ${result.name}`} onDismiss={onDismiss} />
        <p style={{ margin: 0, paddingRight: "1.5rem", overflowWrap: "anywhere" }}>Grouped into "{result.name}"</p>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <a href={result.previewUrl}>view</a>
          <button
            type="button"
            className="btn-icon"
            aria-label={`Copy link for ${result.name}`}
            onClick={() => void copyDirectLink(result.previewUrl)}
          >
            <mosni-icon name="copy" size="14" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel" style={{ display: "grid", gap: "0.5rem", padding: "0.85rem 1rem", position: "relative" }}>
      <DismissButton label="Dismiss grouping" onDismiss={onDismiss} />
      {!expanded ? (
        <button type="button" className="btn-secondary" onClick={() => setExpanded(true)}>
          Group these {doneJobs.length} files
        </button>
      ) : (
        // paddingRight clears the absolutely-positioned dismiss button, which otherwise sits ON TOP of the
        // Group button (seen in the D-79 capture, session 042) - the same clearance every other item's own
        // text already has.
        <div style={{ display: "flex", gap: "0.5rem", paddingRight: "1.5rem" }}>
          <input
            type="text"
            value={name}
            disabled={submitting}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void confirmGroup();
            }}
          />
          <button type="button" className="btn-primary" disabled={submitting} onClick={() => void confirmGroup()}>
            Group
          </button>
        </div>
      )}
    </div>
  );
}

// E6 review (session 042): dismissing a `paused` job has to ABANDON it, not just hide the item. A paused
// job is republished from localStorage on every page load (B4), so a plain dismiss came straight back on
// the next reload - and the stack floats over the file browser's right-hand column, so the row overflow
// menus underneath it stayed unclickable for as long as the entry lived (up to D-174's seven days). Found
// by the D-79 check, which could not click through it either. Dismiss = "I am not finishing this upload".
function dismissJobFully(job: Job): void {
  if (job.kind === "upload" && job.state.status === "paused") void cancelUpload(job.id);
  dismissJob(job.id);
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
  // E6 Wave C4 (D-175): batches offered for grouping, additive-only. Recomputing "is this batch eligible"
  // fresh from the live job list on every render would make an already-offered (or already-grouped)
  // batch's item disappear the moment enough of its own per-file jobs get dismissed - see
  // GroupingStackItem's header comment.
  const [groupableBatchIds, setGroupableBatchIds] = useState<string[]>([]);

  useEffect(() => {
    const newlyEligible: string[] = [];
    const seen = new Set<string>();
    for (const job of jobs) {
      if (job.kind !== "upload" || seen.has(job.batchId) || groupableBatchIds.includes(job.batchId)) continue;
      seen.add(job.batchId);
      const batch = jobsInBatch(job.batchId);
      const doneCount = batch.filter((j) => j.state.status === "done").length;
      if (batchIsComplete(job.batchId) && doneCount >= 2) newlyEligible.push(job.batchId);
    }
    if (newlyEligible.length > 0) setGroupableBatchIds((prev) => [...prev, ...newlyEligible]);
    // groupableBatchIds is read but deliberately excluded from deps - it is only ever appended to inside
    // this same effect, and including it would re-run on every append for no benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);

  function dismissGroup(batchId: string) {
    setGroupableBatchIds((prev) => prev.filter((id) => id !== batchId));
  }

  if (jobs.length === 0 && groupableBatchIds.length === 0) return null;
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
        <StackItem key={job.id} job={job} onDismiss={() => dismissJobFully(job)} />
      ))}
      {/* Grouping items render after every ordinary job - "beneath that batch's items" (§C4) in the common
          case, since a batch's own items are still contiguous near the bottom when it first qualifies. */}
      {groupableBatchIds.map((batchId) => (
        <GroupingStackItem key={batchId} batchId={batchId} onDismiss={() => dismissGroup(batchId)} />
      ))}
    </div>
  );
}
