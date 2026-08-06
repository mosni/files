// E6 Wave G6 (D-178), rewritten 2026-08-06 after Hannah shared into the installed PWA and nothing
// uploaded: "the user is not logged in upon first load of the pwa".
//
// The original version ran at module scope and acted on the auth SDK's FIRST answer, which on a cold PWA
// start is always `null` - and then made that unrecoverable. The SDK keeps its token in **sessionStorage**,
// which a freshly-launched PWA does not have, so it reports "signed out", fires one hidden same-site
// `prompt=none` check (mosni/auth's D-100), and notifies again with the real user a moment later. Acting on
// the first answer meant:
//   - the tus create POST went out with an empty bearer -> 401, and `onShouldRetry` treats a settled 4xx as
//     final, so it never retried once the session did arrive;
//   - the IndexedDB entry had already been CLAIMED, and a claim deletes it - so the shared bytes were gone;
//   - `?share-target=<id>` had already been stripped from the URL, so neither a reload nor a sign-in
//     round-trip could ever pick the share back up.
// Three separate ways to lose the user's file, all before the session had had a chance to resolve.
//
// So: claim nothing and strip nothing until someone who can actually upload is present. Everything stays
// recoverable in the meantime - the entry lives in IndexedDB and the id lives in the URL, so signing in
// (a top-level redirect that returns to this exact URL) resumes the share instead of losing it.
import { can, type Claims } from "../../../app/src/lib/roles.ts";
import { startBatch } from "./uploads.ts";

const CLAIM_TIMEOUT_MS = 10_000;

/** Calls `cb` once, as soon as the auth SDK reports a user who may upload. Never calls it otherwise -
 *  the page's own login panel is what moves that along, and the share survives the round-trip. */
function whenSignedInWithWriteAccess(cb: () => void): void {
  let fired = false;
  const subscribe = () => {
    // The SDK's <script> tag loads independently of this module - never assume window.mosni exists yet.
    // Same poll DropZone.tsx uses, and for the same reason.
    if (typeof window.mosni === "undefined") {
      setTimeout(subscribe, 50);
      return;
    }
    window.mosni.onChange((user: Claims | null) => {
      if (fired || user === null || !can(user, "files:write")) return;
      fired = true;
      cb();
    });
  };
  subscribe();
}

/** Ask the service worker for the files it stashed for `id`. It deletes them in the same transaction, so
 *  this is a one-shot: only call it when the page can actually act on what comes back. */
async function claimFiles(id: string): Promise<File[]> {
  if (!("serviceWorker" in navigator)) return [];
  // `navigator.serviceWorker.controller` is null until a worker has taken control, which on a cold start
  // is a race the original code lost silently; `ready` resolves once there is an active registration.
  const registration = await navigator.serviceWorker.ready;
  const worker = navigator.serviceWorker.controller ?? registration.active;
  if (worker === null) return [];

  return await new Promise<File[]>((resolve) => {
    const finish = (files: File[]) => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("message", onMessage);
      resolve(files);
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; id?: unknown; files?: unknown } | null;
      if (data === null || data.type !== "share-target-files" || data.id !== id) return;
      finish(Array.isArray(data.files) ? data.files.filter((f): f is File => f instanceof File) : []);
    };
    // A worker that never answers must not leave the share-target parameter stuck in the URL forever.
    const timer = setTimeout(() => finish([]), CLAIM_TIMEOUT_MS);
    navigator.serviceWorker.addEventListener("message", onMessage);
    worker.postMessage({ type: "share-target-claim", id });
  });
}

/** Wire up the Android share-target handoff for this page load. Safe to call unconditionally: it returns
 *  immediately when the URL carries no `?share-target=<id>`. */
export function initShareTarget(): void {
  const id = new URLSearchParams(window.location.search).get("share-target");
  if (id === null) return;

  whenSignedInWithWriteAccess(() => {
    void claimFiles(id).then((files) => {
      if (files.length > 0) {
        startBatch(files, { destinationCollectionId: null, source: "share-target" });
      }
      // Only now: the entry is consumed, so the parameter would be a lie about what this URL still does.
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    });
  });
}
