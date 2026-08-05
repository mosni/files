// F1: this component *is* the product for now (D-64) - drag/drop or click-to-pick, one independent
// tus.Upload per file, per-file progress, and a hand-off to CopyLink on completion. F5's gating also
// lives here since the full landing page (file browser, admin entry point) is a later epic (E4).
//
// E4.1 Wave D (D-114, amending D-42): the drop target and its Options render as ONE panel - a permanent
// dashed rectangle (not a hover-only state) plus the destination controls, always expanded rather than
// behind a <details> disclosure. D-1 still governs: expanding Options adds no REQUIRED step to open →
// drop → copy, and Options data loads once on mount for anyone who may upload, not on a toggle that no
// longer exists.

import { useEffect, useRef, useState } from "react";
import { can, type Claims } from "../../../app/src/lib/roles.ts";
import { toastMutationFailure } from "../lib/mutationError.ts";
import { fetchCollections, ensureCollectionPath, type CollectionOption } from "../lib/collections.ts";
import { startBatch, setUploadChunkSize, type IngestSource } from "../lib/uploads.ts";
import { filesFromClipboard } from "../lib/ingest.ts";
import { walkDroppedEntries, type WalkedFile } from "../lib/folderWalk.ts";

type MosniUser = Claims | null;
type MosniToastOptions = { variant?: "success" | "error" | "info" };

declare global {
  interface Window {
    mosni?: {
      user(): MosniUser;
      token(): string | null;
      onChange(cb: (user: MosniUser) => void): void;
      login(): void;
      logout(): void;
      toast(message: string, options?: MosniToastOptions): void;
    };
  }
}

// React 19's @types/react moved IntrinsicElements under React.JSX rather than a bare global `JSX`
// namespace (the old `declare global { namespace JSX {...} }` pattern silently fails to merge under
// the "react-jsx" transform with these types) - augment the "react" module's JSX namespace instead.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "mosni-login-button": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

function toastError(message: string): void {
  if (typeof window.mosni !== "undefined" && window.mosni.toast) {
    window.mosni.toast(message, { variant: "error" });
  }
}

// A genuinely empty (0-byte) File would make tus POST a create-with-upload that completes on create
// (length 0) → the server answers 200 + JSON with NO Location header → tus-js-client errors and RETRIES
// (default [0,1000,3000,5000] = 5 attempts), each attempt creating another collision-suffixed 0-byte file
// and firing an audit notification (the storm Hannah saw, session 011). The size===0 guard stays
// load-bearing for exactly that case. E6 (E1/E3): a DROPPED FOLDER no longer lands here at all - a real
// directory is walked (walkDroppedEntries) rather than rejected, so this function is only ever reached for
// a flat (no-directory) drop or the plain file picker.
function uploadableFiles(dataTransfer: DataTransfer): { files: File[]; rejected: string[] } {
  const files: File[] = [];
  const rejected: string[] = [];
  for (const file of Array.from(dataTransfer.files)) {
    if (file.size === 0) rejected.push(file.name);
    else files.push(file);
  }
  return { files, rejected };
}

// E6 E3: true when any item in the drag/drop payload is a real directory entry - the signal that decides
// whether this drop needs the recursive folder walk instead of the flat path above.
function containsDirectory(dataTransfer: DataTransfer): boolean {
  const items = dataTransfer.items;
  if (!items) return false;
  return Array.from(items).some((item) => item.webkitGetAsEntry?.()?.isDirectory === true);
}

