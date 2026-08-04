// Wave B1 (E2-UPLOAD-FIXES, finding 6): the ready-state rendering shared between the full Preview page
// and the compact post-upload card - moved out of Preview.tsx verbatim, plus a `compact` variant that
// shrinks media and omits the owner banner (an upload's own drop zone has no reason to tell you that
// you own the file you just uploaded).

import { Component, lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";
import { formatUploadDateTimeLocal } from "../../../app/src/lib/previewContext.ts";
import type { Protection } from "../../../app/src/lib/protection.ts";
import { languageFor, TEXT_FULL_MAX_BYTES } from "../../../app/src/lib/textPreview.ts";
import { CopyLink } from "./CopyLink.tsx";
import { IconConfirmCancel } from "./InlineRename.tsx";
import { authHeaders, patchFile, updatedContext } from "../lib/filePatch.ts";
import { ManageControls } from "./ManageControls.tsx";
import { DownloadFallback } from "./VideoPreview.tsx";

// E5 Wave F: lazy, not a static import. Vidstack (VideoPreview.tsx's own dependency) is genuinely heavy
// (~350KB) - a static import here would pull it into the SAME bundle main.tsx loads for `/`, the drop
// zone, on EVERY visit (confirmed empirically: it appeared as a blocking `modulepreload`/stylesheet in
// index.html, D-1's fast path paying for a player nothing on that page ever renders). `React.lazy` makes
// this a genuine separate chunk, fetched only when a video is actually being previewed.
const VideoPreview = lazy(() => import("./VideoPreview.tsx").then((m) => ({ default: m.VideoPreview })));

// D6 (E5.1 Wave D, D-166): found while investigating finding 5 - aborting the lazy chunk's asset request
// leaves only the site header rendered, because `React.lazy()`'s rejection propagates with NO error
// boundary of its own, unmounting the entire preview. A transient network/CDN failure on one lazy asset
// must cost the video, not the page - class component because React has no hook form of
// getDerivedStateFromError. Scoped tightly around just the video branch, one level up from `Suspense`.
class VideoErrorBoundary extends Component<{ directUrl: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) return <DownloadFallback directUrl={this.props.directUrl} />;
    return this.props.children;
  }
}

const FIT: React.CSSProperties = { maxWidth: "100%", height: "auto", display: "block" };
const FRAME: React.CSSProperties = { width: "100%", height: "min(70vh, 640px)", border: 0, display: "block" };

// E5.1 live-testing round 4 ("the spacings seem slightly inconsistent"): the header's stacked meta lines
// (ownership/protection badges, size, uploaded-by) all use ONE vertical rhythm, and every inline icon+label
// pair inside them uses ONE gap - previously these were several close-but-different ad hoc rem values.
const STACK_GAP = "0.35rem";
const INLINE_ICON_GAP = "0.35rem";

// Wrapper glue for <mosni-code> (the friction D-8 predicted for React + custom elements). The element's
// render() reads this.textContent and then WIPES its own children to rebuild them - so it must already
// contain its text at the moment it enters the document. React inserts an element and appends children
// after, which means a JSX <mosni-code><pre>…</pre></mosni-code> upgrades while empty and renders an
// empty block. Creating it imperatively with textContent already set fixes both halves: the content is
// there on connect, and React never owns children the element intends to destroy.
function CodeBlock({ text, language }: { text: string; language?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const el = document.createElement("mosni-code");
    if (language !== undefined) el.setAttribute("language", language);
    el.textContent = text;
    host.replaceChildren(el);
    return () => host.replaceChildren();
  }, [text, language]);
  return <div ref={hostRef} />;
}

// E5 Wave E (D-141): full text/code preview, capped at TEXT_FULL_MAX_BYTES. Above the cap, rendering the
// whole file through Prism risks locking the tab - the snippet already captured at ingest plus a download
// action stays the answer there. Below the cap, this fetches the full file from `directUrl` (cross-origin
// to dl., which is why this depends on Wave D's CORS/connect-src) and swaps it in once loaded - while
// fetching, the ingest snippet (if any) keeps the block non-empty rather than showing nothing.
function TextPreview({ ctx }: { ctx: PreviewContext }) {
  const withinCap = ctx.bytes <= TEXT_FULL_MAX_BYTES;
  const [fullText, setFullText] = useState<string | null>(null);

  useEffect(() => {
    setFullText(null);
    if (!withinCap) return;
    let cancelled = false;
    fetch(ctx.directUrl)
      .then((res) => (res.ok ? res.text() : null))
      .then((text) => {
        if (!cancelled) setFullText(text);
      })
      .catch(() => {
        // Network failure - keep showing the ingest snippet (or nothing, for a file that has none).
      });
    return () => {
      cancelled = true;
    };
  }, [ctx.directUrl, withinCap]);

  const language = languageFor(ctx.name) ?? undefined;

  if (!withinCap) {
    return (
      <div className="panel" style={{ display: "grid", gap: "0.75rem" }}>
        {ctx.textPreview !== null && <CodeBlock text={ctx.textPreview} language={language} />}
        <a className="btn" href={ctx.directUrl}>
          Download to view in full
        </a>
      </div>
    );
  }

  return <CodeBlock text={fullText ?? ctx.textPreview ?? ""} language={language} />;
}

