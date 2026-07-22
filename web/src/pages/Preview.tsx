// B2d: the preview page, now a route inside the SPA (D-70) rather than a server-rendered document. The
// server still renders the <head> (rich unfurl block, see app/src/views/PreviewHead.tsx) and embeds the
// file's context as JSON - this component reads that embedded context first (paints on first frame, no
// round trip) and only falls back to the API for a private file or a client-side navigation.

import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";
import { readEmbeddedContext } from "../lib/previewContext.ts";
import { CopyLink } from "../components/CopyLink.tsx";


type PageState =
  | { status: "loading" }
  | { status: "ready"; context: PreviewContext }
  | { status: "not-found" };

// Media has to be told to fit: an <img>/<video> renders at intrinsic size and an <iframe> falls back to
// the browser default 300x150, which is unreadable. These are sizing rules, not theming, so they stay
// inline rather than becoming class names this repo has no stylesheet to back.
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

export function PreviewPage() {
  const location = useLocation();
  // Read the embedded context exactly once, at first render - a ref (not state) so re-renders never
  // re-parse it, and so the effect below can tell "had one at mount" apart from "state is now ready".
  const embeddedRef = useRef<PreviewContext | null | undefined>(undefined);
  // The pathname the embedded context describes. The server embedded it for the document it rendered, so
  // it is only valid for the URL the page arrived at; a client-side navigation to another preview keeps
  // this component (and this ref) mounted, so without remembering the mount path we would go on painting
  // the file we arrived with. Beyond that path the API is the only source (B2d step 2).
  const embeddedPathRef = useRef<string>(location.pathname);
  if (embeddedRef.current === undefined) {
    embeddedRef.current = readEmbeddedContext();
  }

  const [state, setState] = useState<PageState>(() =>
    embeddedRef.current ? { status: "ready", context: embeddedRef.current } : { status: "loading" },
  );

  useEffect(() => {
    let cancelled = false;
    const token = typeof window.mosni !== "undefined" ? window.mosni.token() : null;
    const apiUrl = `/api/preview${location.pathname}`;
    const hadEmbedded = embeddedRef.current !== null && embeddedPathRef.current === location.pathname;

    async function run() {
      if (hadEmbedded) {
        // Embedded context already painted the page. Only worth a round trip if we can present a Bearer
        // (to true up isOwner) - and a failure here must never blank what's already rendered.
        if (!token) return;
        try {
          const res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${token}` } });
          if (cancelled || !res.ok) return;
          const context = (await res.json()) as PreviewContext;
          if (!cancelled) setState({ status: "ready", context });
        } catch {
          // background refresh failed - keep showing the embedded context
        }
        return;
      }

      // No embedded context for THIS path (private file, or a client-side navigation): fetch is required.
      // Drop back to the spinner first - on a navigation the state still holds the previous file, and
      // showing that under the new URL would be worse than showing nothing. A no-op on first mount, where
      // the state is already `loading`.
      setState({ status: "loading" });
      try {
        const res = await fetch(apiUrl, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
        if (cancelled) return;
        if (!res.ok) {
          setState({ status: "not-found" });
          return;
        }
        const context = (await res.json()) as PreviewContext;
        if (!cancelled) setState({ status: "ready", context });
      } catch {
        if (!cancelled) setState({ status: "not-found" });
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  if (state.status === "loading") {
    return <span className="spinner" role="status" aria-label="Loading" />;
  }

  if (state.status === "not-found") {
    return (
      <div className="panel">
        <p>This file doesn&apos;t exist, or you don&apos;t have access to it.</p>
      </div>
    );
  }

  const ctx = state.context;
  return (
    // Vertical rhythm for the page's own sections; the shell supplies the outer container and padding.
    // `minmax(0, 1fr)` rather than a bare 1fr is load-bearing: grid items get an automatic minimum size
    // of their content, so an <img width="1200"> would otherwise force this column - and the whole page -
    // wider than the viewport, which is exactly the horizontal overflow the first pass shipped.
    <div style={{ display: "grid", gap: "1.25rem", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <div>
        <h1 style={{ margin: 0 }}>{ctx.name}</h1>
        <p className="little-link" style={{ margin: "0.25rem 0 0" }}>
          {ctx.sizeLabel}
          {ctx.width !== null && ctx.height !== null ? ` · ${ctx.width}×${ctx.height}` : ""}
        </p>
      </div>
      {ctx.isOwner && (
        <div className="panel">
          <p>You own this file ({ctx.protection}).</p>
        </div>
      )}
      {renderMedia(ctx)}
      <CopyLink previewUrl={ctx.previewUrl} directUrl={ctx.directUrl} />
    </div>
  );
}
