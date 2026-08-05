// E6 (D-171, Waves 0/B/C): the upload controller, extracted out of DropZone.tsx. All tus orchestration
// lives here now - DropZone (and, from Wave D/E/F, clipboard/folder/whole-page ingest) only collects files
// and calls startBatch(); this module owns the queue, the live tus.Upload instances, resumption, and
// publishing into jobs.ts. This is what makes the concurrency queue and resumption unit-testable at all -
// none of it is reachable with this logic living inside a component that needs a real drag event.
//
// See planning-artifacts/e6-ingest-breadth-implementation-waves.md §1.2/§0.5 for the full contract and the
// tus-js-client facts this relies on.

import * as tus from "tus-js-client";
import {
  UPLOAD_CHUNK_SIZE,
  UPLOAD_MAX_CONCURRENT,
  UPLOAD_RETRY_DELAYS,
} from "../../../app/src/lib/uploadConfig.ts";
import { bumpReload, getJobsSnapshot, upsertJob, type UploadState } from "./jobs.ts";

export type IngestSource = "drop" | "picker" | "paste" | "share-target" | "folder";

export type BatchOptions = {
  destinationCollectionId: string | null;
  source: IngestSource;
};

const TUS_ENDPOINT = "/api/upload";

let nextUploadId = 0;
let nextBatchId = 0;
let chunkSize = UPLOAD_CHUNK_SIZE;

// Every job this module currently knows about, keyed by jobId - the bookkeeping jobs.ts itself does not
// need (the live tus.Upload instance, the File to resume with, which batch/destination it belongs to).
// `file` is absent for a `paused` job restored from localStorage on mount (§0.5: the page lost the File
// on unload) until the viewer re-offers it.
type JobRecord = {
  name: string;
  batchId: string;
  destinationCollectionId: string | null;
  file: File | null;
  fingerprint: string;
  uploadUrl: string | null; // the tus resource URL, once known - lets resumeUpload pick the right entry
  urlStorageKey: string | null; // the localStorage key backing a restored `paused` job, so it can be pruned
};

const jobRecords = new Map<string, JobRecord>();
const liveUploads = new Map<string, tus.Upload>();

// C1: at most UPLOAD_MAX_CONCURRENT tus.Upload instances run at once; the rest wait here as `queued` job
// ids. A `paused`/`error` job awaiting a manual Resume does NOT hold a slot or sit in this queue - it only
// re-enters via resumeUpload().
const pendingQueue: string[] = [];
let activeCount = 0;

// Test-only override so a unit test can drive the chunk size without going through /api/config.
export function setUploadChunkSize(size: number): void {
  chunkSize = size;
}

function authHeader(): string {
  const token = typeof window.mosni !== "undefined" ? window.mosni.token() : null;
  return `Bearer ${token ?? ""}`;
}

function publish(jobId: string, state: UploadState): void {
  const record = jobRecords.get(jobId);
  if (record === undefined) return; // defensive - every publish call follows a record being created first
  upsertJob({
    id: jobId,
    kind: "upload",
    name: record.name,
    batchId: record.batchId,
    collectionId: record.destinationCollectionId,
    state,
  });
}

// §0.5/B1: mirrors tus-js-client's own `defaultOnShouldRetry`
// (originalResponse ? status : 0, retry unless a settled 4xx other than 409/423), then widens it - the
// default additionally refuses to retry while `navigator.onLine` is false, which is exactly the case
// D-173's ~2-minute backoff exists to survive. A bare network error (no response at all, status 0) always
// keeps retrying here regardless of the browser's online flag.
function onShouldRetry(error: tus.DetailedError): boolean {
  const status = error.originalResponse ? error.originalResponse.getStatus() : 0;
  if (status === 0) return true; // no response reached us at all - keep retrying
  if (status === 409 || status === 423) return true;
  return status < 400 || status >= 500;
}

// §0.5/B6: mirrors tus-js-client's `lib/browser/fileSignature.js` exactly (the default `fingerprint`
// option), so a `findPreviousUploads()` call against a freshly-constructed Upload for the same File
// resolves the same localStorage entries this module reads directly in restorePausedUploads(). If this
// ever drifts from the library's own formula, resumption silently degrades to a fresh re-upload instead of
// continuing - see uploads.test.ts's fixed-string assertion.
function computeFingerprint(file: File): string {
  return ["tus-br", file.name, file.type, file.size, file.lastModified, TUS_ENDPOINT].join("-");
}

