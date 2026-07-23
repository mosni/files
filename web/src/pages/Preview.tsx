// B2d: the preview page, now a route inside the SPA (D-70) rather than a server-rendered document. The
// server still renders the <head> (rich unfurl block, see app/src/views/PreviewHead.tsx) and embeds the
// file's context as JSON - this component reads that embedded context first (paints on first frame, no
// round trip) and only falls back to the API for a private file or a client-side navigation.

import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";
import { readEmbeddedContext } from "../lib/previewContext.ts";
import { PreviewCard } from "../components/PreviewCard.tsx";

type PageState =
  | { status: "loading" }
  | { status: "ready"; context: PreviewContext }
  | { status: "not-found" };

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

  return <PreviewCard context={state.context} />;
}
