// B2d: the preview page, now a route inside the SPA (D-70) rather than a server-rendered document. The
// server still renders the <head> (rich unfurl block, see app/src/views/PreviewHead.tsx) and embeds the
// target's context as JSON - this component reads that embedded target first (paints on first frame, no
// round trip) and only falls back to the API for a private file, an authorized-but-not-owner collection,
// or a client-side navigation.
//
// E4.1 Wave C (D-107 client half): `/f/*` and `/t/:token` resolve to EITHER a file or a collection (Wave
// A's server-side resolution) - this component reads the server's own answer (the embedded target's
// `kind`, or the API's) and mounts <PreviewCard> or <FileBrowser> accordingly. It never infers the target
// kind from the URL shape itself.

import { useEffect, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";
import { readEmbeddedTarget, type EmbeddedTarget } from "../lib/previewContext.ts";
import { PreviewCard } from "../components/PreviewCard.tsx";
import { FileBrowser } from "../components/FileBrowser.tsx";

type ApiTarget = PreviewContext | { kind: "collection"; collectionId: string };

type PageState =
  | { status: "loading" }
  | { status: "file"; context: PreviewContext }
  | { status: "collection"; collectionId: string }
  | { status: "not-found" };

function stateFromTarget(target: EmbeddedTarget | ApiTarget): PageState {
  // NOT a `"collectionId" in target` check - PreviewContext ALSO carries a `collectionId` (the file's own
  // PARENT collection), which is a completely different thing from "this response IS a collection". Only
  // `kind === "collection"` (the discriminator CollectionLocation was deliberately given, so it can never
  // collide with PreviewContext's own `kind`, always a PreviewKind) is safe to branch on.
  if (target.kind === "collection") return { status: "collection", collectionId: target.collectionId };
  const context = "context" in target ? target.context : target;
  return { status: "file", context };
}

export function PreviewPage() {
  const location = useLocation();
  const { token } = useParams<{ token?: string }>();
  // Read the embedded target exactly once, at first render - a ref (not state) so re-renders never
  // re-parse it, and so the effect below can tell "had one at mount" apart from "state is now ready".
  const embeddedRef = useRef<EmbeddedTarget | null | undefined>(undefined);
  // The pathname the embedded target describes. The server embedded it for the document it rendered, so
  // it is only valid for the URL the page arrived at; a client-side navigation to another target keeps
  // this component (and this ref) mounted, so without remembering the mount path we would go on painting
  // whatever we arrived with. Beyond that path the API is the only source (B2d step 2).
  const embeddedPathRef = useRef<string>(location.pathname);
  if (embeddedRef.current === undefined) {
    embeddedRef.current = readEmbeddedTarget();
  }

  const [state, setState] = useState<PageState>(() =>
    embeddedRef.current ? stateFromTarget(embeddedRef.current) : { status: "loading" },
  );

  useEffect(() => {
    let cancelled = false;
    const authToken = typeof window.mosni !== "undefined" ? window.mosni.token() : null;
    const apiUrl = `/api/preview${location.pathname}`;
    const embedded = embeddedRef.current;
    const hadEmbedded = embedded !== null && embeddedPathRef.current === location.pathname;

    async function run() {
      if (hadEmbedded) {
        // Embedded target already painted the page. A collection has nothing more to refresh in the
        // background (no isOwner-style concept the way a file's context has) - only a file is worth a
        // Bearer-authenticated re-fetch, and a failure here must never blank what's already rendered.
        if (embedded === null || embedded === undefined || embedded.kind !== "file" || !authToken) return;
        try {
          const res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${authToken}` } });
          if (cancelled || !res.ok) return;
          const target = (await res.json()) as ApiTarget;
          if (!cancelled) setState(stateFromTarget(target));
        } catch {
          // background refresh failed - keep showing the embedded content
        }
        return;
      }

      // No embedded target for THIS path (private file, non-public collection, or a client-side
      // navigation): fetch is required. Drop back to the spinner first - on a navigation the state still
      // holds the previous target, and showing that under the new URL would be worse than showing
      // nothing. A no-op on first mount, where the state is already `loading`.
      setState({ status: "loading" });
      try {
        const res = await fetch(apiUrl, authToken ? { headers: { Authorization: `Bearer ${authToken}` } } : undefined);
        if (cancelled) return;
        if (!res.ok) {
          setState({ status: "not-found" });
          return;
        }
        const target = (await res.json()) as ApiTarget;
        if (!cancelled) setState(stateFromTarget(target));
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

  if (state.status === "collection") {
    // `key` forces a fresh FileBrowser (fresh internal state) whenever the RESOLVED collection changes -
    // e.g. a back/forward navigation this effect re-resolved to a different id. `token` is only ever
    // meaningful for the /t/:token route shape; a /f/* collection never needs it (D-98's bypass is
    // specifically for the cases a readable path can't reach).
    return <FileBrowser key={state.collectionId} initialCollectionId={state.collectionId} initialToken={token} />;
  }

  return <PreviewCard context={state.context} />;
}