function buildUploadOptions(
  file: File,
  jobId: string,
  destinationCollectionId: string | null,
  callbacks: {
    onProgress: (bytesSent: number, bytesTotal: number) => void;
    onSuccess: (payload: { lastResponse: { getBody(): string } }) => void;
    onError: (error: tus.DetailedError | Error) => void;
  },
): tus.Upload {
  return new tus.Upload(file, {
    endpoint: TUS_ENDPOINT,
    chunkSize,
    metadata: {
      filename: file.name,
      ...(destinationCollectionId ? { destinationCollectionId } : {}),
    },
    retryDelays: [...UPLOAD_RETRY_DELAYS],
    onShouldRetry,
    // B1: a completed upload's localStorage fingerprint entry is removed - without this every finished
    // upload leaks a `tus::` entry forever (§0.5's "purely a slow localStorage leak" finding).
    removeFingerprintOnSuccess: true,
    // §1.2: the token is read PER REQUEST here, not baked into a static `headers` option at construction -
    // a resumed upload can outlive the token that was current when it started, so every create/PATCH reads
    // window.mosni.token() at send time. Load-bearing for resumption: without this, a resume after a token
    // expiry 401s.
    onBeforeRequest: (req) => {
      req.setHeader("Authorization", authHeader());
    },
    onProgress: callbacks.onProgress,
    onSuccess: callbacks.onSuccess,
    onError: callbacks.onError,
  });
}

function onUploadSettledFreeSlot(): void {
  activeCount = Math.max(0, activeCount - 1);
  runQueue();
}

function beginUpload(jobId: string): void {
  const record = jobRecords.get(jobId);
  if (record === undefined || record.file === null) return;
  const file = record.file;

  publish(jobId, { status: "uploading", progress: 0, loaded: 0, total: file.size });

  const upload = buildUploadOptions(file, jobId, record.destinationCollectionId, {
    onProgress: (bytesSent, bytesTotal) => {
      publish(jobId, { status: "uploading", progress: Math.round((bytesSent / bytesTotal) * 100), loaded: bytesSent, total: bytesTotal });
    },
    onSuccess: (payload) => {
      liveUploads.delete(jobId);
      try {
        const { previewUrl, directUrl, id: fileId } = JSON.parse(payload.lastResponse.getBody()) as {
          previewUrl: string;
          directUrl?: string;
          id: string;
        };
        publish(jobId, { status: "done", previewUrl, directUrl, fileId });
        bumpReload();
      } catch {
        publish(jobId, {
          status: "error",
          message: "upload finished but the server response was unreadable",
          resumable: false,
        });
      }
      onUploadSettledFreeSlot();
    },
    onError: (error) => {
      liveUploads.delete(jobId);
      // Once tus's own onUrlKnown fires, upload.url holds the resource URL - remember it so a later manual
      // Resume (B3) can pick the matching findPreviousUploads() entry rather than guessing the first one.
      const rec = jobRecords.get(jobId);
      if (rec !== undefined) rec.uploadUrl = upload.url ?? rec.uploadUrl;
      publish(jobId, {
        status: "error",
        message: error.message,
        // Resumable exactly when tus knows a resource URL to continue from - a failure before the create
        // request ever completed (e.g. offline before create) has nothing to resume.
        resumable: upload.url !== null,
      });
      onUploadSettledFreeSlot();
    },
  });

  liveUploads.set(jobId, upload);
  activeCount++;
  upload.start();
}

function runQueue(): void {
  while (activeCount < UPLOAD_MAX_CONCURRENT && pendingQueue.length > 0) {
    const jobId = pendingQueue.shift()!;
    beginUpload(jobId);
  }
}

