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
        />
      );
    case "video":
      // Plain <video controls> - not Vidstack, that's E5's (out of scope here).
      return <video src={ctx.directUrl} controls />;
    case "pdf":
    case "text":
      return <iframe src={ctx.directUrl} title={ctx.name} />;
    default:
      return null;
  }
}

export function PreviewPage() {
  const location = useLocation();
  // Read the embedded context exactly once, at first render - a ref (not state) so re-renders never
  // re-parse it, and so the effect below can tell "had one at mount" apart from "state is now ready".
  const embeddedRef = useRef<PreviewContext | null | undefined>(undefined);
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
    const hadEmbedded = embeddedRef.current !== null;

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

      // No embedded context (private file, or a client-side navigation): fetch is required.
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
    <div>
      <h1>{ctx.name}</h1>
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