function renderMedia(ctx: PreviewContext) {
  // "other", or an explicitly non-inline type (e.g. a disallowed extension): the download card.
  if (ctx.kind === "other" || !ctx.inline) {
    return (
      <div className="panel">
        <p>This file type does not preview inline</p>
        <a className="btn" href={ctx.directUrl}>
          Download
        </a>
      </div>
    );
  }

  switch (ctx.kind) {
    case "image":
      return (
        <img
          src={ctx.directUrl}
          alt={ctx.name}
          width={ctx.width ?? undefined}
          height={ctx.height ?? undefined}
          style={FIT}
        />
      );
    case "video":
      // E5 Wave F: the Vidstack player, with a runtime capability fallback (D-144) - see VideoPreview.tsx.
      // Suspense's fallback covers only the brief gap while the lazy chunk fetches; VideoPreview's own
      // internal states (checking/confirmed/fallback, D2) take over immediately once it's loaded. D6: the
      // error boundary sits OUTSIDE Suspense - it exists to catch the lazy import failing, not anything
      // VideoPreview itself already handles once loaded (that stays D2's job, not this boundary's).
      return (
        <VideoErrorBoundary directUrl={ctx.directUrl}>
          <Suspense fallback={<span className="spinner" role="status" aria-label="Loading player" />}>
            <VideoPreview ctx={ctx} />
          </Suspense>
        </VideoErrorBoundary>
      );
    case "pdf":
      return <iframe src={ctx.directUrl} title={ctx.name} style={FRAME} />;
    case "text":
      // E5 Wave E (D-141): full text/code preview via TextPreview, capped at TEXT_FULL_MAX_BYTES - see its
      // own comment. The design system's own code block, not an iframe to dl. (Hannah, session 010).
      return <TextPreview ctx={ctx} />;
    default:
      return null;
  }
}

// E5.1 live-testing round 2: an icon + short label for each protection level, replacing the old
// "You own this file (<level>)." text panel - shown next to the ownership badge, both above the media, so
// the level is visible without opening ManageControls' selector. Names are lucide icons resolved by
// `<mosni-icon>` (mosni-chrome's icons-all registry, "pick any lucide icon by name" - no registry change
// needed). Kept local to this file rather than exported: ProtectionControl.tsx's own consumers (the
// compact upload box, FileBrowser's per-row picker) show/change the level via its `<select>`, which needs
// no icon of its own.
const PROTECTION_ICON: Record<Protection, string> = {
  public: "globe",
  unlisted: "eye-off",
  secret: "key",
  private: "lock",
};