// B2: one window-level `online` listener for the whole module (not per upload) - resumes every job
// currently sitting in a resumable `error` state, and only those - a `paused` job still needs its File
// re-offered by hand (B8), and an already-`uploading`/`queued`/`done` job must be left alone.
function handleOnline(): void {
  for (const job of getJobsSnapshot()) {
    if (job.kind === "upload" && job.state.status === "error" && job.state.resumable) {
      resumeUpload(job.id);
    }
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", handleOnline);
}

/** Accepts files, assigns one batchId, queues them, returns the batchId. */
export function startBatch(files: File[], options: BatchOptions): string {
  const batchId = `batch-${nextBatchId++}`;

  for (const file of files) {
    // B7: a re-offered file resumes its paused job instead of creating a second one - this must run BEFORE
    // a new job is created, or the same file dropped twice (once to pause it, once to continue it) would
    // silently start uploading from zero alongside the paused entry.
    const pausedJobId = matchPausedJob(file);
    if (pausedJobId !== null) {
      resumeUpload(pausedJobId, file);
      continue;
    }

    const jobId = `upload-${nextUploadId++}`;
    jobRecords.set(jobId, {
      name: file.name,
      batchId,
      destinationCollectionId: options.destinationCollectionId,
      file,
      fingerprint: computeFingerprint(file),
      uploadUrl: null,
      urlStorageKey: null,
    });
    publish(jobId, { status: "queued" });
    pendingQueue.push(jobId);
  }

  runQueue();
  return batchId;
}

/** Continue an upload that failed or was restored as `paused`. `file` is required for a `paused` job (the
 *  page lost the File on unload) and ignored for a live `error` job - the module already holds that one. */
export function resumeUpload(jobId: string, file?: File): void {
  void resumeUploadAsync(jobId, file);
}

async function resumeUploadAsync(jobId: string, file?: File): Promise<void> {
  const record = jobRecords.get(jobId);
  if (record === undefined) return;
  const resumeFile = record.file ?? file;
  if (resumeFile === undefined || resumeFile === null) return; // nothing to resume with yet

  if (record.file === null) record.file = resumeFile;

  publish(jobId, { status: "uploading", progress: 0, loaded: 0, total: resumeFile.size });

  const upload = buildUploadOptions(resumeFile, jobId, record.destinationCollectionId, {
    onProgress: (bytesSent, bytesTotal) => {
      publish(jobId, { status: "uploading", progress: Math.round((bytesSent / bytesTotal) * 100), loaded: bytesSent, total: bytesTotal });
    },
    onSuccess: (payload) => {
      liveUploads.delete(jobId);
      if (record.urlStorageKey !== null) window.localStorage.removeItem(record.urlStorageKey);
      try {
        const { previewUrl, directUrl, id: fileId } = JSON.parse(payload.lastResponse.getBody()) as {
          previewUrl: string;
          directUrl?: string;
          id: string;
        };
        publish(jobId, { status: "done", previewUrl, directUrl, fileId });
        bumpReload();
      } catch {
        publish(jobId, {
          status: "error",
          message: "upload finished but the server response was unreadable",
          resumable: false,
        });
      }
    },
    onError: (error) => {
      liveUploads.delete(jobId);
      record.uploadUrl = upload.url ?? record.uploadUrl;
      publish(jobId, { status: "error", message: error.message, resumable: upload.url !== null });
    },
  });

  // §0.3/B3: never construct a new upload without this step - it is the difference between resuming and
  // silently re-uploading from zero, which is exactly what D-173's naming exists to make impossible.
  const previous = await upload.findPreviousUploads();
  const match = previous.find((p) => p.uploadUrl !== null && p.uploadUrl === record.uploadUrl) ?? previous[0];
  if (match !== undefined) upload.resumeFromPreviousUpload(match);

  liveUploads.set(jobId, upload);
  upload.start();
}

/** Abort, terminate server-side where possible, and drop the stored fingerprint. */
export async function cancelUpload(jobId: string): Promise<void> {
  const live = liveUploads.get(jobId);
  if (live !== undefined) {
    await live.abort(true).catch(() => {});
    liveUploads.delete(jobId);
  }
  const record = jobRecords.get(jobId);
  if (record?.urlStorageKey !== null && record?.urlStorageKey !== undefined) {
    window.localStorage.removeItem(record.urlStorageKey);
  }
  const queueIndex = pendingQueue.indexOf(jobId);
  if (queueIndex !== -1) pendingQueue.splice(queueIndex, 1);
}

// B4: read tus's own localStorage entries directly - `WebStorageUrlStorage` (the class that writes them)
// is not part of tus-js-client's public API, and constructing a throwaway tus.Upload per stored fingerprint
// to read them back is not possible either (the API needs a real File, which is exactly what a `paused`
// entry does not have yet). The key/value shape is verified against the library's own
// lib.esm/browser/urlStorage.js: `tus::<fingerprint>::<random>` -> `{size, metadata, creationTime,
// uploadUrl}`.
const TUS_STORAGE_PREFIX = "tus::";

type StoredTusUpload = { size?: number; metadata?: { filename?: string }; uploadUrl?: string | null };

function parseStoredUpload(raw: string | null): StoredTusUpload | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as StoredTusUpload) : null;
  } catch {
    return null;
  }
}