// E6 (E3/E4): shared by a folder DROP (walkDroppedEntries, relativePath from the entries API) and a folder
// PICK (input[webkitdirectory], relativePath from File.webkitRelativePath) - both land here as the same
// WalkedFile[] shape so grouping/collection-creation happens exactly once. Groups files by their
// directory (every path segment but the last), resolves or creates ONE collection per distinct directory
// under `rootDestination` (E2), then starts one batch per directory - a loose file with no directory
// (relativePath.length === 1) goes straight to `rootDestination`, no ensureCollectionPath call at all.
async function ingestWalkedFiles(
  walked: WalkedFile[],
  token: string | null,
  rootDestination: string | null,
): Promise<void> {
  const groups = new Map<string, WalkedFile[]>();
  for (const entry of walked) {
    const dirPath = entry.relativePath.slice(0, -1);
    const key = dirPath.join("/");
    const existing = groups.get(key);
    if (existing) existing.push(entry);
    else groups.set(key, [entry]);
  }

  for (const [key, entries] of groups) {
    const dirPath = key === "" ? [] : key.split("/");
    const destination =
      dirPath.length === 0 ? rootDestination : ((await ensureCollectionPath(token, dirPath, rootDestination)) ?? rootDestination);
    startBatch(
      entries.map((e) => e.file),
      { destinationCollectionId: destination, source: "folder" },
    );
  }
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// G2: creates the typed-in collection name on demand, so a chosen destination is resolved to an id
// before any file starts uploading. Returns null (falls back to the caller's default, server-side) on
// any failure - a bad destination must never turn "drop a file" into an error dialog (D-1). D-128 (E4.1
// live-testing findings, Wave F): the fallback stays for a TRANSIENT failure, but a 400/409 specifically
// (a name failing safeSegment(), or a root name colliding with a reserved one) now toasts why, instead of
// silently landing the drop somewhere the user did not choose.
async function createCollection(token: string | null, name: string): Promise<string | null> {
  try {
    const res = await fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      await toastMutationFailure(res);
      return null;
    }
    return ((await res.json()) as CollectionOption).id;
  } catch {
    return null;
  }
}

