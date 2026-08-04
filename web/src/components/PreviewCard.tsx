// Wave B1 (E2-UPLOAD-FIXES, finding 6): the ready-state rendering shared between the full Preview page
// and the compact post-upload card - moved out of Preview.tsx verbatim, plus a `compact` variant that
// shrinks media and omits the owner banner (an upload's own drop zone has no reason to tell you that
// you own the file you just uploaded).

import { Component, lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";
import { formatUploadDateTime } from "../../../app/src/lib/previewContext.ts";
import type { Protection } from "../../../app/src/lib/protection.ts";
import { languageFor, TEXT_FULL_MAX_BYTES } from "../../../app/src/lib/textPreview.ts";
import { CopyLink } from "./CopyLink.tsx";
import { IconConfirmCancel, RenameInput } from "./InlineRename.tsx";
import { patchFile, updatedContext } from "../lib/filePatch.ts";
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

  // E5.1 live-testing round 2 (finding: "the rename pencil should be in the title header, not the bottom
  // panel, we do not need to show the file name twice"). Moved here, verbatim, from ManageControls.tsx -
  // the header is now the ONLY place the name renders or is edited; ManageControls keeps protection and
  // delete only.
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(ctx.name);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  function startRename() {
    setName(ctx.name);
    setRenameError(null);
    setEditingName(true);
  }

  function cancelRename() {
    setName(ctx.name);
    setRenameError(null);
    setEditingName(false);
  }

  async function submitRename() {
    if (name === ctx.name || renaming) return;

    setRenaming(true);
    setRenameError(null);
    try {
      const res = await patchFile(ctx.id, { name });
      if (res.status === 409) {
        setRenameError(`"${name}" is already used here - choose another name.`);
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
      setCtx(await updatedContext(res, { ...ctx, name }));
      setEditingName(false);
    } finally {
      setRenaming(false);
    }
  }

  // Broken-image robustness: `ctx.uploaderAvatarUrl` names a proxy URL (`/api/avatar/<file id>`) whose
  // own upstream fetch (auth.mosni.dev, then whatever it redirects to) can fail for reasons this page has
  // no way to predict - a bare <img> with no `onError` handling then shows the browser's broken-image
  // icon, which is worse than showing nothing. Scoped to the specific URL that failed, same pattern as
  // VideoPreview's `erroredUrl` - a stale failure from a PREVIOUS file can never leak onto a new one.
  const [avatarFailedUrl, setAvatarFailedUrl] = useState<string | null>(null);
  const avatarFailed = avatarFailedUrl === ctx.uploaderAvatarUrl;

  return (
    // minmax(0, 1fr): see Preview.tsx - a grid item's automatic minimum size is its content, and a long
    // URL / wide image in a non-shrinking column would push the page wider than the viewport.
    <div style={{ display: "grid", gap: "1.25rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          {editingName ? (
            <>
              <RenameInput
                value={name}
                onChange={setName}
                onSubmit={() => void submitRename()}
                onCancel={cancelRename}
                ariaLabel="File name"
              />
              <IconConfirmCancel
                onConfirm={() => void submitRename()}
                onCancel={cancelRename}
                confirmDisabled={renaming || name === ctx.name}
                confirmLabel="Save name"
                cancelLabel="Cancel rename"
              />
            </>
          ) : (
            <>
              <h1 style={{ margin: 0 }}>{ctx.name}</h1>
              {ctx.isOwner && (
                // D-111: btn-icon, never a bare <button> - mosni-chrome's _button.scss styles the bare
                // `button` element as a filled purple primary with no opt-out.
                <button type="button" className="btn-icon" aria-label="Rename" onClick={startRename}>
                  <mosni-icon name="pencil" size="16" />
                </button>
              )}
            </>
          )}
        </div>
        {renameError !== null && <p role="alert">{renameError}</p>}

        {/* E5.1 live-testing round 2: replaces the old "You own this file (<level>)." text panel with two
            small icon+label badges, directly under the header rather than a separate boxed panel. */}
        {ctx.isOwner && (
          <p
            className="little-link"
            style={{ display: "flex", gap: "0.85rem", margin: "0.35rem 0 0", marginLeft: 0 }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
              <mosni-icon name="user-check" size="14" /> You own this file
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
              <mosni-icon name={PROTECTION_ICON[ctx.protection]} size="14" /> {ctx.protection}
            </span>
          </p>
        )}

        <p className="little-link" style={{ margin: "0.35rem 0 0" }}>
          {ctx.sizeLabel}
          {ctx.width !== null && ctx.height !== null ? ` · ${ctx.width}×${ctx.height}` : ""}
        </p>

        {/* E5.1 live-testing round 2: "uploaded <when> by <who>" replaces the separate uploader-only line -
            the upload date is always known, so it always renders; "by <avatar> <name>" is appended only
            when there is an uploader to show (C1/C4: gated on uploaderAvatarUrl, not uploaderName - a
            captured sub with no name still gets an avatar, just no name text next to it). A failed avatar
            fetch (avatarFailed) drops the image rather than showing a broken-image icon. */}
        <p
          className="little-link"
          style={{ display: "flex", alignItems: "center", gap: "0.35rem", margin: "0.2rem 0 0", marginLeft: 0 }}
        >
          <span>uploaded {formatUploadDateTime(ctx.createdAt)}</span>
          {ctx.uploaderAvatarUrl !== null && (
            <>
              <span>by</span>
              {!avatarFailed && (
                <img
                  src={ctx.uploaderAvatarUrl}
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