function fingerprintFromKey(key: string): string {
  // "tus::<fingerprint>::<random>" - the fingerprint itself is '-'-joined (§0.5), so the LAST "::" is
  // always the separator before the trailing random id, never part of the fingerprint.
  const withoutPrefix = key.slice(TUS_STORAGE_PREFIX.length);
  const lastSeparator = withoutPrefix.lastIndexOf("::");
  return lastSeparator === -1 ? withoutPrefix : withoutPrefix.slice(0, lastSeparator);
}

/** Read tus's stored fingerprints and publish any still-resumable upload as a `paused` job. Called once
 *  from main.tsx on mount. Prunes entries the server no longer knows (404/410). */
export async function restorePausedUploads(): Promise<void> {
  // §0.5: this must never throw into main.tsx's render path - a malformed entry, a storage access error
  // (private-mode Safari, a sandboxed iframe) or a network failure must all degrade to "nothing restored".
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key !== null && key.startsWith(TUS_STORAGE_PREFIX)) keys.push(key);
    }

    await Promise.all(
      keys.map(async (key) => {
        const stored = parseStoredUpload(window.localStorage.getItem(key));
        if (stored === null || typeof stored.uploadUrl !== "string" || stored.uploadUrl.length === 0) return;

        let response: Response;
        try {
          response = await fetch(stored.uploadUrl, {
            method: "HEAD",
            headers: { Authorization: authHeader(), "Tus-Resumable": "1.0.0" },
          });
        } catch {
          return; // network error - leave the entry alone, try again next load
        }

        if (response.status === 403 || response.status === 404 || response.status === 410) {
          window.localStorage.removeItem(key);
          return;
        }
        if (!response.ok) return; // any other failure - leave it alone rather than guessing

        const offsetHeader = response.headers.get("Upload-Offset");
        const loaded = offsetHeader !== null ? Number(offsetHeader) : 0;
        const total = typeof stored.size === "number" ? stored.size : loaded;

        const jobId = `upload-${nextUploadId++}`;
        jobRecords.set(jobId, {
          name: stored.metadata?.filename ?? "file",
          batchId: `batch-${nextBatchId++}`,
          destinationCollectionId: null,
          file: null,
          fingerprint: fingerprintFromKey(key),
          uploadUrl: stored.uploadUrl ?? null,
          urlStorageKey: key,
        });
        publish(jobId, { status: "paused", loaded: Number.isFinite(loaded) ? loaded : 0, total });
      }),
    );
  } catch {
    // Never let a restore failure break the app's first render.
  }
}

/** Match a re-offered File against the paused jobs; returns the jobId it resumes, or null. */
export function matchPausedJob(file: File): string | null {
  const fingerprint = computeFingerprint(file);
  for (const [jobId, record] of jobRecords) {
    if (record.fingerprint === fingerprint && record.file === null && record.urlStorageKey !== null) {
      return jobId;
    }
  }
  return null;
}

/** Test-only: clear the queue, abort live uploads, reset module state. */
export function __resetUploadsForTests(): void {
  if (typeof window !== "undefined") window.removeEventListener("online", handleOnline);
  liveUploads.forEach((upload) => upload.abort().catch(() => {}));
  liveUploads.clear();
  jobRecords.clear();
  pendingQueue.length = 0;
  activeCount = 0;
  nextUploadId = 0;
  nextBatchId = 0;
  chunkSize = UPLOAD_CHUNK_SIZE;
  if (typeof window !== "undefined") window.addEventListener("online", handleOnline);
}