// D-129 (E4.1 live-testing findings, Wave G): a compact, fixed-destination mode for a collection page's
// own upload box (finding 11) - reuses this component rather than building a second control (Q5). In
// compact mode the Options block does not render at all (there is nothing to pick: the destination is
// fixed), and startUploads uploads straight into `fixedCollectionId`, skipping the destination-picker
// state and the createCollection step entirely. Everything else - drag handling, the folder/empty-file
// guard, the upload machinery - is shared, unchanged.
//
// E5.1 Wave E (D-161, finding 4/12): this component no longer owns the upload list or renders the
// floating stack itself - it publishes each upload as a job to the shared store (web/src/lib/jobs.ts),
// which main.tsx's single <UploadStack /> renders. There is therefore no `onUploadComplete` prop any
// more: EVERY completed upload bumps the shared reload signal, and any mounted FileBrowser (root or
// compact-collection) reacts to that ONE signal - see jobs.ts's header comment for why a second,
// component-specific callback would just be a second path to the same thing.
export function DropZone({
  compact = false,
  fixedCollectionId,
}: { compact?: boolean; fixedCollectionId?: string } = {}) {
  const [user, setUser] = useState<MosniUser>(null);
  const [authReady, setAuthReady] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // E6 E4: a SECOND, separate hidden input for "choose a folder" - `webkitdirectory` must never land on
  // the primary input, or the primary click-to-choose would turn folder-only and break D-1's path.
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [dragDepth, setDragDepth] = useState(0); // >0 ⇒ a file drag is somewhere over the page
  const [zoneHover, setZoneHover] = useState(false); // a file drag is over the drop zone itself

  // G1/G2 (D-42, D-86): the destination picker. Collapsed by default and never fetched until opened -
  // D-1's three-action path (open → drop → copy) must never grow a step for anyone who leaves it alone.
  const [collections, setCollections] = useState<CollectionOption[]>([]);
  const [destinationCollectionId, setDestinationCollectionId] = useState("");
  const [newCollectionName, setNewCollectionName] = useState("");
  const [collectionsLoaded, setCollectionsLoaded] = useState(false);

  // Finding 2: dropping a file anywhere gave no visual cue it would even work. Tracked at the window
  // level (not just the zone) so the page-level overlay can invite the drag toward the zone; drop is
  // preventDefault'd here too so a miss-drop never navigates the browser away from the app.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (hasFiles(e)) setDragDepth((d) => d + 1);
    };
    const onLeave = (e: DragEvent) => {
      if (hasFiles(e)) setDragDepth((d) => Math.max(0, d - 1));
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    // E6 F1/F3: a drop anywhere on the page now actually ingests, not just prevents the browser navigating
    // away. The zone's OWN onDrop handler (below) calls stopPropagation(), so this native window-level
    // listener never fires for a drop that landed on the zone itself - a drop reaches here only when it
    // missed the zone, which is exactly the "whole-page drop" case. A test asserts one drop produces
    // exactly one batch (§0.3's "obvious regression" warning) - this guard is how.
    const onWindowDrop = (e: DragEvent) => {
      setDragDepth(0);
      if (!hasFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      void ingestDropped(e.dataTransfer, "drop");
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onWindowDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onWindowDrop);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((res) => (res.ok ? res.json() : null))
      .then((cfg: { uploadChunkSize?: unknown } | null) => {
        // Server-authoritative chunk size (P10): the upload controller (web/src/lib/uploads.ts) owns the
        // actual tus construction now (Wave 0) and reads its own module-level chunk size, defaulted to the
        // shared UPLOAD_CHUNK_SIZE constant until this resolves - tell it about the real value so the
        // client and the server's rate-limit budget cannot drift apart.
        if (!cancelled && cfg && typeof cfg.uploadChunkSize === "number") setUploadChunkSize(cfg.uploadChunkSize);
      })
      .catch(() => {}); // unreachable /api/config just means we keep the fallback - never blocks uploads
    return () => {
      cancelled = true;
    };
  }, []);

  // E6 E4: `webkitdirectory` (and `multiple`, so every file inside the chosen folder comes back at once)
  // are set imperatively - `webkitdirectory` is a real DOM property but not a standard JSX attribute.
  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.webkitdirectory = true;
      folderInputRef.current.multiple = true;
    }
  }, []);

  // E6 D2: a window-level paste listener. Registered per user change (mirroring the collections-loading
  // effect below) so the gate below always reads the CURRENT sign-in state rather than a stale closure.
  useEffect(() => {
    if (user === null || !can(user, "files:write")) return;

    function onPaste(event: ClipboardEvent) {
      const target = event.target as HTMLElement | null;
      // Load-bearing, not polish: the app has a rename field, a new-collection name field and (Wave C) a
      // grouping name field - pasting into any of them must paste TEXT, never trigger an upload.
      const isTextEntry =
        target !== null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (isTextEntry) return;

      const data = event.clipboardData;
      if (!data) return;
      const files = filesFromClipboard(data, new Date());
      if (files.length === 0) return;

      event.preventDefault();
      void (async () => {
        const token = typeof window.mosni !== "undefined" ? window.mosni.token() : null;
        const destination = await resolveDestination(token);
        startBatch(files, { destinationCollectionId: destination, source: "paste" });
      })();
    }

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // Deliberately not re-subscribing on every keystroke in the destination fields: resolveDestination()
    // reads that state fresh via closure on each call it makes, so the listener itself only needs to be
    // current with sign-in/eligibility, not with the picker's field values.
  }, [user, compact, fixedCollectionId]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    function subscribe() {
      // The auth SDK's <script> tag loads independently of this module's own script - never assume
      // window.mosni exists at mount time. Poll briefly until it shows up, then subscribe for good.
      if (typeof window.mosni === "undefined") {
        pollTimer = setTimeout(subscribe, 50);
        return;
      }
      window.mosni.onChange((nextUser) => {
        if (cancelled) return;
        setUser(nextUser);
        setAuthReady(true);
      });
    }

    subscribe();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, []);

  // D2/D-114: Options has no disclosure to open anymore, so its data loads once eligibility is known
  // instead of on a toggle event. `loadCollectionsOnce`'s own `collectionsLoaded` guard keeps this to
  // exactly one fetch even though `user` can change reference as auth resolves. G1: a compact mount never
  // renders Options at all, so there is nothing for this list to feed - skip the fetch entirely.
  useEffect(() => {
    if (!compact && user !== null && can(user, "files:write")) loadCollectionsOnce();
  }, [compact, user]);

  // G1: a compact mount has nothing to pick - the destination is fixed, and there is no picker state
  // (destinationCollectionId/newCollectionName) to read at all. Extracted out of startUploads (E6) so
  // every ingest path (drop, picker, paste, folder) resolves the SAME destination the same way, instead of
  // each one re-implementing it.
  async function resolveDestination(token: string | null): Promise<string | null> {
    let destination = fixedCollectionId ?? null;
    if (!compact) {
      // A typed-in new-collection name takes priority over a selected existing one; resolved to an id
      // ONCE per batch, before any file starts, so every dropped file in this batch lands in the same
      // place.
      destination = destinationCollectionId || null;
      if (newCollectionName.trim().length > 0) {
        destination = await createCollection(token, newCollectionName.trim());
        setNewCollectionName("");
      }
    }
    return destination;
  }

  async function startUploads(files: File[], source: IngestSource) {
    if (files.length === 0) return;
    const token = typeof window.mosni !== "undefined" ? window.mosni.token() : null;
    const destination = await resolveDestination(token);
    // web/src/lib/uploads.ts owns the queue, the tus wiring and resumption from here (Wave 0) - this
    // component only ever collects files and hands them off.
    startBatch(files, { destinationCollectionId: destination, source });
  }

  // E6 (E3/F1): shared by the zone's own onDrop and the whole-page window drop handler - branches into the
  // recursive folder walk when the payload contains a real directory entry, otherwise the flat path.
  async function ingestDropped(dataTransfer: DataTransfer, source: IngestSource): Promise<void> {
    if (containsDirectory(dataTransfer)) {
      const items = Array.from(dataTransfer.items ?? []);
      const { files, truncated, rejected } = await walkDroppedEntries(items);
      rejected.forEach((name) => toastError(`Can't upload "${name}" — it's empty.`));
      if (truncated) {
        toastError("This folder is too large — some files were skipped (a depth or file-count limit was hit).");
      }
      const token = typeof window.mosni !== "undefined" ? window.mosni.token() : null;
      const rootDestination = await resolveDestination(token);
      await ingestWalkedFiles(files, token, rootDestination);
      return;
    }

    const { files, rejected } = uploadableFiles(dataTransfer);
    rejected.forEach((name) => toastError(`Can't upload "${name}" — it's empty.`));
    await startUploads(files, source);
  }

  // E6 E4: the folder-picker input's change handler - webkitdirectory gives each File a real
  // webkitRelativePath ("photos/2026/a.jpg"), so this needs no entries-API walk at all, just the same
  // grouping ingestWalkedFiles already does for a folder DROP.
  async function handleFolderInputFiles(fileList: FileList | null): Promise<void> {
    if (!fileList) return;
    const all = Array.from(fileList);
    const walked: WalkedFile[] = [];
    for (const file of all) {
      if (file.size === 0) {
        toastError(`Can't upload "${file.name}" — it's empty.`);
        continue;
      }
      const relativePath = file.webkitRelativePath ? file.webkitRelativePath.split("/") : [file.name];
      walked.push({ file, relativePath });
    }
    if (walked.length === 0) return;
    const token = typeof window.mosni !== "undefined" ? window.mosni.token() : null;
    const rootDestination = await resolveDestination(token);
    await ingestWalkedFiles(walked, token, rootDestination);
  }

  function loadCollectionsOnce() {
    if (collectionsLoaded) return;
    setCollectionsLoaded(true);
    const token = typeof window.mosni !== "undefined" ? window.mosni.token() : null;
    void fetchCollections(token).then(setCollections);
  }

  function handleInputFiles(fileList: FileList | null) {
    if (!fileList) return;
    const all = Array.from(fileList);
    const files = all.filter((f) => f.size > 0);
    all.filter((f) => f.size === 0).forEach((f) => toastError(`Can't upload "${f.name}" — it's empty.`));
    void startUploads(files, "picker");
  }

  if (!authReady) {
    return <span className="spinner" role="status" aria-label="Loading" />;
  }

  // D-120 (E4.1 Wave E findings, finding 5): signed out, this is a DEDICATED login-only panel - Hannah's
  // call, verbatim: "dedicated log in panel that's only for log in, no other text." No heading, no copy,
  // no drop target - the browser below the drop zone (D-93) already shows what the app is for an
  // anonymous visitor, so this panel's only job is to offer sign-in.
  // Landmine: <mosni-login-button /> is the ONLY sign-in affordance in the entire app (verified by grep
  // during E4.1 Wave E findings planning) - this panel may be emptied of copy but must NEVER be removed
  // or replaced with nothing, or an anonymous visitor has no way to sign in at all.
  if (user === null) {
    return (
      <div className="panel">
        <mosni-login-button />
      </div>
    );
  }

  if (!can(user, "files:write")) {
    return (
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>No upload access</h1>
        <p>Your account does not have permission to upload files.</p>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      {dragDepth > 0 && (
        <div
          // pointer-events:none is load-bearing: this overlay must never steal the drop from the zone
          // beneath it - it only ever shows an affordance, the zone below still receives the event.
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            pointerEvents: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "color-mix(in srgb, var(--mosni-purple) 12%, transparent)",
            border: "3px dashed var(--mosni-purple)",
          }}
        >
          {/* E6 F2: reverts to the viewport-wide promise this originally made. Session 013 narrowed it to
              "Drop on the box below" specifically because whole-page drop was scoped out and this copy
              would otherwise have promised something the app silently ignored - F1 makes that promise
              true again (the window-level drop handler now actually ingests). */}
          <span style={{ fontSize: "1.5rem", color: "var(--mosni-white)" }}>Drop anywhere to upload</span>
        </div>
      )}
      {/* D1/D-114: ONE panel for the drop target and its Options - previously two sibling `.panel`s (the
          drop zone and a `<details>`), which read as two equal stacked boxes (defect 11 / H9). */}
      <div className="panel" style={{ display: "grid", gap: "1rem" }}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragEnter={(event) => {
            event.preventDefault();
            setZoneHover(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setZoneHover(true);
          }}
          onDragLeave={() => setZoneHover(false)}
          onDrop={(event) => {
            event.preventDefault();
            // E6 F3: stops this drop from ALSO reaching the window-level whole-page handler below - without
            // it, a drop on the zone would ingest twice (once here, once there).
            event.stopPropagation();
            setZoneHover(false);
            setDragDepth(0);
            void ingestDropped(event.dataTransfer, "drop");
          }}
          // D1: the dashed rectangle is now the drop target's permanent resting state (previously only a
          // hover affordance) - hovering just accents it further, it never starts undecorated. G1: smaller
          // padding in compact mode - a collection page's upload box is a secondary affordance, not `/`'s
          // primary one.
          style={{
            border: "3px dashed var(--mosni-border-muted)",
            borderRadius: "8px",
            padding: compact ? "1.25rem 1rem" : "3rem 1.5rem",
            textAlign: "center",
            cursor: "pointer",
            ...(zoneHover
              ? {
                  borderColor: "var(--mosni-purple)",
                  background: "var(--mosni-surface-input)",
                  transform: "scale(1.01)",
                }
              : undefined),
          }}
        >
          {compact ? "Drop files here" : "Drop files here, or click to choose"}
          <input
            ref={inputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            // input.click() dispatches its own bubbling native click event - without stopping it here,
            // that synthetic click would bubble back up to the wrapping div's onClick and call
            // inputRef.current.click() again, recursing forever. Same fix react-dropzone uses.
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => {
              handleInputFiles(event.target.files);
              // Allow re-selecting the same file again later (browsers don't fire "change" otherwise).
              event.target.value = "";
            }}
          />
          {/* E6 E4: a SECOND picker, folder-only (`webkitdirectory`, set imperatively below since it is
              not a standard JSX/DOM attribute) - deliberately never on the primary input above, which
              would turn click-to-choose folder-only and break D-1's three-action path. */}
          <div style={{ marginTop: "0.5rem" }}>
            <button
              type="button"
              className="btn-tertiary"
              onClick={(event) => {
                event.stopPropagation();
                folderInputRef.current?.click();
              }}
            >
              or choose a folder
            </button>
            <input
              ref={folderInputRef}
              type="file"
              style={{ display: "none" }}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => {
                void handleFolderInputFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </div>
        </div>

        {/* G1 (D-42/D-86, amended by D-114): expanded rather than behind a disclosure - D3's check is
            that this adds no REQUIRED step: a user who ignores it entirely still does exactly
            open → drop → copy, with the default destination unchanged. Does not render at all in compact
            mode (G1) - there is nothing to pick, the destination is fixed. */}
        {!compact && (
          <div style={{ display: "grid", gap: "0.75rem" }}>
            <h2 style={{ margin: 0, fontSize: "1rem" }}>Options</h2>
            <div>
              <label htmlFor="destination-select" style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.35rem", color: "var(--mosni-text-muted)" }}>
                Upload into
              </label>
              <select
                id="destination-select"
                value={destinationCollectionId}
                onChange={(event) => setDestinationCollectionId(event.target.value)}
              >
                <option value="">Default</option>
                {collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="new-collection-name" style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.35rem", color: "var(--mosni-text-muted)" }}>
                Or create a new collection
              </label>
              <input
                id="new-collection-name"
                type="text"
                placeholder="New collection name"
                value={newCollectionName}
                onChange={(event) => setNewCollectionName(event.target.value)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
