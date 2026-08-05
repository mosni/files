// E5.1 Wave E (findings 4 + 12, D-161): a single shared job stack for uploads AND archives, rendered once
// (main.tsx's <UploadStack />) instead of living inside DropZone (uploads) with a second, separate
// progress readout inside FileBrowser's toolbar (archives). A minimal module-level store, not a new
// dependency (React's own useSyncExternalStore) - working-conventions.md §6 vetting applies to anything
// beyond that, and nothing here needs it.
//
// Two independent pieces of state live here, because they answer different questions and have different
// readers:
//   - the JOB LIST itself (what the floating stack renders)
//   - the RELOAD SIGNAL (a plain counter DropZone bumps on every completed upload) - FileBrowser subscribes
//     to it so a completed upload refreshes the listing beneath it, on BOTH the landing page (finding 4,
//     previously never wired at all) and a collection page (previously wired through a one-off
//     onUploadComplete prop, now the SAME path rather than a second one - see FileBrowser.tsx's header
//     comment on its collection-route DropZone mount).

import { useSyncExternalStore } from "react";

// Kept nested (state: UploadState) rather than flattened, deliberately: this is a GENERALISATION of the
// upload variant, not a rewrite of upload progress, which already works and is D-122's shipped behaviour -
// DropZone.tsx's onProgress/onSuccess/onError callbacks construct exactly this shape today.
export type UploadState =
  | { status: "uploading"; progress: number; loaded: number; total: number }
  | { status: "done"; previewUrl: string; directUrl?: string }
  | { status: "error"; message: string };

export type FileUpload = { id: string; name: string; state: UploadState };
export type UploadJob = FileUpload & { kind: "upload" };

// Flat, not a discriminated union per status - unlike the upload variant, every archive status shares the
// same fields (completed/total/failed are meaningful even mid-archive, and `failed` is what the stack item
// shows once done).
export type ArchiveJob = {
  id: string;
  kind: "archive";
  name: string;
  status: "archiving" | "done" | "error";
  completed: number;
  total: number;
  failed: string[];
};

export type Job = UploadJob | ArchiveJob;

type Listener = () => void;

let jobs: Job[] = [];
const jobListeners = new Set<Listener>();

function emitJobs(): void {
  jobListeners.forEach((listener) => listener());
}

export function subscribeJobs(listener: Listener): () => void {
  jobListeners.add(listener);
  return () => jobListeners.delete(listener);
}

export function getJobsSnapshot(): Job[] {
  return jobs;
}

// Insert-or-replace by id - every caller (DropZone's upload callbacks, FileBrowser's archive walk) already
// has the job's full next state, so there is no partial-patch case to support.
export function upsertJob(job: Job): void {
  const index = jobs.findIndex((existing) => existing.id === job.id);
  jobs = index === -1 ? [...jobs, job] : jobs.map((existing, i) => (i === index ? job : existing));
  emitJobs();
}

export function dismissJob(id: string): void {
  jobs = jobs.filter((job) => job.id !== id);
  emitJobs();
}

let reloadCounter = 0;
const reloadListeners = new Set<Listener>();

function emitReload(): void {
  reloadListeners.forEach((listener) => listener());
}

export function subscribeReload(listener: Listener): () => void {
  reloadListeners.add(listener);
  return () => reloadListeners.delete(listener);
}

export function getReloadSnapshot(): number {
  return reloadCounter;
}

// Called once per completed upload (DropZone), regardless of whether it is mounted at the root or compact
// on a collection page - any mounted FileBrowser reacts the same way, via the SAME signal (see this file's
// header comment).
export function bumpReload(): void {
  reloadCounter++;
  emitReload();
}

// Test-only. Module state is a singleton for the lifetime of the JS module, so a test file that mounts more
// than one component reading this store must reset it between cases or a job/reload-count from an earlier
// test leaks into the next one's assertions.
export function __resetJobsStoreForTests(): void {
  jobs = [];
  reloadCounter = 0;
}

export function useJobs(): Job[] {
  return useSyncExternalStore(subscribeJobs, getJobsSnapshot);
}

export function useReloadSignal(): number {
  return useSyncExternalStore(subscribeReload, getReloadSnapshot);
}
