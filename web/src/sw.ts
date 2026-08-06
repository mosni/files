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

// E6 Wave G5 (D-133 stays unchanged: additive only, still no caching): the Android share-target handoff.
// A file shared to the installed PWA arrives here as a POST /share-target - it is persisted to a
// single-purpose IndexedDB store under a fresh id, deleted the moment the page claims it (or after
// SHARE_TARGET_TTL_MS, whichever first), and NEVER stored as a Response. This is a transient hand-off, not
// a cache - do not read this as license to grow one.
function isShareTargetClaimMessage(data: unknown): data is { type: "share-target-claim"; id: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === "share-target-claim" &&
    typeof (data as { id?: unknown }).id === "string"
  );
}

const SHARE_TARGET_DB = "files-share-target";
const SHARE_TARGET_STORE = "pending";
// 30 minutes, not the 5 the plan first specified (raised 2026-08-06). A shared file now waits in here
// until someone who can upload is present - and on a cold PWA start that can mean a full sign-in
// round-trip (a top-level redirect to auth.mosni.dev and back), which a 5-minute sweep can easily outlive.
// Still a transient hand-off, still deleted on read: D-133's "minimal and additive" is untouched.
const SHARE_TARGET_TTL_MS = 30 * 60 * 1000;

type ShareTargetEntry = { id: string; files: File[]; storedAt: number };

function openShareTargetDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_TARGET_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(SHARE_TARGET_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeShareTargetFiles(entry: ShareTargetEntry): Promise<void> {
  const db = await openShareTargetDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SHARE_TARGET_STORE, "readwrite");
      tx.objectStore(SHARE_TARGET_STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// Reads and deletes in the SAME transaction - a second claim (a reload of the same "?share-target=<id>"
// URL, say) finds nothing rather than the files a second time.
async function claimShareTargetFiles(id: string): Promise<File[]> {
  const db = await openShareTargetDb();
  try {
    return await new Promise<File[]>((resolve, reject) => {
      const tx = db.transaction(SHARE_TARGET_STORE, "readwrite");
      const store = tx.objectStore(SHARE_TARGET_STORE);
      const getRequest = store.get(id);
      getRequest.onsuccess = () => {
        const entry = getRequest.result as ShareTargetEntry | undefined;
        if (entry === undefined) {
          resolve([]);
          return;
        }
        store.delete(id);
        resolve(entry.files);
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  } finally {
    db.close();
  }
}

// Best-effort, never awaited by a caller that needs to move on - drops any entry nobody ever claimed
// (the share sheet was opened but the page was never reached, a stale/duplicate id, etc).
async function sweepExpiredShareTargets(): Promise<void> {
  const db = await openShareTargetDb();
  try {
    const cutoff = Date.now() - SHARE_TARGET_TTL_MS;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SHARE_TARGET_STORE, "readwrite");
      const store = tx.objectStore(SHARE_TARGET_STORE);
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if ((cursor.value as ShareTargetEntry).storedAt < cutoff) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function handleShareTarget(request: Request): Promise<Response> {
  const formData = await request.formData();
  const files = formData.getAll("files").filter((entry): entry is File => entry instanceof File);
  const id = crypto.randomUUID();
  if (files.length > 0) {
    await storeShareTargetFiles({ id, files, storedAt: Date.now() });
  }
  void sweepExpiredShareTargets(); // never blocks the redirect
  // Absolute, built from the REQUEST's own origin rather than a bare relative path - Response.redirect()
  // resolves a relative URL against the worker's scope in a real browser, but that resolution is
  // environment-specific (Node's undici, which the Vitest/jsdom test environment's global fetch actually
  // uses, requires an absolute URL outright) - anchoring explicitly is correct in both.
  return Response.redirect(new URL(`/?share-target=${id}`, request.url).toString(), 303);
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
  if (isManifestMessage(data)) {
    pendingArchives.set(data.id, { name: data.name, files: data.files, source: messageEvent.source });
    return;
  }
  if (isShareTargetClaimMessage(data)) {
    const source = messageEvent.source;
    void claimShareTargetFiles(data.id).then((files) => {
      source?.postMessage({ type: "share-target-files", id: data.id, files });
    });
  }
});

// Only a transient failure is worth another attempt. A 404/403 is the server's settled answer (most often
// a row the viewer may not see, or one deleted since the listing was fetched) - retrying it twice more
// just delays the archive. 429 IS retryable, and matters here: dl. delivery sits behind the app's global
// 100/min per-IP limiter (server.ts), which an archive of a large collection can genuinely trip.
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetries(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      // Exponential backoff. The original tight loop burned all three attempts within a few milliseconds,
      // which against a rate limiter guaranteed every one of them failed.
      await delay(2 ** (attempt - 1) * 500);
    }
    try {
      const response = await fetch(url);
      if (response.ok && response.body !== null) return response;
      if (!isRetryableStatus(response.status)) return null;
    } catch {
      // network hiccup - fall through and retry
    }
  }
  return null;
}

// ⚠ zip.js's ZipWriterStream cannot survive an ABORTED entry, and `pipeTo` aborts its destination by
// default the moment the source errors. Verified directly against the library (review session 034): after
// one aborted entry, `zipStream.close()` rejects AND `zipStream.readable` never ends - neither closed nor
// errored - so the browser's download sits at "in progress" forever. That is why this pumps the body by
// hand instead of using pipeTo, and ALWAYS closes the entry cleanly even when the source dies mid-file.
// A truncated entry (reported to the page as failed) is a far better outcome than a hung download.
// Returns false when the body did not arrive in full.
async function writeEntry(body: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>): Promise<boolean> {
  const writer = writable.getWriter();
  const reader = body.getReader();
  let complete = true;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
    }
  } catch {
    // The fetch succeeded and the body then failed part-way through (dropped connection mid-file).
    complete = false;
  }
  // Never abort - see above. A close() that throws must not escape either, or it becomes the same hang.
  await writer.close().catch(() => {});
  return complete;
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
    try {
      for (const file of archive.files) {
        const response = await fetchWithRetries(file.url);
        if (response === null || response.body === null) {
          // G2: skip this one file rather than aborting the whole archive - the rest still downloads.
          failed.push(file.name);
        } else if (!(await writeEntry(response.body, zipStream.writable(file.name)))) {
          // Arrived only partially - the entry is in the zip but truncated, so it is still reported as a
          // file that could not be included properly.
          failed.push(file.name);
        }
        completed++;
        reportProgress(archive.source, id, completed, total, failed);
      }
    } finally {
      // ALWAYS close, on every path. An unterminated zip stream is a download that hangs rather than one
      // that ends - strictly worse than a short archive. close() itself can throw when an entry was left
      // broken by a mid-stream failure above, and that must not resurface as an unhandled rejection.
      await zipStream.close().catch(() => {});
    }
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

  // E6 Wave G5: the share-target handoff, additive next to the archive path above - neither branch's
  // respondWith touches the other's requests.
  if (fetchEvent.request.method === "POST" && url.pathname === "/share-target") {
    fetchEvent.respondWith(handleShareTarget(fetchEvent.request));
    return;
  }

  if (!url.pathname.startsWith(ARCHIVE_PREFIX)) return; // not ours - let the browser handle it normally

  const id = url.pathname.slice(ARCHIVE_PREFIX.length).split("/")[0];
  const archive = pendingArchives.get(id);
  if (archive === undefined) return; // unknown or already-consumed id - falls through to a normal 404

  pendingArchives.delete(id);
  fetchEvent.respondWith(buildArchiveResponse(id, archive));
});
