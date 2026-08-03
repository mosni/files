// Wave B1 (E2-UPLOAD-FIXES, finding 6): the ready-state rendering shared between the full Preview page
// and the compact post-upload card - moved out of Preview.tsx verbatim, plus a `compact` variant that
// shrinks media and omits the owner banner (an upload's own drop zone has no reason to tell you that
// you own the file you just uploaded).

import { useEffect, useRef, useState } from "react";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";
import { CopyLink } from "./CopyLink.tsx";
import { ManageControls } from "./ManageControls.tsx";

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
      // Plain <video controls> - not Vidstack, that's E5's (out of scope here).
      return <video src={ctx.directUrl} controls style={FIT} />;
    case "pdf":
      return <iframe src={ctx.directUrl} title={ctx.name} style={FRAME} />;
    case "text":
      // The design system's own code block, not an iframe to dl. (Hannah, session 010). This renders the
      // snippet already captured at ingest into the context (D-74's text_preview), so it costs no extra
      // request and no byte-streaming through Node. Rendering the FULL file - with syntax highlighting and
      // scrolling - remains E5's "text/code preview"; this is the first 400 characters.
      return ctx.textPreview ? (
        <CodeBlock text={ctx.textPreview} />
      ) : (
        <iframe src={ctx.directUrl} title={ctx.name} style={FRAME} />
      );
    default:
      return null;
  }
}

// D-122 (E4.1 live-testing findings, Wave E): the `compact` variant this component once had for the
// upload-completion card is gone - that consumer is UploadStack.tsx now, and this was its only caller.
// This stays the preview PAGE's own renderer (AC6 stands).
export function PreviewCard({ context }: { context: PreviewContext }) {
  // Local, editable copy: ManageControls updates it optimistically on a successful rename/protection
  // change so the page reflects the new state with no extra round trip. Reset whenever the PARENT hands
  // in a genuinely new context (a real navigation, or Preview.tsx's owner-status refetch) rather than one
  // this component produced itself.
  const [ctx, setCtx] = useState(context);
  useEffect(() => setCtx(context), [context]);

  return (
    // minmax(0, 1fr): see Preview.tsx - a grid item's automatic minimum size is its content, and a long
    // URL / wide image in a non-shrinking column would push the page wider than the viewport.
    <div style={{ display: "grid", gap: "1.25rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div>
        <h1 style={{ margin: 0 }}>{ctx.name}</h1>
        <p className="little-link" style={{ margin: "0.25rem 0 0" }}>
          {ctx.sizeLabel}
          {ctx.width !== null && ctx.height !== null ? ` · ${ctx.width}×${ctx.height}` : ""}
        </p>
        {/* D-136: omitted entirely when uploaderName is null - never "Unknown" plus a default avatar for
            every pre-E5 file, and never a fallback to the raw sub. */}
        {ctx.uploaderName !== null && (
          <p style={{ display: "flex", alignItems: "center", gap: "0.4rem", margin: "0.4rem 0 0" }}>
            {ctx.uploaderAvatarUrl !== null && (
              <img
                src={ctx.uploaderAvatarUrl}
                alt=""
                width={20}
                height={20}
                style={{ borderRadius: "50%" }}
              />
            )}
            <span className="little-link">{ctx.uploaderName}</span>
          </p>
        )}
      </div>
      {ctx.isOwner && (
        <div className="panel">
          <p>You own this file ({ctx.protection}).</p>
        </div>
      )}
      {renderMedia(ctx)}
      <CopyLink previewUrl={ctx.previewUrl} directUrl={ctx.directUrl} />
      {ctx.isOwner && <ManageControls context={ctx} onUpdate={setCtx} />}
    </div>
  );
}