// D-122 (E4.1 live-testing findings, Wave E): the `compact` variant this component once had for the
// upload-completion card is gone - that consumer is UploadStack.tsx now, and this was its only caller.
// This stays the preview PAGE's own renderer (AC6 stands).
export function PreviewCard({ context }: { context: PreviewContext }) {
  // Local, editable copy: rename/ManageControls update it optimistically on a successful mutation so the
  // page reflects the new state with no extra round trip. Reset whenever the PARENT hands in a genuinely
  // new context (a real navigation, or Preview.tsx's owner-status refetch) rather than one this component
  // produced itself.
  const [ctx, setCtx] = useState(context);
  useEffect(() => setCtx(context), [context]);

  // E5.1 live-testing round 2: rename AND delete both live in the header now ("the rename pencil should
  // be in the title header, not the bottom panel" + "move trash next to pencil"), as mutually exclusive
  // MODES rather than two independent booleans that could theoretically both be true at once. Rename's
  // own logic moved here, verbatim in spirit, from ManageControls.tsx - the header is now the ONLY place
  // the name renders or is edited; ManageControls keeps protection only.
  const [headerMode, setHeaderMode] = useState<"view" | "renaming" | "deleting">("view");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // "make the existing title editable without turning it into an input" - the <h1> itself becomes
  // `contentEditable` rather than being swapped for a separate <input>. Uncontrolled deliberately: the
  // JSX children below stay the literal `{ctx.name}` throughout an edit session (never re-derived from
  // `currentText`), so React's reconciler sees no diff on any OTHER state change (renameError, `renaming`)
  // during editing and never touches the live DOM text - which is what keeps the caret in place. Only
  // `currentText` (read via onInput) tracks what the user has actually typed, purely to drive the
  // Save button's disabled state the same way the old controlled `name` state did.
  const nameRef = useRef<HTMLHeadingElement>(null);
  const [currentText, setCurrentText] = useState(ctx.name);

  function startRename() {
    setRenameError(null);
    setCurrentText(ctx.name);
    setHeaderMode("renaming");
  }

  function cancelRename() {
    setRenameError(null);
    setHeaderMode("view");
    // Discard whatever the user typed - the DOM text was live-edited by contentEditable, and React will
    // not correct it back on its own since `{ctx.name}` (the JSX children) never changed.
    if (nameRef.current !== null) nameRef.current.textContent = ctx.name;
  }

  async function submitRename() {
    const newName = (nameRef.current?.textContent ?? "").trim();
    if (newName === ctx.name || renaming) return;

    setRenaming(true);
    setRenameError(null);
    try {
      const res = await patchFile(ctx.id, { name: newName });
      if (res.status === 409) {
        setRenameError(`"${newName}" is already used here - choose another name.`);
        return;
      }
      // The server validates a display name exactly as it validates an uploaded filename (it becomes a
      // URL segment), so say which shapes are rejected rather than the generic failure.
      if (res.status === 400) {
        setRenameError("That name can't be used - no slashes, and no leading or trailing spaces.");
        return;
      }
      if (!res.ok) {
        setRenameError("Rename failed.");
        return;
      }
      setCtx(await updatedContext(res, { ...ctx, name: newName }));
      setHeaderMode("view");
    } finally {
      setRenaming(false);
    }
  }

  // Focuses the title and selects its full text the moment editing starts - the same affordance
  // `autoFocus` gave the old <input>.
  useEffect(() => {
    if (headerMode !== "renaming") return;
    const el = nameRef.current;
    if (el === null) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [headerMode]);

  function startDelete() {
    setHeaderMode("deleting");
  }

  function cancelDelete() {
    setHeaderMode("view");
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/files/${ctx.id}`, { method: "DELETE", headers: authHeaders() });
      if (res.ok) {
        window.location.assign("/");
      }
    } finally {
      setDeleting(false);
    }
  }

  // Broken-image robustness: since D-169 `ctx.uploaderAvatarUrl` points straight at
  // `auth.mosni.dev/avatar/<sub>` (the files.-side `/api/avatar` proxy this comment used to describe is
  // deleted), so the load can still fail for reasons this page has no way to predict - a cross-origin
  // request, whatever auth redirects it to, and this app's own img-src policy. A bare <img> with no
  // `onError` handling then shows the browser's broken-image icon, which is worse than showing nothing. Scoped to the specific URL that failed, same pattern as
  // VideoPreview's `erroredUrl` - a stale failure from a PREVIOUS file can never leak onto a new one.
  const [avatarFailedUrl, setAvatarFailedUrl] = useState<string | null>(null);
  const avatarFailed = avatarFailedUrl === ctx.uploaderAvatarUrl;
  const hasAvatarUrl = ctx.uploaderAvatarUrl !== null;
  const showAvatar = hasAvatarUrl && !avatarFailed;
  // C1/C4: gated on there being an avatar URL AT ALL - never falls back to showing just a name when
  // uploaderAvatarUrl is null (that state should not happen per previewContext.ts's own contract, but
  // this component must not assume it, same as the C1 test that predates this line). Within that, the
  // "by <avatar> <name>" segment must never render with nothing after "by" - a captured avatar URL that
  // then fails to LOAD client-side (found live: the proxy 404s) is exactly as empty as no uploader at all
  // once there is also no name to fall back to.
  const showByLine = hasAvatarUrl && (showAvatar || ctx.uploaderName !== null);

  return (
    // minmax(0, 1fr): see Preview.tsx - a grid item's automatic minimum size is its content, and a long
    // URL / wide image in a non-shrinking column would push the page wider than the viewport.
    <div style={{ display: "grid", gap: "1.25rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          <h1
            ref={nameRef}
            contentEditable={headerMode === "renaming"}
            suppressContentEditableWarning
            role={headerMode === "renaming" ? "textbox" : undefined}
            aria-label={headerMode === "renaming" ? "File name" : undefined}
            style={{
              margin: 0,
              ...(headerMode === "renaming"
                ? { outline: "1px dashed var(--mosni-purple, #996bef)", borderRadius: "4px", padding: "0 0.25rem" }
                : {}),
            }}
            onInput={(event) => setCurrentText(event.currentTarget.textContent ?? "")}
            onKeyDown={(event) => {
              if (headerMode !== "renaming") return;
              if (event.key === "Enter") {
                event.preventDefault();
                void submitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelRename();
              }
            }}
            onPaste={(event) => {
              if (headerMode !== "renaming") return;
              // Plain text only - contentEditable otherwise pastes rich HTML into a title.
              event.preventDefault();
              document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
            }}
          >
            {ctx.name}
          </h1>
          {ctx.isOwner && headerMode === "view" && (
            // D-111: btn-icon, never a bare <button> - mosni-chrome's _button.scss styles the bare
            // `button` element as a filled purple primary with no opt-out.
            <>
              <button type="button" className="btn-icon" aria-label="Rename" onClick={startRename}>
                <mosni-icon name="pencil" size="16" />
              </button>
              <button type="button" className="btn-icon" aria-label="Delete file" onClick={startDelete}>
                <mosni-icon name="trash-2" size="16" />
              </button>
            </>
          )}
          {headerMode === "renaming" && (
            <IconConfirmCancel
              onConfirm={() => void submitRename()}
              onCancel={cancelRename}
              confirmDisabled={renaming || currentText.trim() === ctx.name}
              confirmLabel="Save name"
              cancelLabel="Cancel rename"
            />
          )}
          {headerMode === "deleting" && (
            <>
              <span className="little-link" style={{ marginLeft: 0 }}>
                Delete permanently?
              </span>
              <IconConfirmCancel
                onConfirm={() => void confirmDelete()}
                onCancel={cancelDelete}
                confirmDisabled={deleting}
                confirmLabel="Yes, delete"
                cancelLabel="Cancel delete"
              />
            </>
          )}
        </div>
        {renameError !== null && <p role="alert">{renameError}</p>}

        {/* E5.1 live-testing round 2: replaces the old "You own this file (<level>)." text panel with two
            small icon+label badges, directly under the header rather than a separate boxed panel. */}
        {ctx.isOwner && (
          <p
            className="little-link"
            style={{ display: "flex", gap: STACK_GAP, margin: `${STACK_GAP} 0 0`, marginLeft: 0 }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: INLINE_ICON_GAP }}>
              <mosni-icon name="user-check" size="14" /> You own this file
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: INLINE_ICON_GAP }}>
              <mosni-icon name={PROTECTION_ICON[ctx.protection]} size="14" /> {ctx.protection}
            </span>
          </p>
        )}

        <p className="little-link" style={{ margin: `${STACK_GAP} 0 0` }}>
          {ctx.sizeLabel}
          {ctx.width !== null && ctx.height !== null ? ` · ${ctx.width}×${ctx.height}` : ""}
        </p>

        {/* E5.1 live-testing round 2: "uploaded <when> by <who>" replaces the separate uploader-only line -
            the upload date is always known, so it always renders in the viewer's own LOCAL time (Hannah's
            call). "by <avatar> <name>" is appended only when there is something to actually show there -
            gating on uploaderAvatarUrl alone (C1/C4's usual rule) left a dangling "by" with nothing after
            it once the avatar image itself failed to load (found live) and no name was captured either;
            showAvatar/showByLine below fold the CLIENT-side load failure into the same gate. */}
        <p
          className="little-link"
          style={{ display: "flex", alignItems: "center", gap: INLINE_ICON_GAP, margin: `${STACK_GAP} 0 0`, marginLeft: 0 }}
        >
          <span>uploaded {formatUploadDateTimeLocal(ctx.createdAt)}</span>
          {showByLine && (
            <>
              <span>by</span>
              {showAvatar && (
                <img
                  src={ctx.uploaderAvatarUrl!}
                  alt=""
                  width={20}
                  height={20}
                  style={{ borderRadius: "50%" }}
                  onError={() => setAvatarFailedUrl(ctx.uploaderAvatarUrl)}
                />
              )}
              {ctx.uploaderName !== null && <span>{ctx.uploaderName}</span>}
            </>
          )}
        </p>
      </div>
      {renderMedia(ctx)}
      <CopyLink previewUrl={ctx.previewUrl} directUrl={ctx.directUrl} />
      {ctx.isOwner && <ManageControls context={ctx} onUpdate={setCtx} />}
    </div>
  );
}
