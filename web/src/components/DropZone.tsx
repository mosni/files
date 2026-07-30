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
import * as tus from "tus-js-client";
import { can, type Claims } from "../../../app/src/lib/roles.ts";
import { UPLOAD_CHUNK_SIZE } from "../../../app/src/lib/uploadConfig.ts";
import { toastMutationFailure } from "../lib/mutationError.ts";
import { fetchCollections, type CollectionOption } from "../lib/collections.ts";
import { UploadStack, type FileUpload, type UploadState } from "./UploadStack.tsx";

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

let nextUploadId = 0;

function toastError(message: string): void {
  if (typeof window.mosni !== "undefined" && window.mosni.toast) {
    window.mosni.toast(message, { variant: "error" });
  }
}

// A dropped folder appears in dataTransfer.files as a 0-byte File. tus would POST it as a
// create-with-upload that completes on create (length 0) → the server answers 200 + JSON with NO
// Location header → tus-js-client errors and RETRIES (default [0,1000,3000,5000] = 5 attempts), each
// attempt creating another collision-suffixed 0-byte file and firing an audit notification (the storm
// Hannah saw). Real folder upload is E6. The size===0 guard is load-bearing (it stops the storm for
// folders AND genuinely empty files, which hit the identical tus edge); webkitGetAsEntry only sharpens
// the message to "folder" where the browser exposes it.
function uploadableFiles(dataTransfer: DataTransfer): { files: File[]; rejected: string[] } {
  const dirNames = new Set<string>();
  const items = dataTransfer.items;
  if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === "function") {
    for (const item of Array.from(items)) {
      const entry = item.webkitGetAsEntry?.();
      if (entry && entry.isDirectory) dirNames.add(entry.name);
    }
  }
  const files: File[] = [];
  const rejected: string[] = [];
  for (const file of Array.from(dataTransfer.files)) {
    if (file.size === 0 || dirNames.has(file.name)) rejected.push(file.name);
    else files.push(file);
  }
  return { files, rejected };
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

function startUpload(
  file: File,
  token: string | null,
  chunkSize: number,
  destinationCollectionId: string | null,
  onUpdate: (state: UploadState) => void,
) {
  const upload = new tus.Upload(file, {
    endpoint: "/api/upload",
    chunkSize,
    metadata: {
      filename: file.name,
      ...(destinationCollectionId ? { destinationCollectionId } : {}),
    },
    headers: { Authorization: `Bearer ${token ?? ""}` },
    onProgress: (bytesSent, bytesTotal) => {
      onUpdate({ status: "uploading", progress: Math.round((bytesSent / bytesTotal) * 100), loaded: bytesSent, total: bytesTotal });
    },
    onSuccess: (payload) => {
      // The server deliberately overrides tus's usual 204 with a 200 + JSON body on the completing
      // request (a 204 can't carry one) - lastResponse.getBody() is that JSON, as a string. Guarded:
      // an unreadable body must land the row in `error`, not leave it stuck on `uploading` forever
      // while the file is already stored server-side (finding 5 hardening).
      try {
        const { previewUrl, directUrl } = JSON.parse(payload.lastResponse.getBody()) as {
          previewUrl: string;
          directUrl?: string;
        };
        onUpdate({ status: "done", previewUrl, directUrl });
      } catch {
        onUpdate({ status: "error", message: "upload finished but the server response was unreadable" });
      }
    },
    onError: (error) => {
      onUpdate({ status: "error", message: error.message });
    },
  });
  upload.start();
}

// D-129 (E4.1 live-testing findings, Wave G): a compact, fixed-destination mode for a collection page's
// own upload box (finding 11) - reuses this component rather than building a second control (Q5). In
// compact mode the Options block does not render at all (there is nothing to pick: the destination is
// fixed), and startUploads uploads straight into `fixedCollectionId`, skipping the destination-picker
// state and the createCollection step entirely. Everything else - drag handling, the folder/empty-file
// guard, the upload machinery, the floating stack - is shared, unchanged.
export function DropZone({
  compact = false,
  fixedCollectionId,
  onUploadComplete,
}: { compact?: boolean; fixedCollectionId?: string; onUploadComplete?: () => void } = {}) {
  const [user, setUser] = useState<MosniUser>(null);
  const [authReady, setAuthReady] = useState(false);
  const [uploads, setUploads] = useState<FileUpload[]>([]);
  // Server-authoritative chunk size (P10): the shared constant is the compile-time fallback, but the
  // running server is the source of truth so the client and the server's rate-limit budget cannot drift.
  const [chunkSize, setChunkSize] = useState(UPLOAD_CHUNK_SIZE);
  const inputRef = useRef<HTMLInputElement>(null);
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
    const onWindowDrop = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
      setDragDepth(0);
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
        if (!cancelled && cfg && typeof cfg.uploadChunkSize === "number") setChunkSize(cfg.uploadChunkSize);
      })
      .catch(() => {}); // unreachable /api/config just means we keep the fallback - never blocks uploads
    return () => {
      cancelled = true;
    };
  }, []);

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

  function updateUpload(id: string, state: UploadState) {
    setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, state } : u)));
    // G2: a collection-page mount reloads its FileBrowser listing on completion, so the new file appears
    // with no page refresh. A no-op for the root-mounted `/` drop zone, which has no listing to refresh.
    if (state.status === "done") onUploadComplete?.();
  }

  async function startUploads(files: File[]) {
    if (files.length === 0) return;
    const token = typeof window.mosni !== "undefined" ? window.mosni.token() : null;

    // G1: a compact mount has nothing to pick - the destination is fixed, and there is no picker state
    // (destinationCollectionId/newCollectionName) to read at all.
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

    // Each file gets its own tus.Upload and its own row - multi-file grouping into a single shared link
    // is a later epic (E6), not this one.
    files.forEach((file) => {
      const id = `upload-${nextUploadId++}`;
      setUploads((prev) => [
        ...prev,
        { id, name: file.name, state: { status: "uploading", progress: 0, loaded: 0, total: file.size } },
      ]);
      startUpload(file, token, chunkSize, destination, (state) => {
        updateUpload(id, state);
      });
    });
  }

  function dismissUpload(id: string) {
    setUploads((prev) => prev.filter((u) => u.id !== id));
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
    void startUploads(files);
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
          {/* The zone is still the only drop target (the hand-off scoped whole-page drop out, and E6 owns
              it). A viewport-wide "Drop to upload" therefore promised something a drop on the header or
              the margins does not honour - it silently does nothing. The copy points at the zone instead,
              which the overlay's own translucency leaves highlighted underneath. */}
          <span style={{ fontSize: "1.5rem", color: "var(--mosni-white)" }}>Drop on the box below to upload</span>
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
            setZoneHover(false);
            setDragDepth(0);
            const { files, rejected } = uploadableFiles(event.dataTransfer);
            rejected.forEach((name) =>
              toastError(`Can't upload "${name}" — folders and empty files aren't supported yet.`),
            );
            void startUploads(files);
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

      {/* D-122 (E4.1 live-testing findings, Wave E, findings 1/2): upload progress/completion is a
          floating bottom-right stack, not inline panels - one element per file, staying until dismissed
          or its "view" link is clicked. */}
      <UploadStack uploads={uploads} onDismiss={dismissUpload} />
    </div>
  );
}
