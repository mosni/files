// E5 Wave G (D-133): the first service worker in this repo. Its ONLY job is to intercept a synthetic
// `/__archive/<id>/<name>.zip` request and respond with a streamed zip built from the manifest the page
// posted it - the StreamSaver pattern, so the browser's own downloader writes to disk with no memory
// ceiling (a Blob-based archive would OOM the tab on exactly the multi-GB collections this app exists to
// share). No caching, no offline behaviour, no precache manifest - E6 extends this same worker for the PWA
// share target later; a caching worker that ships early is a debugging problem for every later session, so
// this one MUST stay minimal and additive. Every request outside the archive path is left completely
// untouched (no `respondWith` call at all), so the rest of the site behaves exactly as if this worker did
// not exist.
//
// No ambient "webworker" lib: this project's one tsconfig (tsconfig.json) already includes "dom" for every
// other file, and the two libs' global `self` declarations collide if both are in scope for the same
// program. So this file declares just the handful of service-worker-only shapes it actually uses, locally,
// rather than pulling in the whole webworker lib.

import { ZipWriterStream } from "@zip.js/zip.js";

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}

interface MessageSource {
  postMessage(message: unknown): void;
}

interface MessageEventLike extends ExtendableEvent {
  readonly data: unknown;
  readonly source: MessageSource | null;
}

interface ServiceWorkerScope extends EventTarget {
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
}

const scope = self as unknown as ServiceWorkerScope;

export type ArchiveFile = { name: string; url: string };
type PendingArchive = { name: string; files: ArchiveFile[]; source: MessageSource | null };

const ARCHIVE_PREFIX = "/__archive/";
// A transient network hiccup fetching one file must not sink the whole archive (G2) - a few attempts
// before the file is skipped, never an unbounded retry loop.
const MAX_FETCH_ATTEMPTS = 3;

const pendingArchives = new Map<string, PendingArchive>();

function isManifestMessage(
  data: unknown,
): data is { type: "archive-manifest"; id: string; name: string; files: ArchiveFile[] } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "archive-manifest" &&
    typeof (data as { id?: unknown }).id === "string"
  );
}

scope.addEventListener("install", () => {
  // Take over immediately rather than waiting for every open tab to close - this worker has no cached
  // state to be careful about migrating.
  void scope.skipWaiting();
});

scope.addEventListener("activate", (event) => {
  (event as ExtendableEvent).waitUntil(scope.clients.claim());
});

scope.addEventListener("message", (event) => {
  const messageEvent = event as MessageEventLike;
  const data = messageEvent.data;
  if (!isManifestMessage(data)) return;
  pendingArchives.set(data.id, { name: data.name, files: data.files, source: messageEvent.source });
});

async function fetchWithRetries(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok && response.body !== null) return response;
    } catch {
      // network hiccup - fall through and retry
    }
  }
  return null;
}

function reportProgress(
  source: MessageSource | null,
  id: string,
  completed: number,
  total: number,
  failed: string[],
): void {
  source?.postMessage({ type: "archive-progress", id, completed, total, failed });
}

// Returns the response immediately with `zipStream.readable` as its body, while a background task keeps
// writing entries into it - the client starts receiving (and its browser starts writing to disk) bytes for
// the first file well before the last one has even been requested.
function buildArchiveResponse(id: string, archive: PendingArchive): Response {
  // D-21/D-134: level 0 is store mode - media is already compressed, and this box has no CPU to spare on
  // deflate (D-78). No web workers either - there is nothing CPU-heavy here for one to usefully offload.
  const zipStream = new ZipWriterStream({ level: 0, useWebWorkers: false });
  const total = archive.files.length;
  const failed: string[] = [];

  void (async () => {
    let completed = 0;
    for (const file of archive.files) {
      const response = await fetchWithRetries(file.url);
      if (response === null || response.body === null) {
        // G2: skip this one file rather than aborting the whole archive - the rest still downloads.
        failed.push(file.name);
      } else {
        await response.body.pipeTo(zipStream.writable(file.name));
      }
      completed++;
      reportProgress(archive.source, id, completed, total, failed);
    }
    await zipStream.close();
  })();

  return new Response(zipStream.readable, {
    headers: {
      "Content-Type": "application/zip",
      // The suggested filename only - never trusted for anything security-relevant. Quotes are the one
      // thing that would break the header's own quoted-string syntax.
      "Content-Disposition": `attachment; filename="${archive.name.replace(/"/g, "'")}.zip"`,
    },
  });
}

scope.addEventListener("fetch", (event) => {
  const fetchEvent = event as FetchEvent;
  const url = new URL(fetchEvent.request.url);
  if (!url.pathname.startsWith(ARCHIVE_PREFIX)) return; // not ours - let the browser handle it normally

  const id = url.pathname.slice(ARCHIVE_PREFIX.length).split("/")[0];
  const archive = pendingArchives.get(id);
  if (archive === undefined) return; // unknown or already-consumed id - falls through to a normal 404

  pendingArchives.delete(id);
  fetchEvent.respondWith(buildArchiveResponse(id, archive));
});
