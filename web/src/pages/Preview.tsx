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
import { useLocation, useNavigate, useParams } from "react-router";
import type { PreviewContext } from "../../../app/src/lib/previewContext.ts";
import { readEmbeddedTarget, type EmbeddedTarget } from "../lib/previewContext.ts";
import { isPlainLeftClick, pathnameOf } from "../lib/links.ts";
import { PreviewCard } from "../components/PreviewCard.tsx";
import { FileBrowser } from "../components/FileBrowser.tsx";

type ApiTarget = PreviewContext | { kind: "collection"; collectionId: string };

// G1 (E5.1 Wave G, finding 7): built from `ctx.path`/`ctx.previewUrl`/`ctx.ancestors` - all already on the
// context, so no re-derivation and no separate fetch. Reuses FileBrowser's own breadcrumb markup/aria-label
// so the two surfaces match (same "Home" root crumb, same `/` separators).
//
// E7-QA1 §B2.2 (F12): every ancestor is now a REAL `<a href>`, built from the server-sent
// `ctx.ancestors[i].previewUrl` (§A1.5's builder, the same one /api/browse's own breadcrumb uses) - the
// client only ever extracts a pathname out of an already-resolved URL, never assembles one from a bare
// name (D-100 stands). This replaces the plain-text ancestors a prior round deliberately narrowed to,
// because PreviewContext carried no per-ancestor URL at all until §1.2 added `ancestors`.
function Breadcrumb({ ctx }: { ctx: PreviewContext }) {
  const navigate = useNavigate();
  const href = pathnameOf(ctx.previewUrl);

  return (
    <nav aria-label="Breadcrumb" style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", alignItems: "center" }}>
      <a
        href="/"
        onClick={(event) => {
          if (!isPlainLeftClick(event)) return;
          event.preventDefault();
          navigate("/");
        }}
      >
        Home
      </a>
      {ctx.ancestors.map((ancestor) => {
        const ancestorHref = pathnameOf(ancestor.previewUrl);
        return (
          <span key={ancestor.id} style={{ display: "flex", gap: "0.35rem", alignItems: "center" }}>
            <span aria-hidden="true">/</span>
            <a
              href={ancestorHref}
              onClick={(event) => {
                if (!isPlainLeftClick(event)) return;
                event.preventDefault();
                navigate(ancestorHref);
              }}
            >
              {ancestor.name}
            </a>
          </span>
        );
      })}
      <span aria-hidden="true">/</span>
      <a
        href={href}
        aria-current="location"
        onClick={(event) => {
          if (!isPlainLeftClick(event)) return;
          event.preventDefault();
          navigate(href);
        }}
      >
        {ctx.name}
      </a>
    </nav>
  );
}

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
  //
  // D-160 (E5.1 Wave B, finding 3): validity is checked against the server's OWN STAMP
  // (`embedded.embeddedFor`, set by PreviewHead.tsx to the request pathname it actually rendered the
  // document for), never against wherever this component happens to have mounted. The previous version
  // compared against a ref seeded from `location.pathname` at mount time, which is true by construction on
  // every cold mount - so a REMOUNT (e.g. FileBrowser's `key` on a collection change) that inherited stale
  // embedded content from an earlier document painted it as if it were valid for the new URL. Do not bring
  // back a mount-path ref "as a belt and braces" - the moment it disagrees with the server's own stamp is
  // exactly the bug this replaced.
  const embeddedRef = useRef<EmbeddedTarget | null | undefined>(undefined);
  if (embeddedRef.current === undefined) {
    embeddedRef.current = readEmbeddedTarget();
  }

  const [state, setState] = useState<PageState>(() =>
    embeddedRef.current ? stateFromTarget(embeddedRef.current) : { status: "loading" },
  );
  // D-123 (E4.1 live-testing findings, Wave D, finding 3): on a COLD load `window.mosni.token()` returns
  // null before the auth SDK has resolved, so the Bearer re-fetch below used to be skipped outright and
  // isOwner stayed false forever - the protection control was never missing, it was never asked for.
  // Same subscribe() shape as DropZone.tsx: poll until window.mosni exists, then subscribe for good.
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    function subscribe() {
      if (typeof window.mosni === "undefined") {
        pollTimer = setTimeout(subscribe, 50);
        return;
      }
      window.mosni.onChange(() => {
        if (cancelled) return;
        setAuthReady(true);
      });
    }
    subscribe();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const authToken = typeof window.mosni !== "undefined" ? window.mosni.token() : null;
    const apiUrl = `/api/preview${location.pathname}`;
    const embedded = embeddedRef.current;
    const hadEmbedded = embedded !== null && embedded !== undefined && embedded.embeddedFor === location.pathname;

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
    // D-123: authReady is added deliberately - on a cold load the first run of this effect has no token
    // yet (hadEmbedded's guard returns without fetching), and once the SDK resolves this effect must
    // re-run so window.mosni.token() is read again, this time with a real value.
  }, [location.pathname, authReady]);

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

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <Breadcrumb ctx={state.context} />
      <PreviewCard context={state.context} />
    </div>
  );
}
